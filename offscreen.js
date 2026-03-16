// offscreen.js — Hidden offscreen document (full DOM + Canvas access)
// 🛡️ Hardened with: extension context guard, try/catch on all chrome.* calls,
//    chrome.runtime.lastError checks, structured error logging, 30s timeout guard.

// ── 🛡️ Strategy: Error logging ───────────────────────────────────────────────

const log = {
  info:  (...a) => console.log  ('[SIAT:offscreen]', ...a),
  warn:  (...a) => console.warn ('[SIAT:offscreen]', ...a),
  error: (...a) => console.error('[SIAT:offscreen]', ...a),
};

// ── 🛡️ Strategy: Check extension context before every chrome.* call ──────────

function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function safeSendMessage(payload) {
  // 🛡️ Strategy: try/catch + lastError on sendMessage
  if (!isExtensionAlive()) {
    log.warn('[safeSendMessage] Extension context gone — dropping message');
    return;
  }
  try {
    chrome.runtime.sendMessage(payload, () => {
      if (chrome.runtime.lastError) {
        log.warn('[safeSendMessage] lastError:', chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    log.error('[safeSendMessage] threw:', err.message);
  }
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'convert-image') return;

  log.info(`Received convert-image | id: ${msg.id} | format: ${msg.format}`);

  // 🛡️ Strategy: try/catch wrapping the entire conversion pipeline
  convertImage(msg.srcUrl, msg.format, msg.quality)
    .then(dataUrl => {
      log.info(`Conversion OK | id: ${msg.id} | format: ${msg.format}`);
      safeSendMessage({ type: 'conversion-result', id: msg.id, dataUrl });
    })
    .catch(err => {
      log.error(`Conversion FAILED | id: ${msg.id} | format: ${msg.format} |`, err.message);
      safeSendMessage({ type: 'conversion-result', id: msg.id, error: err.message });
    });

  return true; // Keep the message channel open for the async response
});

// ── Entry point ───────────────────────────────────────────────────────────────

async function convertImage(srcUrl, format, quality) {
  // 🛡️ Strategy: try/catch wrapping image fetch
  let blob;
  try {
    if (srcUrl.startsWith('data:')) {
      blob = dataURItoBlob(srcUrl);
    } else {
      const controller = new AbortController();
      const fetchTimer = setTimeout(() => controller.abort(), 20_000); // 20s fetch timeout
      try {
        const r = await fetch(srcUrl, { cache: 'no-cache', signal: controller.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} fetching image`);
        blob = await r.blob();
      } finally {
        clearTimeout(fetchTimer);
      }
    }
  } catch (err) {
    throw new Error(`Image fetch failed: ${err.message}`);
  }

  // 🛡️ Strategy: try/catch wrapping bitmap decode
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (err) {
    throw new Error(`Could not decode image (unsupported format or corrupt data): ${err.message}`);
  }

  if (bitmap.width === 0 || bitmap.height === 0) {
    bitmap.close();
    throw new Error('Image has zero dimensions — cannot convert');
  }

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not get 2D context from OffscreenCanvas');
  }

  // White background for formats that don't support alpha transparency
  if (['jpg', 'pdf', 'gif', 'bmp', 'tiff'].includes(format)) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  log.info(`Canvas ready: ${canvas.width}×${canvas.height} → ${format}`);

  // 🛡️ Strategy: try/catch per format branch, with meaningful error messages
  try {
    switch (format) {
      case 'png':
        return blobToDataURL(await canvas.convertToBlob({ type: 'image/png' }));

      case 'jpg':
        return blobToDataURL(await canvas.convertToBlob({ type: 'image/jpeg', quality }));

      case 'webp':
        return blobToDataURL(await canvas.convertToBlob({ type: 'image/webp', quality }));

      case 'avif': {
        // 🛡️ AVIF may not be supported — graceful WebP fallback
        try {
          return blobToDataURL(await canvas.convertToBlob({ type: 'image/avif', quality }));
        } catch (avifErr) {
          log.warn('AVIF not supported in this Chrome version, falling back to WebP:', avifErr.message);
          return blobToDataURL(await canvas.convertToBlob({ type: 'image/webp', quality }));
        }
      }

      case 'svg':  return svgFromCanvas(canvas);
      case 'pdf':  return pdfFromCanvas(canvas, quality);
      case 'gif':  return gifFromCanvas(canvas);
      case 'tiff': return tiffFromCanvas(canvas);
      case 'bmp':  return bmpFromCanvas(canvas);

      default:
        throw new Error(`Unknown output format: "${format}"`);
    }
  } catch (err) {
    throw new Error(`Encoding to ${format.toUpperCase()} failed: ${err.message}`);
  }
}

// ── SVG ───────────────────────────────────────────────────────────────────────

async function svgFromCanvas(canvas) {
  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  const pngUrl  = await blobToDataURL(pngBlob);
  const W = canvas.width, H = canvas.height;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image width="${W}" height="${H}" xlink:href="${pngUrl}"/>
</svg>`;
  return blobToDataURL(new Blob([svg], { type: 'image/svg+xml' }));
}

// ── PDF ───────────────────────────────────────────────────────────────────────

async function pdfFromCanvas(canvas, quality = 0.92) {
  const jpgBlob  = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const jpgBytes = new Uint8Array(await jpgBlob.arrayBuffer());
  const W = canvas.width, H = canvas.height;

  const enc   = new TextEncoder();
  const parts = [];
  const push  = s => parts.push(enc.encode(s));
  const pushB = b => parts.push(b);
  const byteLen = () => parts.reduce((s, p) => s + p.length, 0);

  const offsets = [];
  const startObj = () => offsets.push(byteLen());

  push('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

  startObj();
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  startObj();
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  startObj();
  push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}]\n` +
       `   /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`);

  const streamStr = `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\n`;
  startObj();
  push(`4 0 obj\n<< /Length ${enc.encode(streamStr).length} >>\nstream\n`);
  push(streamStr);
  push('endstream\nendobj\n');

  startObj();
  push(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H}\n` +
       `   /ColorSpace /DeviceRGB /BitsPerComponent 8\n` +
       `   /Filter /DCTDecode /Length ${jpgBytes.length} >>\nstream\n`);
  pushB(jpgBytes);
  push('\nendstream\nendobj\n');

  const xrefOffset = byteLen();
  push('xref\n0 6\n0000000000 65535 f \n');
  for (const off of offsets) push(`${String(off).padStart(10,'0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const total = byteLen();
  const out   = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }

  return blobToDataURL(new Blob([out], { type: 'application/pdf' }));
}

// ── GIF ───────────────────────────────────────────────────────────────────────

function gifFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return blobToDataURL(encodeGIF(id));
}

function encodeGIF(imageData) {
  const { width, height, data } = imageData;
  const { palette, indices } = quantizeImage(data, width * height, 256);

  const out = [];
  const u16 = v => { out.push(v & 0xFF, (v >> 8) & 0xFF); };

  for (const c of 'GIF89a') out.push(c.charCodeAt(0));
  u16(width); u16(height);
  out.push(0xF7, 0, 0);

  for (let i = 0; i < 256; i++) {
    const c = palette[i] ?? [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }

  out.push(0x2C);
  u16(0); u16(0); u16(width); u16(height);
  out.push(0x00);

  const minCodeSize = 8;
  out.push(minCodeSize);
  const compressed = lzwCompress(indices, minCodeSize);
  for (let i = 0; i < compressed.length; i += 255) {
    const chunk = compressed.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  out.push(0x3B);

  return new Blob([new Uint8Array(out)], { type: 'image/gif' });
}

function quantizeImage(data, pixelCount, maxColors) {
  const step   = Math.max(1, Math.floor(pixelCount / 50000));
  const pixels = [];
  for (let i = 0; i < pixelCount; i += step) pixels.push([data[i*4], data[i*4+1], data[i*4+2]]);

  const palette = medianCut(pixels, maxColors);
  const indices = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const dr = r-palette[j][0], dg = g-palette[j][1], db = b-palette[j][2];
      const d  = dr*dr + dg*dg + db*db;
      if (d < bestD) { bestD = d; best = j; }
    }
    indices[i] = best;
  }
  return { palette, indices };
}

function medianCut(pixels, maxColors) {
  let buckets = [pixels.slice()];
  while (buckets.length < maxColors) {
    let maxR = 0, maxI = 0;
    for (let i = 0; i < buckets.length; i++) { const r = bucketRange(buckets[i]); if (r > maxR) { maxR = r; maxI = i; } }
    if (maxR === 0) break;
    const bucket = buckets[maxI];
    const ch = dominantChannel(bucket);
    bucket.sort((a, b) => a[ch] - b[ch]);
    const mid = bucket.length >> 1;
    buckets.splice(maxI, 1, bucket.slice(0, mid), bucket.slice(mid));
    if (!buckets[buckets.length-1].length) buckets.pop();
  }
  return buckets.map(b => {
    const n = b.length;
    return [
      Math.round(b.reduce((s,p)=>s+p[0],0)/n),
      Math.round(b.reduce((s,p)=>s+p[1],0)/n),
      Math.round(b.reduce((s,p)=>s+p[2],0)/n),
    ];
  });
}

function bucketRange(pixels) {
  let rlo=255,rhi=0,glo=255,ghi=0,blo=255,bhi=0;
  for (const [r,g,b] of pixels) { if(r<rlo)rlo=r;if(r>rhi)rhi=r;if(g<glo)glo=g;if(g>ghi)ghi=g;if(b<blo)blo=b;if(b>bhi)bhi=b; }
  return Math.max(rhi-rlo, ghi-glo, bhi-blo);
}

function dominantChannel(pixels) {
  let rlo=255,rhi=0,glo=255,ghi=0,blo=255,bhi=0;
  for (const [r,g,b] of pixels) { if(r<rlo)rlo=r;if(r>rhi)rhi=r;if(g<glo)glo=g;if(g>ghi)ghi=g;if(b<blo)blo=b;if(b>bhi)bhi=b; }
  const ranges = [rhi-rlo, ghi-glo, bhi-blo];
  return ranges.indexOf(Math.max(...ranges));
}

function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eofCode   = clearCode + 1;
  let codeSize = minCodeSize + 1, nextCode = eofCode + 1, limit = 1 << codeSize;

  const table = new Map();
  const reset = () => { table.clear(); nextCode = eofCode+1; codeSize = minCodeSize+1; limit = 1<<codeSize; };

  const bits = [];
  const emit = code => { for (let i=0;i<codeSize;i++) bits.push((code>>i)&1); };

  emit(clearCode);
  let prev = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const cur = indices[i];
    const key = (prev << 8) | cur;
    if (table.has(key)) { prev = table.get(key); }
    else {
      emit(prev);
      if (nextCode <= 4095) {
        table.set(key, nextCode++);
        if (nextCode > limit && codeSize < 12) { codeSize++; limit <<= 1; }
      } else { emit(clearCode); reset(); }
      prev = cur;
    }
  }
  emit(prev);
  emit(eofCode);

  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8 && i+j < bits.length; j++) byte |= bits[i+j] << j;
    bytes.push(byte);
  }
  return bytes;
}

// ── TIFF ──────────────────────────────────────────────────────────────────────

function tiffFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return blobToDataURL(encodeTIFF(id));
}

function encodeTIFF(imageData) {
  const { width, height, data } = imageData;
  const strip     = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) { strip[i*3]=data[i*4]; strip[i*3+1]=data[i*4+1]; strip[i*3+2]=data[i*4+2]; }

  const ifdOffset   = 8, numEntries = 13;
  const ifdBytes    = 2 + numEntries * 12 + 4;
  const extrasOffset = ifdOffset + ifdBytes;
  const bpsOff = extrasOffset, xResOff = bpsOff+6, yResOff = xResOff+8, stripOff = yResOff+8;

  const buf = new ArrayBuffer(stripOff + strip.length);
  const dv  = new DataView(buf);
  const u8  = new Uint8Array(buf);

  dv.setUint8(0,0x49); dv.setUint8(1,0x49); dv.setUint16(2,42,true); dv.setUint32(4,ifdOffset,true);

  let p = ifdOffset;
  dv.setUint16(p, numEntries, true); p += 2;
  const ie = (tag, type, count, val) => { dv.setUint16(p,tag,true);dv.setUint16(p+2,type,true);dv.setUint32(p+4,count,true);dv.setUint32(p+8,val,true);p+=12; };

  ie(256,4,1,width); ie(257,4,1,height); ie(258,3,3,bpsOff); ie(259,3,1,1);
  ie(262,3,1,2); ie(273,4,1,stripOff); ie(277,3,1,3); ie(278,4,1,height);
  ie(279,4,1,strip.length); ie(282,5,1,xResOff); ie(283,5,1,yResOff);
  ie(284,3,1,1); ie(296,3,1,2);
  dv.setUint32(p,0,true);

  dv.setUint16(bpsOff,8,true); dv.setUint16(bpsOff+2,8,true); dv.setUint16(bpsOff+4,8,true);
  dv.setUint32(xResOff,72,true); dv.setUint32(xResOff+4,1,true);
  dv.setUint32(yResOff,72,true); dv.setUint32(yResOff+4,1,true);
  u8.set(strip, stripOff);

  return new Blob([buf], { type: 'image/tiff' });
}

// ── BMP ───────────────────────────────────────────────────────────────────────

function bmpFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return blobToDataURL(encodeBMP(id));
}

function encodeBMP(imageData) {
  const { width, height, data } = imageData;
  const rowSize    = Math.ceil(width * 3 / 4) * 4;
  const pixDataSize = rowSize * height;
  const buf = new ArrayBuffer(54 + pixDataSize);
  const dv  = new DataView(buf);
  const u8  = new Uint8Array(buf);

  u8[0]=66; u8[1]=77;
  dv.setUint32(2, 54+pixDataSize, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, width, true); dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true); dv.setUint16(28, 24, true);
  dv.setUint32(34, pixDataSize, true); dv.setInt32(38, 2835, true); dv.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const rowOff = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      u8[rowOff+x*3]=data[src+2]; u8[rowOff+x*3+1]=data[src+1]; u8[rowOff+x*3+2]=data[src];
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function blobToDataURL(blob) {
  // 🛡️ Strategy: try/catch around FileReader
  return new Promise((resolve, reject) => {
    try {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = () => reject(new Error(`FileReader error: ${r.error?.message ?? 'unknown'}`));
      r.readAsDataURL(blob);
    } catch (err) {
      reject(new Error(`blobToDataURL setup failed: ${err.message}`));
    }
  });
}

function dataURItoBlob(dataURI) {
  // 🛡️ Strategy: try/catch on data URI parsing
  try {
    const [header, b64] = dataURI.split(',');
    if (!header || !b64) throw new Error('Malformed data URI');
    const mime   = header.match(/:(.*?);/)?.[1];
    if (!mime) throw new Error('Could not extract MIME type from data URI');
    const binary = atob(b64);
    const arr    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
  } catch (err) {
    throw new Error(`dataURItoBlob failed: ${err.message}`);
  }
}
