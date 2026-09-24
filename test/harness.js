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
// page.route() in launchBrowser() intercepts texture requests and serves real
// WebP files from assets/textures/ — no dummy injection needed.
const FX_TEX_VARIANT = 'tex01';
const FX_TEX_FILE    = 'photobooth_texture01.webp';

// Two render variants per combo: with and without an active FX-layer texture.
const RENDER_VARIANTS = [
  { id: 'null',  fxTexture: null },
  { id: 'fxtex', fxTexture: { variant: FX_TEX_VARIANT, intensity: 100 } },
];

// ── stars + nolook known bugs ─────────────────────────────────────────────────
// evSaveAndReturn double-applies stars on __nolook__ — remove when fixed
const KNOWN_BUGS = new Set([
  'nolook__stars__evSaveAndReturn',
]);

const STARS_PHOTOS  = ['portrait', 'highlights'];
const STARS_CONFIGS = [
  { id: 'flare_d0_preset',  presetId: 'velvetroom', stars: { variant: 'stars-flare', amount: 100, range: 140, scale: 2.0, rotation: 0, dispersion:   0 } },
  { id: 'flare_d100_nopre', presetId: '__nolook__', stars: { variant: 'stars-flare', amount: 100, range: 140, scale: 2.0, rotation: 0, dispersion: 100 } },
  { id: 'std_preset',       presetId: 'velvetroom', stars: { variant: 'stars',       amount: 100, range: 140, scale: 1.0, rotation: 0, dispersion:   0 } },
];
const STARS_OFF  = { variant: null, amount: 0, range: 140, scale: 1.0, rotation: 0, dispersion: 0 };
const STARS_SEED = 0x5EED;

// ── nolook edit scenarios ─────────────────────────────────────────────────────
const NOLOOK_SEED  = 0xA710;
const NOLOOK_EDITS = [
  { id: 'exposure', sliders: { EXPOSURE: 0.9 } },
  { id: 'hsl',     sliders: { SAT_REDS: 1.0 } },
  { id: 'grain',   sliders: { GRAIN:    0.85 } },
  { id: 'texture', fx:      { texture: { variant: FX_TEX_VARIANT, intensity: 100 } } },
  { id: 'stars',   fx:      { stars:   { variant: 'stars-flare', amount: 100, range: 140, scale: 1.0, rotation: 0, dispersion: 0 } } },
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

function makeHighlights() {
  // 640×480: near-black background (luma≈9), 6 small bright discs at fixed well-separated
  // positions (≥113 px apart so NMS at suppR=28×scale=2.0 detects each independently),
  // plus one larger disc (r=30, luma=255) that extends to the image edge.
  const W = 640, H = 480;
  const px = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i += 3) { px[i] = 8; px[i + 1] = 10; px[i + 2] = 6; }
  // [cx, cy, radius, R, G, B] — luma(R,G,B) > 230 for all bright discs
  const DISCS = [
    [ 80,  60,  8, 245, 240, 230],
    [240,  80,  7, 238, 242, 230],
    [440,  70,  9, 248, 246, 240],
    [120, 280,  6, 235, 240, 228],
    [340, 320, 10, 242, 238, 234],
    [520, 380,  8, 244, 240, 240],
    [310, 200, 30, 255, 255, 255],  // large disc, clipped at image boundary
  ];
  for (const [cx, cy, r, R, G, B] of DISCS) {
    for (let y = Math.max(0, cy - r); y <= Math.min(H - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(W - 1, cx + r); x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
          const i = (y * W + x) * 3; px[i] = R; px[i + 1] = G; px[i + 2] = B;
        }
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
  page.on('download', d => d.cancel().catch(() => {}));

  // Serve real texture WebP files. The dev server returns index.html for every URL
  // (single-file HttpListener with no static routing), so texture requests fail there.
  // Intercept them here and fulfill from disk instead.
  await page.route('**/assets/textures/*.webp', async (route) => {
    const url      = new URL(route.request().url());
    const filename = path.basename(url.pathname);
    const filePath = path.resolve(TEST_DIR, '..', 'assets', 'textures', filename);
    if (fs.existsSync(filePath)) {
      await route.fulfill({
        body:        fs.readFileSync(filePath),
        contentType: 'image/webp',
        headers:     { 'Access-Control-Allow-Origin': '*' },
      });
    } else {
      await route.abort();
    }
  });

  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  return { browser, page };
}

// ── render one combination via the REAL app path function ─────────────────────
// fxTexture: null | { variant: string, intensity: number }
async function renderCombo(page, photoId, presetId, pathId, seed, fxTexture, probeOpts) {
  const { W, H, px } = photoId === 'portrait' ? makePortrait() : makeLandscape();
  const photoURL     = pixelsToDataURL(W, H, px);

  return page.evaluate(async ([photoURL, presetId, pathId, seed, fxTexture, probeOpts]) => {
    // Deterministic XORShift32 PRNG — seeded consistently per combo so grain
    // is identical between capture and compare runs.
    let _s = (seed >>> 0) || 1;
    const _origRandom = Math.random;
    Math.random = () => {
      _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
      return (_s >>> 0) / 4294967296;
    };
    let _origApplyTextureOverlay = null;

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
      // fxState.texture is set below; always clear frames.
      if (typeof fxState !== 'undefined') { fxState.frames = null; fxState.texture = null; }
      // library is const array — mutate in place
      library.length = 0;
      const entry = {
        id: 'harness', dataURL: photoURL,
        editState: { presetId, sliders: sliderState[presetId] || {}, intensity: 1.0 }
      };
      library.push(entry);
      editingIdx = 0;

      // ── set fxState.texture ────────────────────────────────────────────────────
      if (typeof fxState !== 'undefined') {
        fxState.texture = fxTexture; // null or { variant, intensity }
      }

      // ── mirror fxState into entry.editState (matches autoSaveEdit pattern) ──
      entry.editState.fxState = (typeof fxState !== 'undefined')
        ? JSON.parse(JSON.stringify(fxState))
        : null;

      // ── proof mode: intercept applyTextureOverlay to render without texture ──
      if (probeOpts && probeOpts.nullPresetTexture) {
        _origApplyTextureOverlay = window.applyTextureOverlay;
        window.applyTextureOverlay = function() {};
      }

      // ── pre-warm textures ─────────────────────────────────────────────────────
      // applyTextureOverlay returns early if !img.complete || !img.naturalWidth.
      // _evDoSave retries via tx.onload; other paths do not — they silently skip.
      // Pre-loading here ensures every path finds its texture ready in _texCache.
      const _preWarm = async (file) => {
        if (!file) return;
        const img = loadTexture(file);
        if (img.complete && img.naturalWidth) return;
        await new Promise((res) => {
          const origOnload = img.onload;
          img.onload = () => { img.onload = origOnload; res(); };
          img.onerror = res;
        });
      };
      if (p.textureOverlay && p.textureOverlay.file) await _preWarm(p.textureOverlay.file);
      if (fxTexture) {
        const fxVariant = (typeof FX_VARIANTS !== 'undefined' && FX_VARIANTS.texture || [])
          .find(t => t.id === fxTexture.variant);
        if (fxVariant && fxVariant.assetFile) await _preWarm(fxVariant.assetFile);
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
        if (area) { area.style.width = '375px'; area.style.height = '600px'; void area.offsetWidth; }
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
      if (_origApplyTextureOverlay !== null) window.applyTextureOverlay = _origApplyTextureOverlay;
    }
  }, [photoURL, presetId, pathId, seed, fxTexture, probeOpts || {}]);
}

// ── reload helper — resets page state between preset+variant groups ───────────
async function reloadPage(page) {
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
}

// ── texture coverage proof ─────────────────────────────────────────────────────
// Renders automat/portrait/evSaveAndReturn twice with the same seed: once normally
// (real preset WebP texture composited) and once with applyTextureOverlay
// intercepted (no texture applied). MAD between them proves the real WebP
// texture is changing pixels. Companion number: 1×1 black dummy gives MAD ~0
// analytically — screen-blend of black: result = src + dst - src*dst/255 → dst.
async function proveTexture(page) {
  const PROOF_SEED = 0xDEAD;
  await reloadPage(page);
  const dataWith    = await renderCombo(page, 'portrait', 'automat', 'evSaveAndReturn', PROOF_SEED, null, {});
  await reloadPage(page);
  const dataWithout = await renderCombo(page, 'portrait', 'automat', 'evSaveAndReturn', PROOF_SEED, null, { nullPresetTexture: true });

  const bufWith    = Buffer.from(dataWith.replace('data:image/png;base64,', ''), 'base64');
  const bufWithout = Buffer.from(dataWithout.replace('data:image/png;base64,', ''), 'base64');
  const madReal    = computeMAD(bufWith, bufWithout);

  console.log('\n  Texture coverage proof (automat/portrait/evSaveAndReturn):');
  console.log(`  MAD real WebP texture vs no texture:  ${madReal.toFixed(4)}${madReal > 0.5 ? '  ✓ compositing' : '  ✗ NOT compositing — texture not applied!'}`);
  console.log(`  MAD 1×1 black dummy vs no texture:    ~0.0000  (screen-blend of black is a no-op: result = dst)`);
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
    await proveTexture(page);
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

// ── stars render ─────────────────────────────────────────────────────────────
async function renderStarsCombo(page, photoId, cfg, pathId, seed, starsOn) {
  const { W, H, px } = photoId === 'portrait' ? makePortrait() : makeHighlights();
  const photoURL = pixelsToDataURL(W, H, px);
  const presetId = cfg.presetId;
  const starsCfg = starsOn ? cfg.stars : STARS_OFF;

  return page.evaluate(async ([photoURL, presetId, pathId, seed, starsCfg]) => {
    let _s = (seed >>> 0) || 1;
    const _origRandom = Math.random;
    Math.random = () => {
      _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
      return (_s >>> 0) / 4294967296;
    };

    try {
      const img = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej;
        im.src = photoURL;
      });

      const isNolook = presetId === '__nolook__';
      const p = isNolook ? _evNoLookPreset : presets.find(x => x.id === presetId);
      if (!p) throw new Error('Preset not found: ' + presetId);
      initSliderState(p);

      userImage       = img;
      activePreset    = p;
      evActivePreset  = p;
      presetIntensity = 1.0;
      window.blemishSpots = [];
      window._slDragging  = false;
      if (typeof fxState !== 'undefined') { fxState.frames = null; fxState.texture = null; }

      if (typeof fxState !== 'undefined') {
        fxState.stars = JSON.parse(JSON.stringify(starsCfg));
      }

      library.length = 0;
      const entry = {
        id: 'harness', dataURL: photoURL,
        editState: {
          presetId,
          sliders: sliderState[presetId] || {},
          intensity: 1.0,
          fxState: typeof fxState !== 'undefined' ? JSON.parse(JSON.stringify(fxState)) : null
        }
      };
      library.push(entry);
      editingIdx = 0;

      if (!isNolook && p.textureOverlay && p.textureOverlay.file) {
        const texImg = loadTexture(p.textureOverlay.file);
        if (!texImg.complete || !texImg.naturalWidth) {
          await new Promise(res => {
            const orig = texImg.onload;
            texImg.onload = () => { texImg.onload = orig; res(); };
            texImg.onerror = res;
          });
        }
      }

      // Instrument applyStarFlares to capture call count and star positions
      const callLog = [];
      const _origApplyStarFlares = window.applyStarFlares;
      const _origDrawStar        = window._drawStarShape;
      window.applyStarFlares = function(canvas, opts, offX, offY, w, h) {
        const positions = [];
        window._drawStarShape = function(ctx, cx, cy, ...rest) {
          positions.push({ cx, cy });
          return _origDrawStar ? _origDrawStar.call(this, ctx, cx, cy, ...rest) : undefined;
        };
        const result = _origApplyStarFlares.call(this, canvas, opts, offX, offY, w, h);
        window._drawStarShape = _origDrawStar;
        callLog.push({ w: canvas.width, h: canvas.height, variant: opts && opts.variant,
          nStars: positions.length, positions: positions.slice() });
        return result;
      };

      const waitCapture = () => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('Capture timeout: ' + pathId)), 15000);
        window.addEventListener('harness-capture', () => { clearTimeout(t); res(window.__HARNESS_CAPTURE); }, { once: true });
      });

      const showEditor = () => {
        const gv = document.getElementById('gallery-view');
        const ev = document.getElementById('editor-view');
        if (gv) gv.style.display = 'none';
        if (ev) ev.style.display = 'flex';
      };

      let dataURL;
      if (pathId === 'evRenderCanvasImmediate') {
        showEditor();
        const area = document.getElementById('ev-canvas-area');
        if (area) { area.style.width = '375px'; area.style.height = '600px'; void area.offsetWidth; }
        _evRenderCanvasImmediate();
        dataURL = document.getElementById('ev-canvas').toDataURL('image/png');

      } else if (pathId === 'evDoSave') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _evDoSave();
        dataURL = await cap;

      } else if (pathId === 'evSaveAndReturn') {
        showEditor();
        const origBack     = window.editorBackToGallery;
        const origSave     = window.libSaveToStorage;
        const origRender   = window.renderLibrary;
        const origAutoSave = window.autoSaveEdit;
        window.editorBackToGallery = () => {};
        window.libSaveToStorage    = () => {};
        window.renderLibrary       = () => {};
        window.autoSaveEdit        = () => {};
        window.__HARNESS_CAPTURE_ACTIVE = true;
        try {
          const cap = waitCapture();
          evSaveAndReturn();
          dataURL = await cap;
        } finally {
          window.editorBackToGallery = origBack;
          window.libSaveToStorage    = origSave;
          window.renderLibrary       = origRender;
          window.autoSaveEdit        = origAutoSave;
        }

      } else if (pathId === 'renderBatchThumbnail') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _renderBatchThumbnail(entry, presetId, sliderState[presetId] || {}, 1.0, () => {});
        dataURL = await cap;

      } else if (pathId === 'exportEntry') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _exportEntry(entry, () => {});
        dataURL = await cap;

      } else if (pathId === 'applyCanvasEffects') {
        const origClose = window.exportModalClose;
        window.exportModalClose = () => {};
        expFmt = 'jpg';
        window.__HARNESS_CAPTURE_ACTIVE = true;
        try {
          const cap = waitCapture();
          exportDownload();
          dataURL = await cap;
        } finally {
          window.exportModalClose = origClose;
        }

      } else {
        throw new Error('Unknown pathId: ' + pathId);
      }

      window.applyStarFlares = _origApplyStarFlares;
      window._drawStarShape  = _origDrawStar;
      return { dataURL, callLog };

    } finally {
      Math.random = _origRandom;
    }
  }, [photoURL, presetId, pathId, seed, starsCfg]);
}

// ── stars capture ─────────────────────────────────────────────────────────────
async function captureStars(outDir) {
  const { browser, page } = await launchBrowser();
  const CASES = [];
  for (const photoId of STARS_PHOTOS)
    for (const cfg of STARS_CONFIGS)
      for (const pathId of PATHS)
        CASES.push({ photoId, cfg, pathId });
  const total = CASES.length;
  let count = 0, totalBytes = 0;
  const coverage  = [];
  const crossPath = {};

  try {
    let seed = STARS_SEED;
    for (const { photoId, cfg, pathId } of CASES) {
      const name   = `stars__${photoId}__${cfg.id}__${pathId}`;
      const onSeed = seed++;

      await reloadPage(page);
      let onResult;
      try {
        onResult = await renderStarsCombo(page, photoId, cfg, pathId, onSeed, true);
      } catch (e) {
        console.error(`\n  RENDER ERROR (on) ${name}: ${e.message}`);
        coverage.push({ name, madCov: -1, callCount: 0, callLog: [] });
        count++; continue;
      }

      await reloadPage(page);
      let offResult;
      try {
        offResult = await renderStarsCombo(page, photoId, cfg, pathId, onSeed, false);
      } catch (e) {
        console.error(`\n  RENDER ERROR (off) ${name}: ${e.message}`);
        coverage.push({ name, madCov: -1, callCount: 0, callLog: [] });
        count++; continue;
      }

      const onBuf  = Buffer.from(onResult.dataURL.replace('data:image/png;base64,', ''), 'base64');
      const offBuf = Buffer.from(offResult.dataURL.replace('data:image/png;base64,', ''), 'base64');

      let madCov;
      try { madCov = computeMAD(onBuf, offBuf); } catch (e) { madCov = -1; }

      const callCount = onResult.callLog.length;
      coverage.push({ name, madCov, callCount, callLog: onResult.callLog });

      fs.writeFileSync(path.join(outDir, name + '.png'), onBuf);
      totalBytes += onBuf.length;

      const cpKey = `${photoId}__${cfg.id}`;
      if (!crossPath[cpKey]) crossPath[cpKey] = {};
      crossPath[cpKey][pathId] = onBuf;

      count++;
      process.stdout.write(`\r  [${count}/${total}] ${name}             `);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n  wrote ${count} files · ${(totalBytes / 1024).toFixed(0)} KB total`);

  const PAD = 66;
  console.log(`\n  Stars coverage proof (stars-on MAD vs stars-off — all must be > 0):`);
  console.log(`  ${'─'.repeat(PAD + 22)}`);
  let stopQ = false;
  for (const r of coverage) {
    const madStr = r.madCov < 0 ? 'SIZE-MISMATCH' : r.madCov.toFixed(4);
    if (KNOWN_BUGS.has(r.name)) {
      if (r.madCov === 0) {
        console.log(`  ${r.name.padEnd(PAD)} ${madStr}  KNOWN BUG (expected 0)`);
      } else {
        console.error(`  ${r.name.padEnd(PAD)} ${madStr}  ✗ KNOWN BUG FIXED — remove from KNOWN_BUGS`);
        stopQ = true;
      }
    } else {
      const fail = r.madCov === 0;
      if (fail) stopQ = true;
      console.log(`  ${r.name.padEnd(PAD)} ${madStr}${fail ? '  ✗ STOP Q' : '  ✓'}`);
    }
  }
  console.log(`  ${'─'.repeat(PAD + 22)}`);

  console.log(`\n  Cross-path MAD matrix (each path vs evDoSave — informational):`);
  for (const [cpKey, byPath] of Object.entries(crossPath)) {
    const ref = byPath['evDoSave'];
    console.log(`\n  ${cpKey}:`);
    for (const pathId of PATHS) {
      const buf = byPath[pathId];
      if (!buf || !ref) { console.log(`    ${pathId.padEnd(30)} --`); continue; }
      let mad;
      try { mad = computeMAD(ref, buf); } catch (e) { mad = -1; }
      const madStr = mad < 0 ? 'SIZE-MISMATCH' : mad.toFixed(4);
      console.log(`    ${pathId.padEnd(30)} MAD vs evDoSave: ${madStr}`);
    }
  }

  console.log(`\n  applyStarFlares call count + star positions (highlights photo):`);
  for (const r of coverage) {
    if (!r.name.startsWith('stars__highlights__')) continue;
    console.log(`\n  ${r.name}:`);
    console.log(`    calls: ${r.callCount}`);
    for (let i = 0; i < r.callLog.length; i++) {
      const c = r.callLog[i];
      const posStr = c.positions.map(p => `(${(p.cx / c.w).toFixed(3)},${(p.cy / c.h).toFixed(3)})`).join(' ');
      console.log(`    call[${i}]: ${c.w}×${c.h} variant=${c.variant} nStars=${c.nStars}${posStr ? ' pos=' + posStr : ''}`);
    }
  }

  if (stopQ) {
    console.error('\n  ✗ STOP Q / STOP R: unexpected coverage failure — see marked rows above');
    process.exit(1);
  }
}

// ── stars compare ─────────────────────────────────────────────────────────────
async function compareStars(baseDir) {
  const { browser, page } = await launchBrowser();
  const rows = [];
  let failures = 0, maxMAD = 0;
  try {
    let seed = STARS_SEED;
    for (const photoId of STARS_PHOTOS) {
      for (const cfg of STARS_CONFIGS) {
        await reloadPage(page);
        for (const pathId of PATHS) {
          const name     = `stars__${photoId}__${cfg.id}__${pathId}`;
          const baseFile = path.join(baseDir, name + '.png');
          if (!fs.existsSync(baseFile)) {
            rows.push({ name, madStr: 'MISSING BASELINE', fail: true }); seed++; failures++; continue;
          }
          let result;
          try {
            result = await renderStarsCombo(page, photoId, cfg, pathId, seed++, true);
          } catch (e) {
            rows.push({ name, madStr: `RENDER ERR: ${String(e.message).slice(0, 50)}`, fail: true });
            failures++; continue;
          }
          const cur  = Buffer.from(result.dataURL.replace('data:image/png;base64,', ''), 'base64');
          const base = fs.readFileSync(baseFile);
          let mad;
          try { mad = computeMAD(base, cur); }
          catch (e) {
            rows.push({ name, madStr: `DECODE ERR: ${String(e.message).slice(0, 50)}`, fail: true });
            failures++; continue;
          }
          const fail = mad > 0;
          if (fail) failures++;
          maxMAD = Math.max(maxMAD, mad);
          rows.push({ name, madStr: mad.toFixed(4), fail });
        }
      }
    }
  } finally {
    await browser.close();
  }

  const PAD = 66;
  console.log(`\n  ${'combo'.padEnd(PAD)} MAD`);
  console.log(`  ${'─'.repeat(PAD + 10)}`);
  for (const r of rows)
    console.log(`  ${r.name.padEnd(PAD)} ${r.madStr}${r.fail ? '  ✗ FAIL' : ''}`);
  console.log(`  ${'─'.repeat(PAD + 10)}`);
  console.log(`  max MAD: ${maxMAD.toFixed(4)}   failures: ${failures}\n`);

  return failures === 0;
}

// ── nolook render ─────────────────────────────────────────────────────────────
// editSpec: { sliders?: {KEY:val,...}, fx?: {texture?:{...}, stars?:{...}} }
// Empty editSpec ({}) = neutral nolook (unedited reference).
async function renderNolookEdit(page, editSpec, pathId, seed) {
  const { W, H, px } = makePortrait();
  const photoURL    = pixelsToDataURL(W, H, px);
  const sliderEdits = editSpec.sliders || null;
  const fxEdits     = editSpec.fx     || null;
  const texVariant  = fxEdits && fxEdits.texture ? fxEdits.texture.variant : null;

  return page.evaluate(async ([photoURL, pathId, seed, sliderEdits, fxEdits, texVariant]) => {
    let _s = (seed >>> 0) || 1;
    const _origRandom = Math.random;
    Math.random = () => {
      _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5;
      return (_s >>> 0) / 4294967296;
    };

    try {
      const img = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej;
        im.src = photoURL;
      });

      const p = _evNoLookPreset;
      initSliderState(p);

      if (sliderEdits) {
        if (!sliderState[p.id]) sliderState[p.id] = {};
        for (const [k, v] of Object.entries(sliderEdits)) sliderState[p.id][k] = v;
      }

      userImage       = img;
      activePreset    = p;
      evActivePreset  = p;
      presetIntensity = 1.0;
      window.blemishSpots = [];
      window._slDragging  = false;
      if (typeof fxState !== 'undefined') { fxState.frames = null; fxState.texture = null; fxState.stars = null; }

      if (fxEdits && typeof fxState !== 'undefined') {
        for (const [k, v] of Object.entries(fxEdits))
          fxState[k] = v ? JSON.parse(JSON.stringify(v)) : null;
      }

      library.length = 0;
      const entry = {
        id: 'harness', dataURL: photoURL,
        editState: {
          presetId: p.id,
          sliders:  sliderState[p.id] || {},
          intensity: 1.0,
          fxState: typeof fxState !== 'undefined' ? JSON.parse(JSON.stringify(fxState)) : null
        }
      };
      library.push(entry);
      editingIdx = 0;

      if (texVariant) {
        const fxV = (typeof FX_VARIANTS !== 'undefined' && FX_VARIANTS.texture || [])
          .find(t => t.id === texVariant);
        if (fxV && fxV.assetFile) {
          const tx = loadTexture(fxV.assetFile);
          if (!tx.complete || !tx.naturalWidth)
            await new Promise(res => { const orig = tx.onload; tx.onload = () => { tx.onload = orig; res(); }; tx.onerror = res; });
        }
      }

      const waitCapture = () => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('Capture timeout: ' + pathId)), 15000);
        window.addEventListener('harness-capture', () => { clearTimeout(t); res(window.__HARNESS_CAPTURE); }, { once: true });
      });

      const showEditor = () => {
        const gv = document.getElementById('gallery-view');
        const ev = document.getElementById('editor-view');
        if (gv) gv.style.display = 'none';
        if (ev) ev.style.display = 'flex';
      };

      if (pathId === 'evRenderCanvasImmediate') {
        showEditor();
        const area = document.getElementById('ev-canvas-area');
        if (area) { area.style.width = '375px'; area.style.height = '600px'; void area.offsetWidth; }
        _evRenderCanvasImmediate();
        return document.getElementById('ev-canvas').toDataURL('image/png');

      } else if (pathId === 'evDoSave') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _evDoSave();
        return await cap;

      } else if (pathId === 'evSaveAndReturn') {
        showEditor();
        const origBack     = window.editorBackToGallery;
        const origSave     = window.libSaveToStorage;
        const origRender   = window.renderLibrary;
        const origAutoSave = window.autoSaveEdit;
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
        _renderBatchThumbnail(entry, p.id, sliderState[p.id] || {}, 1.0, () => {});
        return await cap;

      } else if (pathId === 'exportEntry') {
        window.__HARNESS_CAPTURE_ACTIVE = true;
        const cap = waitCapture();
        _exportEntry(entry, () => {});
        return await cap;

      } else if (pathId === 'applyCanvasEffects') {
        const origClose = window.exportModalClose;
        window.exportModalClose = () => {};
        expFmt = 'jpg';
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
  }, [photoURL, pathId, seed, sliderEdits, fxEdits, texVariant]);
}

// ── nolook compare ────────────────────────────────────────────────────────────
// For each edit (a-e), renders all 5 asserted paths and checks:
//   cross-path: MAD vs evDoSave edited ≤ 0.05 (evSaveAndReturn+stars is KNOWN_BUGS)
//   visibility: MAD vs evDoSave unedited > 0.5
async function compareNolook() {
  const { browser, page } = await launchBrowser();
  const ASSERT_PATHS = PATHS.filter(p => p !== 'evRenderCanvasImmediate');
  const CROSS_THRESH = 0.05;
  const VIS_THRESH   = 0.5;
  let stopS = false;
  const rows = [];

  try {
    let seed = NOLOOK_SEED;
    for (const edit of NOLOOK_EDITS) {
      // Reference: evDoSave edited
      await reloadPage(page);
      const refDataURL = await renderNolookEdit(page, edit, 'evDoSave', seed++);
      const refBuf = Buffer.from(refDataURL.replace('data:image/png;base64,', ''), 'base64');

      // Unedited reference: evDoSave neutral nolook
      await reloadPage(page);
      const unDataURL = await renderNolookEdit(page, {}, 'evDoSave', seed++);
      const unBuf = Buffer.from(unDataURL.replace('data:image/png;base64,', ''), 'base64');

      for (const pathId of ASSERT_PATHS) {
        const key = `nolook__${edit.id}__${pathId}`;
        let buf;

        if (pathId === 'evDoSave') {
          buf = refBuf; // self-comparison: crossMAD = 0
        } else {
          await reloadPage(page);
          let dataURL;
          try { dataURL = await renderNolookEdit(page, edit, pathId, seed++); }
          catch (e) {
            rows.push({ key, crossStr: 'RENDER ERR', visStr: 'RENDER ERR', crossFail: true, visFail: true, isKnownBug: false });
            stopS = true; continue;
          }
          buf = Buffer.from(dataURL.replace('data:image/png;base64,', ''), 'base64');
        }

        let crossMAD, visMAD;
        try { crossMAD = pathId === 'evDoSave' ? 0 : computeMAD(refBuf, buf); } catch (e) { crossMAD = -1; }
        try { visMAD   = computeMAD(unBuf, buf); }                              catch (e) { visMAD   = -1; }

        const crossStr = crossMAD < 0 ? 'SIZE-MISMATCH' : crossMAD.toFixed(4);
        const visStr   = visMAD   < 0 ? 'SIZE-MISMATCH' : visMAD.toFixed(4);
        const isKB     = KNOWN_BUGS.has(key);
        let crossFail  = false, visFail = false;

        if (isKB) {
          // Expected: crossMAD > CROSS_THRESH (known double-apply bug)
          // Fail (bug fixed) if crossMAD ≤ CROSS_THRESH
          if (crossMAD >= 0 && crossMAD <= CROSS_THRESH) { crossFail = true; stopS = true; }
        } else {
          if (crossMAD < 0 || crossMAD > CROSS_THRESH)  { crossFail = true; stopS = true; }
        }
        if (visMAD < 0 || visMAD <= VIS_THRESH)          { visFail  = true; stopS = true; }

        rows.push({ key, crossStr, visStr, crossFail, visFail, isKB });
      }
    }
  } finally {
    await browser.close();
  }

  const PAD = 48;
  console.log('\n  NOLOOK cross-path assertions  (portrait / __nolook__)');
  console.log(`  ${'─'.repeat(PAD + 44)}`);
  console.log(`  ${'key'.padEnd(PAD)} cross vs evDoSave  vis vs unedited`);
  console.log(`  ${'─'.repeat(PAD + 44)}`);
  for (const r of rows) {
    const crossTag = r.isKB
      ? (r.crossFail ? '  ✗ KNOWN BUG FIXED — remove from KNOWN_BUGS' : '  KNOWN BUG (expected fail)')
      : (r.crossFail ? '  ✗ STOP S' : '  ✓');
    const visTag = r.visFail ? '  ✗ STOP S' : '  ✓';
    console.log(`  ${r.key.padEnd(PAD)} ${r.crossStr.padEnd(18)} ${r.visStr}${visTag}${crossTag}`);
  }
  console.log(`  ${'─'.repeat(PAD + 44)}`);

  if (stopS) { console.error('\n  ✗ STOP S triggered'); process.exit(1); }
  return !stopS;
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

} else if (cmd === 'capture-stars') {
  const stamp   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dirName = flags.dir || `baseline-stars-${stamp}`;
  const outDir  = path.resolve(TEST_DIR, dirName);
  fs.mkdirSync(outDir, { recursive: true });
  const total = STARS_PHOTOS.length * STARS_CONFIGS.length * PATHS.length;
  console.log(`Capturing ${total} stars combinations → ${outDir}`);
  const t0 = Date.now();
  captureStars(outDir)
    .then(() => console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });

} else if (cmd === 'compare-stars') {
  const base = flags.baseline;
  if (!base) { console.error('Usage: node test/harness.js compare-stars --baseline=<dir>'); process.exit(1); }
  const baseDir = path.resolve(TEST_DIR, base);
  console.log(`Comparing stars against ${baseDir}`);
  const t0 = Date.now();
  compareStars(baseDir)
    .then(ok => { console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(ok ? 0 : 1); })
    .catch(e => { console.error(e); process.exit(1); });

} else if (cmd === 'compare-nolook') {
  console.log('NOLOOK assertion suite — portrait / __nolook__ / 5 edits / 5 asserted paths');
  const t0 = Date.now();
  compareNolook()
    .then(ok => { console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(ok ? 0 : 1); })
    .catch(e => { console.error(e); process.exit(1); });

} else {
  console.log('Usage:');
  console.log('  node test/harness.js capture [--dir=NAME]');
  console.log('  node test/harness.js compare --baseline=NAME [--threshold=0] [--mutate]');
  console.log('  node test/harness.js capture-stars [--dir=NAME]');
  console.log('  node test/harness.js compare-stars --baseline=NAME');
  console.log('  node test/harness.js compare-nolook');
  process.exit(1);
}
