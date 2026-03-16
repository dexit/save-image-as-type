// popup.js
// 🛡️ Hardened with: extension context guard, try/catch on all chrome.* calls,
//    chrome.runtime.lastError checks, graceful UI degradation on failure.

// ── 🛡️ Strategy: Error logging ───────────────────────────────────────────────

const log = {
  info:  (...a) => console.log  ('[SIAT:popup]', ...a),
  warn:  (...a) => console.warn ('[SIAT:popup]', ...a),
  error: (...a) => console.error('[SIAT:popup]', ...a),
};

// ── 🛡️ Strategy: Check extension context before every chrome.* call ──────────

function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

// Safe wrapper for chrome storage calls
async function safeGet(area, keys, defaults) {
  if (!isExtensionAlive()) {
    log.warn('[safeGet] Extension context invalid');
    return defaults;
  }
  try {
    const result = await chrome[area].get(keys);
    if (chrome.runtime.lastError) {
      log.warn('[safeGet] lastError:', chrome.runtime.lastError.message);
      return defaults;
    }
    return { ...defaults, ...result };
  } catch (err) {
    log.warn('[safeGet] threw:', err.message, '— using defaults');
    return defaults;
  }
}

async function safeSet(area, data) {
  if (!isExtensionAlive()) { log.warn('[safeSet] Extension context invalid'); return; }
  try {
    await chrome[area].set(data);
    if (chrome.runtime.lastError) log.warn('[safeSet] lastError:', chrome.runtime.lastError.message);
  } catch (err) {
    log.warn('[safeSet] threw:', err.message);
  }
}

// ── Format descriptions ───────────────────────────────────────────────────────

const FORMAT_DESCRIPTIONS = {
  png:  'Lossless compression — every pixel is preserved exactly. Supports full transparency (alpha channel). The go-to format for screenshots, logos, and anything that needs crisp edges.',
  jpg:  'Lossy compression that discards detail to shrink file size. No transparency support. Best for photos and images where slight quality loss is acceptable.',
  webp: 'Google\'s modern format. Better compression than both PNG and JPG at equivalent quality. Supports transparency and animation. Excellent for web images.',
  avif: 'The newest format — even better compression than WebP. Growing browser support makes it increasingly practical. Ideal for high-quality images at small sizes.',
  svg:  'A vector format — scales to any size without losing quality. This saves a PNG snapshot embedded inside SVG. Perfect for logos, icons, and illustrations.',
  gif:  'Supports simple animations and transparency, but limited to 256 colors. Saves a static frame. Best for short animated clips or simple graphics.',
  pdf:  'Embeds the image inside a standard PDF document at its native dimensions. Ready for printing or sharing as a document file.',
  tiff: 'Uncompressed, full-quality format used in print, archiving, and professional editing. Preserves every pixel without loss. Files are very large — not for web use.',
  bmp:  'Raw uncompressed bitmap format — the simplest possible image file. No encoding overhead. Used in legacy Windows workflows. Very large file size.',
};

const ALL_FORMATS = ['png','jpg','webp','avif','svg','gif','pdf','tiff','bmp'];

// ── DOMContentLoaded ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {

  // ── 🛡️ Strategy: Check extension context on popup open ───────────────────
  if (!isExtensionAlive()) {
    log.error('Extension context invalid on DOMContentLoaded — popup may be stale');
    showError('Extension needs to be reloaded. Please disable and re-enable it in chrome://extensions.');
    return;
  }

  // ── Load settings (with safe fallback defaults) ───────────────────────────

  const settings = await safeGet('storage.sync', 
    ['defaultFormat','showAllFormats','jpgQuality','webpQuality','avifQuality'],
    { defaultFormat:'png', showAllFormats:true, jpgQuality:92, webpQuality:90, avifQuality:80 }
  );
  const { defaultFormat, showAllFormats, jpgQuality, webpQuality, avifQuality } = settings;
  log.info('Settings loaded:', settings);

  // ── Load stats ────────────────────────────────────────────────────────────

  try {
    const statKeys = ['stat_total', ...ALL_FORMATS.map(f=>`stat_${f}`)];
    const stats    = await safeGet('storage.local', statKeys, {});

    document.querySelector('#stat-total .stat-num').textContent = stats.stat_total || 0;
    for (const f of ALL_FORMATS) {
      const el = document.querySelector(`#stat-${f} .stat-num`);
      if (el) el.textContent = stats[`stat_${f}`] || 0;
    }
    log.info('Stats loaded. Total conversions:', stats.stat_total || 0);
  } catch (err) {
    log.warn('Could not load stats:', err.message);
    // Non-fatal — stats display just shows zeroes
  }

  // ── Format buttons ────────────────────────────────────────────────────────

  const formatBtns = document.querySelectorAll('.format-btn');
  const fiText     = document.getElementById('fi-text');

  function setActiveFormat(fmt) {
    if (!ALL_FORMATS.includes(fmt)) {
      log.warn('[setActiveFormat] Unknown format:', fmt, '— defaulting to png');
      fmt = 'png';
    }
    formatBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.format === fmt));
    if (fiText) fiText.textContent = FORMAT_DESCRIPTIONS[fmt] || '';
    safeSet('storage.sync', { defaultFormat: fmt });
  }

  setActiveFormat(defaultFormat);

  formatBtns.forEach(btn => {
    btn.addEventListener('click', () => setActiveFormat(btn.dataset.format));
    btn.addEventListener('mouseenter', () => {
      if (fiText) fiText.textContent = FORMAT_DESCRIPTIONS[btn.dataset.format] || '';
    });
    btn.addEventListener('mouseleave', () => {
      const active = document.querySelector('.format-btn.active');
      if (fiText) fiText.textContent = FORMAT_DESCRIPTIONS[active?.dataset.format] || '';
    });
  });

  // ── Toggle ────────────────────────────────────────────────────────────────

  const showAllInput = document.getElementById('show-all-formats');
  if (showAllInput) {
    showAllInput.checked = showAllFormats;
    showAllInput.addEventListener('change', () => {
      safeSet('storage.sync', { showAllFormats: showAllInput.checked });
    });
  }

  // ── Quality sliders ───────────────────────────────────────────────────────

  initSlider('jpg-quality',  'jpg-val',  jpgQuality,  v => safeSet('storage.sync', { jpgQuality: v  }));
  initSlider('webp-quality', 'webp-val', webpQuality, v => safeSet('storage.sync', { webpQuality: v }));
  initSlider('avif-quality', 'avif-val', avifQuality, v => safeSet('storage.sync', { avifQuality: v }));

  log.info('Popup initialized');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function initSlider(sliderId, valId, initial, onChange) {
  // 🛡️ Strategy: try/catch — DOM element might not exist
  try {
    const slider = document.getElementById(sliderId);
    const valEl  = document.getElementById(valId);
    const fillEl = document.getElementById(sliderId.replace('quality','fill'));
    if (!slider || !valEl) { log.warn('[initSlider] Element not found:', sliderId); return; }

    function update(val) {
      valEl.textContent = `${val}%`;
      if (fillEl) {
        const pct = ((val - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
        fillEl.style.width = `${pct}%`;
      }
    }

    slider.value = initial;
    update(initial);
    slider.addEventListener('input', () => {
      update(Number(slider.value));
      onChange(Number(slider.value));
    });
  } catch (err) {
    log.warn('[initSlider] Failed to init', sliderId, ':', err.message);
  }
}

function showError(message) {
  // Graceful degradation: display an error banner in the popup
  try {
    const app = document.querySelector('.app');
    if (!app) return;
    const banner = document.createElement('div');
    banner.style.cssText = 'padding:12px 18px;background:#2d1515;border-bottom:1px solid #5a2020;color:#ff8080;font-size:12px;line-height:1.5;';
    banner.textContent = `⚠️ ${message}`;
    app.prepend(banner);
  } catch { /* If even this fails, stay silent */ }
}
