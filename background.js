// background.js — Service Worker
// 🛡️ Hardened with: chrome.runtime.lastError checks, extension context guard,
//    onInstalled re-init, try/catch on all chrome.* calls, structured error logging.

const FORMATS = [
  { id: 'png',  label: 'PNG'  },
  { id: 'jpg',  label: 'JPG'  },
  { id: 'webp', label: 'WebP' },
  { id: 'avif', label: 'AVIF' },
  { id: 'svg',  label: 'SVG'  },
  { id: 'gif',  label: 'GIF'  },
  { id: 'pdf',  label: 'PDF'  },
  { id: 'tiff', label: 'TIFF' },
  { id: 'bmp',  label: 'BMP'  },
];

// ── 🛡️ Strategy: Error logging — structured logger with context ───────────────

const log = {
  info:  (...a) => console.log  ('[SIAT]', ...a),
  warn:  (...a) => console.warn ('[SIAT]', ...a),
  error: (...a) => console.error('[SIAT]', ...a),
};

// ── 🛡️ Strategy: Check extension context before every chrome.* call ──────────

function isExtensionAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Safe wrapper: runs fn(), catches any thrown error AND checks runtime.lastError
async function safeCall(label, fn) {
  if (!isExtensionAlive()) {
    log.warn(`[${label}] Extension context invalid — skipping`);
    return null;
  }
  try {
    const result = await fn();
    // 🛡️ Strategy: chrome.runtime.lastError — poll after every chrome API call
    if (chrome.runtime.lastError) {
      log.warn(`[${label}] lastError:`, chrome.runtime.lastError.message);
      return null;
    }
    return result;
  } catch (err) {
    log.error(`[${label}] threw:`, err.message ?? err);
    return null;
  }
}

// ── Build context menus ───────────────────────────────────────────────────────

async function buildMenus() {
  // 🛡️ Strategy: try/catch around all chrome.* calls
  try {
    await chrome.contextMenus.removeAll();
    if (chrome.runtime.lastError) log.warn('[buildMenus] removeAll lastError:', chrome.runtime.lastError.message);
  } catch (err) {
    log.error('[buildMenus] removeAll failed:', err.message);
    return; // Can't safely build if removeAll failed
  }

  let defaultFormat = 'png', showAllFormats = true;
  try {
    ({ defaultFormat = 'png', showAllFormats = true } =
      await chrome.storage.sync.get(['defaultFormat', 'showAllFormats']));
    if (chrome.runtime.lastError) log.warn('[buildMenus] storage.get lastError:', chrome.runtime.lastError.message);
  } catch (err) {
    log.warn('[buildMenus] Could not read settings, using defaults:', err.message);
  }

  const createItem = (props) => {
    try {
      chrome.contextMenus.create(props, () => {
        // 🛡️ Strategy: lastError in the create callback
        if (chrome.runtime.lastError) {
          log.warn('[createItem] lastError:', chrome.runtime.lastError.message, '| id:', props.id);
        }
      });
    } catch (err) {
      log.error('[createItem] threw for id', props.id, ':', err.message);
    }
  };

  createItem({ id: 'save-image-as-type', title: 'Save Image as Type', contexts: ['image'] });

  if (showAllFormats) {
    for (const { id, label } of FORMATS) {
      createItem({ id: `save-as-${id}`, parentId: 'save-image-as-type', title: `Save as ${label}`, contexts: ['image'] });
    }
    createItem({ id: 'sep', parentId: 'save-image-as-type', type: 'separator', contexts: ['image'] });
    createItem({ id: 'save-as-default', parentId: 'save-image-as-type', title: `Save as Default (${defaultFormat.toUpperCase()})`, contexts: ['image'] });
  } else {
    createItem({ id: 'save-as-default', parentId: 'save-image-as-type', title: `Save as ${defaultFormat.toUpperCase()} (default)`, contexts: ['image'] });
  }

  log.info('Menus built. defaultFormat:', defaultFormat, '| showAll:', showAllFormats);
}

// ── 🛡️ Strategy: onInstalled re-initializes all state ────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  log.info('onInstalled reason:', details.reason);
  // Re-initialize regardless of install/update/reload — menus, defaults, etc.
  buildMenus().catch(err => log.error('[onInstalled] buildMenus failed:', err.message));

  if (details.reason === 'install') {
    // Set defaults on first install
    safeCall('setDefaults', () =>
      chrome.storage.sync.set({
        defaultFormat: 'png',
        showAllFormats: true,
        jpgQuality: 92,
        webpQuality: 90,
        avifQuality: 80,
      })
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  log.info('onStartup fired');
  buildMenus().catch(err => log.error('[onStartup] buildMenus failed:', err.message));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  log.info('Storage changed:', Object.keys(changes).join(', '));
  buildMenus().catch(err => log.error('[storage.onChanged] buildMenus failed:', err.message));
});

// ── Context menu click handler ────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // 🛡️ Strategy: Check extension context at the very start of every handler
  if (!isExtensionAlive()) { log.warn('[onClicked] Extension context invalid'); return; }
  if (!info.srcUrl)        { log.warn('[onClicked] No srcUrl in info');          return; }

  let settings = { defaultFormat: 'png', jpgQuality: 92, webpQuality: 90, avifQuality: 80 };
  try {
    const loaded = await chrome.storage.sync.get(['defaultFormat', 'jpgQuality', 'webpQuality', 'avifQuality']);
    if (chrome.runtime.lastError) log.warn('[onClicked] storage.get lastError:', chrome.runtime.lastError.message);
    else settings = { ...settings, ...loaded };
  } catch (err) {
    log.warn('[onClicked] Could not load settings, using defaults:', err.message);
  }

  const { defaultFormat, jpgQuality, webpQuality, avifQuality } = settings;

  let format;
  if (info.menuItemId === 'save-as-default') {
    format = defaultFormat;
  } else {
    const m = info.menuItemId.match(/^save-as-(.+)$/);
    if (!m) { log.warn('[onClicked] Unrecognized menuItemId:', info.menuItemId); return; }
    format = m[1];
  }

  const qualityMap = { jpg: jpgQuality / 100, webp: webpQuality / 100, avif: avifQuality / 100 };
  const quality = qualityMap[format] ?? 0.92;

  log.info(`Converting → format: ${format}, quality: ${quality}, url: ${info.srcUrl.slice(0, 80)}…`);

  try {
    await ensureOffscreen();
    const dataUrl  = await convertViaOffscreen(info.srcUrl, format, quality);
    const filename = buildFilename(info.srcUrl, format);

    await safeCall('downloads.download', () =>
      chrome.downloads.download({ url: dataUrl, filename, saveAs: false })
    );

    log.info(`Download triggered: ${filename}`);
    await incrementStats(format);

  } catch (err) {
    log.error('[onClicked] Conversion pipeline failed:', err.message);
    // Fallback: download the original image as-is
    log.warn('[onClicked] Falling back to original download');
    await safeCall('downloads.download[fallback]', () =>
      chrome.downloads.download({ url: info.srcUrl, saveAs: false })
    );
  }
});

// ── Offscreen document ────────────────────────────────────────────────────────

async function ensureOffscreen() {
  // 🛡️ Strategy: try/catch — hasDocument/createDocument can both throw
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Convert image format via Canvas API',
      });
      if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);
      log.info('Offscreen document created');
    }
  } catch (err) {
    log.error('[ensureOffscreen]', err.message);
    throw err; // Re-throw so the caller's try/catch handles it
  }
}

function convertViaOffscreen(srcUrl, format, quality) {
  return new Promise((resolve, reject) => {
    // 🛡️ Strategy: Check extension context before sending message
    if (!isExtensionAlive()) {
      reject(new Error('Extension context invalidated before offscreen conversion'));
      return;
    }

    const id      = Math.random().toString(36).slice(2);
    const TIMEOUT = 30_000; // 30 s safety net — large images on slow connections

    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Conversion timed out after 30s (format: ${format})`));
    }, TIMEOUT);

    const listener = (msg) => {
      if (msg?.type === 'conversion-result' && msg.id === id) {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        if (msg.error) reject(new Error(msg.error));
        else           resolve(msg.dataUrl);
      }
    };

    try {
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({ type: 'convert-image', id, srcUrl, format, quality }, () => {
        // 🛡️ Strategy: lastError after sendMessage
        if (chrome.runtime.lastError) {
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error(`sendMessage failed: ${chrome.runtime.lastError.message}`));
        }
      });
    } catch (err) {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      reject(err);
    }
  });
}

// ── Filename builder ──────────────────────────────────────────────────────────

function buildFilename(srcUrl, format) {
  const extMap = { jpg:'jpg', tiff:'tiff', bmp:'bmp', gif:'gif', avif:'avif', svg:'svg', pdf:'pdf', png:'png', webp:'webp' };
  try {
    const base = new URL(srcUrl).pathname.split('/').pop().replace(/\.[^.]+$/, '') || 'image';
    return `${base.replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,64)}.${extMap[format] ?? format}`;
  } catch {
    return `image_${Date.now()}.${format}`; // timestamped fallback
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function incrementStats(format) {
  // 🛡️ Stats errors should never surface to the user — fully silent
  await safeCall('incrementStats', async () => {
    const key  = `stat_${format}`;
    const data = await chrome.storage.local.get([key, 'stat_total']);
    if (chrome.runtime.lastError) return;
    await chrome.storage.local.set({
      [key]:       (data[key]       || 0) + 1,
      stat_total:  (data.stat_total || 0) + 1,
    });
  });
}
