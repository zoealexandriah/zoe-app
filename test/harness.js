'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── constants ─────────────────────────────────────────────────────────────────
const APP_URL  = 'http://localhost:3000';
const TEST_DIR = __dirname;

const PHOTOS  = ['portrait', 'landscape'];
// 4 presets: velvetroom (CA+grain+halation+bloom+diffusion+clarity+vignette+filmCrossover),
//            automat (textureOverlay+grain+diffusion+clarity+vignette+bloom),
//            fresco (CA+bloom+grain+diffusion+clarity+vignette),
//            havye (bloom+grain+diffusion+clarity+vignette)
const PRESETS = ['velvetroom', 'automat', 'fresco', 'havye'];
const PATHS   = [
  'evRenderCanvasImmediate',  // live preview canvas
  'evDoSave',                 // save-button export pipeline
  'evSaveAndReturn',          // checkmark save-and-back
  'renderBatchThumbnail',     // gallery thumbnail renderer
  'exportEntry',              // batch export
  'applyCanvasEffects',       // export-modal download (via exportDownload)
];
const GRAIN_SEED = 0xBEEF; // fixed starting seed; each combo uses seed+n

// FX texture variant used for the fxtex render variant.
// tex01 / photobooth_texture01.webp is the first entry in FX_VARIANTS.texture.
// In headless Playwright image loads fail, so the harness injects a 32×32 gray
// canvas dummy — non-black so screen-blend produces visible output change,
// proving the fxState texture path is actually exercised.
const FX_TEX_VARIANT = 'tex01';
const FX_TEX_FILE    = 'photobooth_texture01.webp';

// Two render variants per combo: with and without an active FX-layer texture.
const RENDER_VARIANTS = [
  { id: 'null',  fxTexture: null },
  { id: 'fxtex', fxTexture: { variant: FX_TEX_VARIANT, intensity: 100 } },
];

// ── synthetic photo generators ────────────────────────────────────────────────
// Both photos are 100 % algorithmic — no files, fully reproducible.

function makePortrait() {
  // 480×640, portrait: blown highlights top 20%, deep shadows bottom 40%, warm midtones
  const W = 480, H = 640;
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const fx = x / (W - 1);
      const i  = (y * W + x) * 3;
      if (fy > 0.6) {
        const t = (fy - 0.6) / 0.4;
        px[i]   = Math.max(0, Math.round(30 - 22 * t));
        px[i+1] = Math.max(0, Math.round(25 - 20 * t));
        px[i+2] = Math.max(0, Math.round(40 - 30 * t));
      } else if (fy < 0.2) {
        const t = fy / 0.2;
        px[i]   = 255 - Math.round(15 * (1 - t));
        px[i+1] = 252 - Math.round(12 * (1 - t));
        px[i+2] = 245 - Math.round(10 * (1 - t));
      } else {
        const t = (fy - 0.2) / 0.4;
        px[i]   = Math.min(255, Math.round(220 - 90 * t + 30 * fx));
        px[i+1] = Math.min(255, Math.round(170 - 60 * t + 20 * fx));
        px[i+2] = Math.max(0,   Math.round(130 - 50 * t - 20 * fx));
      }
    }
  }
  return { W, H, px };
}

function makeLandscape() {
  // 640×480: blue-sky gradient top 40%, earth bottom 60% (dark shadows left, sunlit right)
  const W = 640, H = 480;
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = y / (H - 1);
    for (let x = 0; x < W; x++) {
      const fx = x / (W - 1);
      const i  = (y * W + x) * 3;
      if (fy < 0.4) {
        const t = fy / 0.4;
        px[i]   = Math.round(80  + 100 * t);
        px[i+1] = Math.round(130 + 70  * t);
        px[i+2] = Math.round(210 - 30  * t);
      } else {
        const t = (fy - 0.4) / 0.6;
        px[i]   = Math.min(255, Math.round((40  + 140 * fx) * (1 - 0.3 * t)));
        px[i+1] = Math.min(255, Math.round((60  + 100 * fx) * (1 - 0.2 * t)));
        px[i+2] = Math.max(0,   Math.round((20  + 60  * fx) * (1 - 0.6 * t)));
      }
    }
  }
  return { W, H, px };
}

// ── PNG encoder (for converting synthetic pixel arrays to data URLs) ───────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const tb = Buffer.from(type);
  const lb = Buffer.allocUnsafe(4); lb.writeUInt32BE(data.length);
  const cb = Buffer.allocUnsafe(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([lb, tb, data, cb]);
}

function encodePNG(W, H, px) {
  const sig  = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const rows = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.allocUnsafe(1 + W * 3);
    row[0] = 0; // filter: None
    Buffer.from(px.buffer, px.byteOffset + y * W * 3, W * 3).copy(row, 1);
    rows.push(row);
  }
  const idat = zlib.deflateSync(Buffer.concat(rows), { level: 1 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function pixelsToDataURL(W, H, px) {
  return 'data:image/png;base64,' + encodePNG(W, H, px).toString('base64');
}

// ── PNG decoder (for comparison mode — no deps) ───────────────────────────────
function paethPredictor(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : pb <= pc ? b : c;
}

function decodePNG(buf) {
  let pos = 8, W, H, bpp;
  const idats = [];
  while (pos < buf.length) {
    const len  = buf.readUInt32BE(pos); pos += 4;
    const type = buf.slice(pos, pos + 4).toString('ascii'); pos += 4;
    const data = buf.slice(pos, pos + len); pos += len + 4; // +4 CRC
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bpp = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 1; // RGBA / RGB / grey
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') break;
  }
  const raw    = zlib.inflateSync(Buffer.concat(idats));
  const stride = 1 + W * bpp;
  const pixels = new Uint8Array(W * H * bpp);
  const prior  = new Uint8Array(W * bpp);
  for (let y = 0; y < H; y++) {
    const f     = raw[y * stride];
    const row   = raw.slice(y * stride + 1, (y + 1) * stride);
    const recon = new Uint8Array(row.length);
    for (let x = 0; x < row.length; x++) {
      const a = x >= bpp ? recon[x - bpp] : 0;
      const b = prior[x];
      const c = x >= bpp ? prior[x - bpp] : 0;
      switch (f) {
        case 0: recon[x] = row[x]; break;
        case 1: recon[x] = (row[x] + a) & 0xFF; break;
        case 2: recon[x] = (row[x] + b) & 0xFF; break;
        case 3: recon[x] = (row[x] + ((a + b) >>> 1)) & 0xFF; break;
        case 4: recon[x] = (row[x] + paethPredictor(a, b, c)) & 0xFF; break;
        default: throw new Error(`Unknown PNG filter byte: ${f}`);
      }
    }
    pixels.set(recon, y * W * bpp);
    prior.set(recon);
  }
  return { W, H, bpp, pixels };
}

function computeMAD(bufA, bufB) {
  const a = decodePNG(bufA), b = decodePNG(bufB);
  if (a.W !== b.W || a.H !== b.H) throw new Error(`Size mismatch: ${a.W}×${a.H} vs ${b.W}×${b.H}`);
  let sum = 0;
  const n = a.W * a.H;
  for (let i = 0; i < n; i++) {
    sum += Math.abs(a.pixels[i * a.bpp]     - b.pixels[i * b.bpp])
         + Math.abs(a.pixels[i * a.bpp + 1] - b.pixels[i * b.bpp + 1])
         + Math.abs(a.pixels[i * a.bpp + 2] - b.pixels[i * b.bpp + 2]);
  }
  return sum / (n * 3);
}

// ── browser launch (with capture hooks injected at page load) ─────────────────
async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,   // pin DPR so evRenderCanvasImmediate canvas size is stable
    acceptDownloads: false,
  });

  // Inject before ANY page script runs: hook canvas toDataURL + toBlob to capture
  // lossless PNG on the first JPEG call after __HARNESS_CAPTURE_ACTIVE is set.
  await ctx.addInitScript(() => {
    window.__HARNESS_CAPTURE        = null;
    window.__HARNESS_CAPTURE_ACTIVE = false;
    const _origDataURL = HTMLCanvasElement.prototype.toDataURL;
    const _origToBlob  = HTMLCanvasElement.prototype.toBlob;

    HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
      const result = _origDataURL.call(this, type, quality);
      if (window.__HARNESS_CAPTURE_ACTIVE && type && type.includes('jpeg')) {
        window.__HARNESS_CAPTURE        = _origDataURL.call(this, 'image/png');
        window.__HARNESS_CAPTURE_ACTIVE = false;
        window.dispatchEvent(new CustomEvent('harness-capture'));
      }
      return result; // return real JPEG so any downstream code works normally
    };

    HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
      if (window.__HARNESS_CAPTURE_ACTIVE) {
        window.__HARNESS_CAPTURE        = _origDataURL.call(this, 'image/png');
        window.__HARNESS_CAPTURE_ACTIVE = false;
        window.dispatchEvent(new CustomEvent('harness-capture'));
      }
      _origToBlob.call(this, cb, type, quality); // always fire real callback
    };
  });

  const page = await ctx.newPage();
  page.on('download', d => d.cancel().catch(() => {})); // swallow any download attempts
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  return { browser, page };
}

// ── render one combination via the REAL app path function ─────────────────────
// fxTexture: null | { variant: string, intensity: number }
async function renderCombo(page, photoId, presetId, pathId, seed, fxTexture) {
  const { W, H, px } = photoId === 'portrait' ? makePortrait() : makeLandscape();
  const photoURL     = pixelsToDataURL(W, H, px);

  return page.evaluate(async ([photoURL, presetId, pathId, seed, fxTexture]) => {
    // Deterministic XORShift32 PRNG — seeded consistently per combo so grain
    // is identical between capture and compare runs.
    let _s = (seed >>> 0) || 1;
    const _origRandom = Math.random;
    Math.random = () => {
      _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
      return (_s >>> 0) / 4294967296;
    };

    try {
      // ── load test photo ────────────────────────────────────────────────────
      const img = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej;
        im.src = photoURL;
      });

      // ── set global render state ────────────────────────────────────────────
      const p = presets.find(x => x.id === presetId);
      initSliderState(p);
      userImage       = img;        // let userImage — must NOT use window.xxx
      activePreset    = p;          // let activePreset
      evActivePreset  = p;          // let evActivePreset
      presetIntensity = 1.0;        // let presetIntensity
      window.blemishSpots = [];
      window._slDragging     = false;
      // fxState.texture is set below after dummy injection; always clear frames.
      if (typeof fxState !== 'undefined') { fxState.frames = null; fxState.texture = null; }
      // library is const array — mutate in place
      library.length = 0;
      const entry = {
        id: 'harness', dataURL: photoURL,
        editState: { presetId, sliders: sliderState[presetId] || {}, intensity: 1.0 }
      };
      library.push(entry);
      editingIdx = 0;

      // ── inject synthetic texture so _evDoSave's texture check passes ─────────
      // loadTexture() uses crossOrigin='anonymous' which makes headless Playwright
      // return complete=true but naturalWidth=0 (load failure). _evDoSave checks
      // !complete || !naturalWidth and if true: sets tx.onload=_evDoSave; return —
      // onload never fires on a failed image → infinite hang. Fix: replace the
      // cache entry with a working 1×1 dummy before calling any path.
      if (p.textureOverlay && p.textureOverlay.file) {
        const file = p.textureOverlay.file;
        const dummy = new Image();
        dummy.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==';
        await new Promise(r => { dummy.onload = r; dummy.onerror = r; });
        _texCache[file] = dummy;
      }

      // ── inject FX texture dummy when testing the fxState texture path ────────
      // Use a 32×32 gray canvas (not 1×1 black) so screen-blend produces a visible
      // change, proving the code path is exercised rather than silently skipped.
      if (fxTexture && typeof _texCache !== 'undefined') {
        const fxVariant = (typeof FX_VARIANTS !== 'undefined' && FX_VARIANTS.texture || [])
          .find(t => t.id === fxTexture.variant);
        const fxFile = fxVariant && fxVariant.assetFile;
        if (fxFile) {
          const dc = document.createElement('canvas');
          dc.width = 32; dc.height = 32;
          const dctx = dc.getContext('2d');
          dctx.fillStyle = '#808080';
          dctx.fillRect(0, 0, 32, 32);
          const di = new Image();
          di.src = dc.toDataURL('image/png');
          await new Promise(r => { di.onload = r; di.onerror = r; });
          _texCache[fxFile] = di;
        }
      }

      // ── set fxState.texture (after dummy injection so loadTexture finds it) ──
      if (typeof fxState !== 'undefined') {
        fxState.texture = fxTexture; // null or { variant, intensity }
      }

      // ── shared capture-promise factory ─────────────────────────────────────
      const waitCapture = () => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('Capture timeout for: ' + pathId)), 15000);
        window.addEventListener('harness-capture', () => { clearTimeout(t); res(window.__HARNESS_CAPTURE); }, { once: true });
      });

      // ── show editor view (needed by evRenderCanvasImmediate + evSaveAndReturn)
      const showEditor = () => {
        const gv = document.getElementById('gallery-view');
        const ev = document.getElementById('editor-view');
        if (gv) gv.style.display = 'none';
        if (ev) ev.style.display = 'flex';
      };

      // ── path-specific invocation ───────────────────────────────────────────
      if (pathId === 'evRenderCanvasImmediate') {
        showEditor();
        // Pin canvas-area size so canvas dimensions are stable across runs
        const area = document.getElementById('ev-canvas-area');
        if (area) { area.style.width = '375px'; area.style.height = '600px'; }
        _evRenderCanvasImmediate();
        return document.getElementById('ev-canvas').toDataURL('image/png');

      } else if (pathId === 'evDoSave') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _evDoSave();
        return cap;

      } else if (pathId === 'evSaveAndReturn') {
        showEditor();
        const origBack     = window.editorBackToGallery;
        const origSave     = window.libSaveToStorage;
        const origRender   = window.renderLibrary;
        const origAutoSave = window.autoSaveEdit;
        // Patch out navigation and storage side-effects
        window.editorBackToGallery = () => {};
        window.libSaveToStorage    = () => {};
        window.renderLibrary       = () => {};
        window.autoSaveEdit        = () => {};
        window.__HARNESS_CAPTURE_ACTIVE = true;
        let result;
        try {
          const cap = waitCapture();
          evSaveAndReturn();
          result = await cap;
        } finally {
          window.editorBackToGallery = origBack;
          window.libSaveToStorage    = origSave;
          window.renderLibrary       = origRender;
          window.autoSaveEdit        = origAutoSave;
        }
        return result;

      } else if (pathId === 'renderBatchThumbnail') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _renderBatchThumbnail(entry, presetId, sliderState[presetId] || {}, 1.0, () => {});
        return cap;

      } else if (pathId === 'exportEntry') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _exportEntry(entry, () => {});
        return cap;

      } else if (pathId === 'applyCanvasEffects') {
        // exportDownload() is the public function that runs _applyCanvasEffects internally
        const origClose  = window.exportModalClose;
        window.exportModalClose = () => {};
        expFmt = 'jpg';               // let expFmt — must NOT use window.xxx
        window.__HARNESS_CAPTURE_ACTIVE = true;
        let result;
        try {
          const cap = waitCapture();
          exportDownload();
          result = await cap;
        } finally {
          window.exportModalClose = origClose;
        }
        return result;
      }

      throw new Error('Unknown pathId: ' + pathId);

    } finally {
      Math.random = _origRandom;
    }
  }, [photoURL, presetId, pathId, seed, fxTexture]);
}

// ── reload helper — resets page state between preset+variant groups ───────────
async function reloadPage(page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
}

// ── capture mode ──────────────────────────────────────────────────────────────
async function capture(outDir) {
  const { browser, page } = await launchBrowser();
  const total = PHOTOS.length * PRESETS.length * RENDER_VARIANTS.length * PATHS.length;
  let count = 0, totalBytes = 0;
  try {
    let seed = GRAIN_SEED;
    for (const photoId of PHOTOS) {
      for (const presetId of PRESETS) {
        for (const variant of RENDER_VARIANTS) {
          // Fresh page state per photo+preset+variant group so lingering workers/timers
          // from the previous group don't interfere with the next group's captures.
          await reloadPage(page);
          for (const pathId of PATHS) {
            const dataURL = await renderCombo(page, photoId, presetId, pathId, seed++, variant.fxTexture);
            const buf     = Buffer.from(dataURL.replace('data:image/png;base64,', ''), 'base64');
            const name    = `${photoId}__${presetId}__${pathId}__${variant.id}.png`;
            fs.writeFileSync(path.join(outDir, name), buf);
            totalBytes += buf.length;
            count++;
            process.stdout.write(`\r  [${count}/${total}] ${name}             `);
          }
        }
      }
    }
    console.log(`\n  wrote ${count} files · ${(totalBytes / 1024).toFixed(0)} KB total`);
  } finally {
    await browser.close();
  }
}

// ── compare mode ──────────────────────────────────────────────────────────────
async function compare(baseDir, threshold, mutate) {
  const { browser, page } = await launchBrowser();
  const rows = [];
  let failures = 0, maxMAD = 0;
  try {
    let seed = GRAIN_SEED;
    for (const photoId of PHOTOS) {
      for (const presetId of PRESETS) {
        for (const variant of RENDER_VARIANTS) {
          await reloadPage(page);
          // --mutate: patch velvetroom grain in-page so detection is independent of
          // server-side file caching (server may cache HTML in memory between runs).
          if (mutate && presetId === 'velvetroom') {
            await page.evaluate(() => {
              const p = presets.find(x => x.id === 'velvetroom');
              if (p && p.defaults) p.defaults.GRAIN = 0.70; // was 0.35
            });
          }
          for (const pathId of PATHS) {
            const key      = `${photoId}/${presetId}/${variant.id}/${pathId}`;
            const baseFile = path.join(baseDir, `${photoId}__${presetId}__${pathId}__${variant.id}.png`);
            if (!fs.existsSync(baseFile)) {
              rows.push({ key, madStr: 'MISSING BASELINE', fail: true }); failures++; seed++; continue;
            }
            let dataURL;
            try {
              dataURL = await renderCombo(page, photoId, presetId, pathId, seed++, variant.fxTexture);
            } catch (e) {
              rows.push({ key, madStr: `RENDER ERR: ${String(e.message).slice(0,50)}`, fail: true });
              failures++; continue;
            }
            const cur  = Buffer.from(dataURL.replace('data:image/png;base64,', ''), 'base64');
            const base = fs.readFileSync(baseFile);
            let mad;
            try { mad = computeMAD(base, cur); }
            catch (e) {
              rows.push({ key, madStr: `DECODE ERR: ${String(e.message).slice(0,50)}`, fail: true });
              failures++; continue;
            }
            const fail = mad > threshold;
            if (fail) failures++;
            maxMAD = Math.max(maxMAD, mad);
            rows.push({ key, madStr: mad.toFixed(4), fail });
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  const PAD = 62;
  console.log(`\n  ${'combo'.padEnd(PAD)} MAD`);
  console.log(`  ${'─'.repeat(PAD + 10)}`);
  for (const r of rows)
    console.log(`  ${r.key.padEnd(PAD)} ${r.madStr}${r.fail ? '  ✗ FAIL' : ''}`);
  console.log(`  ${'─'.repeat(PAD + 10)}`);
  console.log(`  max MAD: ${maxMAD.toFixed(4)}   failures: ${failures}\n`);

  // ── cross-variant diff — proves fxState path exercises a different code path ─
  // Compare null vs fxtex baseline captures for specific presets and paths.
  // If MAD = 0, the FX texture was not applied and the coverage is fake.
  const DIFF_CHECKS = [
    // automat HAS a preset textureOverlay — fxtex replaces it with FX texture
    { presetId: 'automat',    pathId: 'evSaveAndReturn', note: 'preset texture → FX texture swap' },
    // velvetroom has NO preset textureOverlay — fxtex adds FX texture on top
    { presetId: 'velvetroom', pathId: 'evSaveAndReturn', note: 'no preset texture → FX texture added' },
  ];
  const diffRows = [];
  for (const { presetId, pathId, note } of DIFF_CHECKS) {
    for (const photoId of PHOTOS) {
      const nullFile  = path.join(baseDir, `${photoId}__${presetId}__${pathId}__null.png`);
      const fxtexFile = path.join(baseDir, `${photoId}__${presetId}__${pathId}__fxtex.png`);
      if (!fs.existsSync(nullFile) || !fs.existsSync(fxtexFile)) {
        diffRows.push({ key: `${photoId}/${presetId}/${pathId}`, madStr: 'MISSING FILE', note });
        continue;
      }
      let mad;
      try { mad = computeMAD(fs.readFileSync(nullFile), fs.readFileSync(fxtexFile)); }
      catch (e) { mad = -1; }
      diffRows.push({ key: `${photoId}/${presetId}/${pathId}`, madStr: mad >= 0 ? mad.toFixed(4) : 'DECODE ERR', note, zero: mad === 0 });
    }
  }
  console.log(`  Cross-variant diff (null vs fxtex baseline — must be > 0):`);
  console.log(`  ${'─'.repeat(PAD + 10)}`);
  for (const r of diffRows)
    console.log(`  ${r.key.padEnd(PAD)} ${r.madStr}${r.zero ? '  ✗ ZERO — coverage is fake!' : '  ✓'}  [${r.note}]`);
  console.log(`  ${'─'.repeat(PAD + 10)}\n`);

  return failures === 0 && diffRows.every(r => !r.zero);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const [,, cmd, ...argv] = process.argv;
const flags = Object.fromEntries(
  argv.filter(a => a.startsWith('--'))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; })
);

if (cmd === 'capture') {
  const stamp   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dirName = flags.dir || `baseline-${stamp}`;
  const outDir  = path.resolve(TEST_DIR, dirName);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Capturing ${PHOTOS.length * PRESETS.length * RENDER_VARIANTS.length * PATHS.length} combinations → ${outDir}`);
  console.log(`  Variants: ${RENDER_VARIANTS.map(v => v.id).join(', ')}  (FX texture: ${FX_TEX_VARIANT} / ${FX_TEX_FILE})`);
  const t0 = Date.now();
  capture(outDir)
    .then(() => console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });

} else if (cmd === 'compare') {
  const base = flags.baseline;
  if (!base) { console.error('Usage: node test/harness.js compare --baseline=<dir>'); process.exit(1); }
  const baseDir   = path.resolve(TEST_DIR, base);
  const threshold = parseFloat(flags.threshold ?? '0');
  const mutate    = !!flags.mutate;
  if (mutate) console.log('  [mutate] velvetroom GRAIN 0.35→0.70 (in-page patch)');
  console.log(`Comparing against ${baseDir}  (threshold ${threshold})`);
  const t0 = Date.now();
  compare(baseDir, threshold, mutate)
    .then(ok => { console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(ok ? 0 : 1); })
    .catch(e => { console.error(e); process.exit(1); });

} else {
  console.log('Usage:');
  console.log('  node test/harness.js capture [--dir=NAME]');
  console.log('  node test/harness.js compare --baseline=NAME [--threshold=0] [--mutate]');
  process.exit(1);
}
