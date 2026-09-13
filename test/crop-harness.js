'use strict';

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const APP_URL  = 'http://localhost:3000';
const TEST_DIR = __dirname;

const PHOTOS = ['portrait', 'landscape'];

// Ten sequences covering all five ops and key composition orderings.
const SEQUENCES = [
  { id: 'identity',
    transforms: [],
    note: 'empty list — must be true identity, no JPEG roundtrip' },
  { id: 'straighten_15',
    transforms: [{ op: 'straighten', angle: 15 }],
    note: 'single straighten 15°' },
  { id: 'rotate_cw',
    transforms: [{ op: 'rotate', dir: 'cw' }],
    note: 'single rotate CW (swaps dimensions)' },
  { id: 'flip_h',
    transforms: [{ op: 'flip', dir: 'h' }],
    note: 'single horizontal flip' },
  { id: 'crop_ratio',
    transforms: [{ op: 'crop', rx: 0.1, ry: 0.15, rw: 0.65, rh: 0.7 }],
    note: 'single crop changing aspect ratio' },
  { id: 'perspective_v40',
    transforms: [{ op: 'perspective', v: 40, h: 0 }],
    note: 'single perspective v=40' },
  { id: 'straighten_then_crop',
    transforms: [
      { op: 'straighten', angle: 15 },
      { op: 'crop', rx: 0.05, ry: 0.05, rw: 0.85, rh: 0.85 },
    ],
    note: 'straighten → crop' },
  { id: 'crop_then_straighten',
    transforms: [
      { op: 'crop', rx: 0.05, ry: 0.05, rw: 0.85, rh: 0.85 },
      { op: 'straighten', angle: 15 },
    ],
    note: 'crop → straighten (order matters — must differ from above)' },
  { id: 'perspective_then_straighten',
    transforms: [
      { op: 'perspective', v: 40, h: 0 },
      { op: 'straighten', angle: 10 },
    ],
    note: 'perspective → straighten' },
  { id: 'all_five',
    transforms: [
      { op: 'straighten', angle: 12 },
      { op: 'rotate', dir: 'cw' },
      { op: 'flip', dir: 'v' },
      { op: 'crop', rx: 0.08, ry: 0.08, rw: 0.8, rh: 0.8 },
      { op: 'perspective', v: 30, h: 0 },
    ],
    note: 'all five ops stacked' },
];

// ── synthetic photo generators (identical to harness.js) ──────────────────────
function makePortrait() {
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

// ── PNG encoder ────────────────────────────────────────────────────────────────
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

// ── PNG decoder ────────────────────────────────────────────────────────────────
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
    const data = buf.slice(pos, pos + len); pos += len + 4;
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bpp = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 1;
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
        default: throw new Error(`Unknown PNG filter: ${f}`);
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

// ── browser launch ─────────────────────────────────────────────────────────────
async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  return { browser, page };
}

// ── apply one crop sequence in-page, return PNG data URL ───────────────────────
// _cropApplyTransforms is stateless — takes (transforms, source, cb) with no
// globals. We pass transforms as JSON-serializable array.
async function renderCrop(page, photoId, transforms) {
  const { W, H, px } = photoId === 'portrait' ? makePortrait() : makeLandscape();
  const photoURL = pixelsToDataURL(W, H, px);

  return page.evaluate(async ([photoURL, transforms]) => {
    const srcImg = await new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej;
      im.src = photoURL;
    });

    const result = await new Promise((res) => {
      _cropApplyTransforms(transforms, srcImg, res);
    });

    const cv = document.createElement('canvas');
    cv.width  = result.naturalWidth  || result.width  || 1;
    cv.height = result.naturalHeight || result.height || 1;
    cv.getContext('2d').drawImage(result, 0, 0);
    return cv.toDataURL('image/png');
  }, [photoURL, transforms]);
}

// ── identity proof ─────────────────────────────────────────────────────────────
// Verifies that _cropApplyTransforms([]) returns the source image without any
// pixel alteration — MAD 0.0000 against a direct canvas draw of the source,
// not just against a stored baseline capture of itself.
async function proveIdentity(page) {
  console.log('\n  Identity proof ([] vs raw source draw — no JPEG roundtrip allowed):');
  let allPass = true;
  for (const photoId of PHOTOS) {
    const { W, H, px } = photoId === 'portrait' ? makePortrait() : makeLandscape();
    const photoURL = pixelsToDataURL(W, H, px);

    const { srcPNG, resultPNG } = await page.evaluate(async ([photoURL]) => {
      const srcImg = await new Promise((res, rej) => {
        const im = new Image(); im.onload = () => res(im); im.onerror = rej;
        im.src = photoURL;
      });

      // Direct draw of source to canvas A
      const srcCv = document.createElement('canvas');
      srcCv.width = srcImg.naturalWidth; srcCv.height = srcImg.naturalHeight;
      srcCv.getContext('2d').drawImage(srcImg, 0, 0);
      const srcPNG = srcCv.toDataURL('image/png');

      // Apply empty transform list — must call cb(srcImg) with no JPEG roundtrip
      const result = await new Promise((res) => {
        _cropApplyTransforms([], srcImg, res);
      });

      // Draw result to canvas B
      const resCv = document.createElement('canvas');
      resCv.width  = result.naturalWidth  || result.width  || 1;
      resCv.height = result.naturalHeight || result.height || 1;
      resCv.getContext('2d').drawImage(result, 0, 0);
      const resultPNG = resCv.toDataURL('image/png');

      return { srcPNG, resultPNG };
    }, [photoURL]);

    const srcBuf = Buffer.from(srcPNG.replace('data:image/png;base64,', ''), 'base64');
    const resBuf = Buffer.from(resultPNG.replace('data:image/png;base64,', ''), 'base64');
    const mad = computeMAD(srcBuf, resBuf);
    const ok = mad === 0;
    if (!ok) allPass = false;
    console.log(`  ${photoId.padEnd(10)} MAD ${mad.toFixed(4)}${ok ? '  ✓ true identity' : '  ✗ engine silently alters source!'}`);
  }
  return allPass;
}

// ── order-matters proof ────────────────────────────────────────────────────────
// Verifies that straighten_then_crop ≠ crop_then_straighten in the baseline.
// If MAD = 0, the sequencing is not being tested (both produce same output).
function proveOrderMatters(baseDir) {
  console.log('\n  Order-matters proof (straighten→crop vs crop→straighten must differ):');
  let allGood = true;
  for (const photoId of PHOTOS) {
    const fA = path.join(baseDir, `${photoId}__straighten_then_crop.png`);
    const fB = path.join(baseDir, `${photoId}__crop_then_straighten.png`);
    if (!fs.existsSync(fA) || !fs.existsSync(fB)) {
      console.log(`  ${photoId.padEnd(10)} MISSING FILES`);
      allGood = false; continue;
    }
    let mad;
    try { mad = computeMAD(fs.readFileSync(fA), fs.readFileSync(fB)); }
    catch (e) { console.log(`  ${photoId.padEnd(10)} DECODE ERR`); allGood = false; continue; }
    const ok = mad > 0;
    if (!ok) allGood = false;
    console.log(`  ${photoId.padEnd(10)} MAD ${mad.toFixed(4)}${ok ? '  ✓ order changes output' : '  ✗ SAME — ordering not exercised!'}`);
  }
  return allGood;
}

// ── capture mode ──────────────────────────────────────────────────────────────
async function capture(outDir) {
  const { browser, page } = await launchBrowser();
  const total = PHOTOS.length * SEQUENCES.length;
  let count = 0, totalBytes = 0;
  try {
    for (const photoId of PHOTOS) {
      for (const seq of SEQUENCES) {
        const dataURL = await renderCrop(page, photoId, seq.transforms);
        const buf     = Buffer.from(dataURL.replace('data:image/png;base64,', ''), 'base64');
        const name    = `${photoId}__${seq.id}.png`;
        fs.writeFileSync(path.join(outDir, name), buf);
        totalBytes += buf.length;
        count++;
        process.stdout.write(`\r  [${count}/${total}] ${name}          `);
      }
    }
    console.log(`\n  wrote ${count} files · ${(totalBytes / 1024).toFixed(0)} KB total`);
    await proveIdentity(page);
  } finally {
    await browser.close();
  }
  proveOrderMatters(outDir);
}

// ── compare mode ──────────────────────────────────────────────────────────────
async function compare(baseDir, threshold, mutate) {
  const rows = [];
  let failures = 0, maxMAD = 0;
  let identityOk = true;

  {
    const { browser, page } = await launchBrowser();
    try {
      if (mutate) {
        // Patch _cropApplyOne: add 5° to every straighten angle.
        // Sequences without straighten must still pass; those with straighten must fail.
        await page.evaluate(() => {
          const orig = window._cropApplyOne;
          window._cropApplyOne = function(t, srcImg, cb) {
            const patched = (t.op === 'straighten')
              ? Object.assign({}, t, { angle: t.angle + 5 })
              : t;
            return orig.call(this, patched, srcImg, cb);
          };
        });
      }

      for (const photoId of PHOTOS) {
        for (const seq of SEQUENCES) {
          const key      = `${photoId}/${seq.id}`;
          const baseFile = path.join(baseDir, `${photoId}__${seq.id}.png`);
          if (!fs.existsSync(baseFile)) {
            rows.push({ key, madStr: 'MISSING BASELINE', fail: true }); failures++; continue;
          }
          let dataURL;
          try {
            dataURL = await renderCrop(page, photoId, seq.transforms);
          } catch (e) {
            rows.push({ key, madStr: `RENDER ERR: ${String(e.message).slice(0, 50)}`, fail: true });
            failures++; continue;
          }
          const cur  = Buffer.from(dataURL.replace('data:image/png;base64,', ''), 'base64');
          const base = fs.readFileSync(baseFile);
          let mad;
          try { mad = computeMAD(base, cur); }
          catch (e) {
            rows.push({ key, madStr: `DECODE ERR: ${String(e.message).slice(0, 50)}`, fail: true });
            failures++; continue;
          }
          const fail = mad > threshold;
          if (fail) failures++;
          maxMAD = Math.max(maxMAD, mad);
          rows.push({ key, madStr: mad.toFixed(4), fail, note: seq.note });
        }
      }

      if (!mutate) identityOk = await proveIdentity(page);
    } finally {
      await browser.close();
    }
  }

  const PAD = 42;
  console.log(`\n  ${'combo'.padEnd(PAD)} MAD`);
  console.log(`  ${'─'.repeat(PAD + 16)}`);
  for (const r of rows)
    console.log(`  ${r.key.padEnd(PAD)} ${r.madStr}${r.fail ? '  ✗ FAIL' : ''}`);
  console.log(`  ${'─'.repeat(PAD + 16)}`);
  console.log(`  max MAD: ${maxMAD.toFixed(4)}   failures: ${failures}\n`);

  if (!mutate) proveOrderMatters(baseDir);

  return failures === 0 && identityOk;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const [,, cmd, ...argv] = process.argv;
const flags = Object.fromEntries(
  argv.filter(a => a.startsWith('--'))
      .map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; })
);

if (cmd === 'capture') {
  const stamp   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dirName = flags.dir || `crop-baseline-${stamp}`;
  const outDir  = path.resolve(TEST_DIR, dirName);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Capturing ${PHOTOS.length * SEQUENCES.length} crop combos → ${outDir}`);
  console.log(`  Photos: ${PHOTOS.join(', ')}`);
  console.log(`  Sequences:`);
  for (const s of SEQUENCES) console.log(`    ${s.id.padEnd(28)} ${s.note}`);
  console.log('');
  const t0 = Date.now();
  capture(outDir)
    .then(() => console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`))
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });

} else if (cmd === 'compare') {
  const base = flags.baseline;
  if (!base) { console.error('Usage: node test/crop-harness.js compare --baseline=<dir>'); process.exit(1); }
  const baseDir   = path.resolve(TEST_DIR, base);
  const threshold = parseFloat(flags.threshold ?? '0');
  const mutate    = !!flags.mutate;
  if (mutate) console.log('  [mutate] _cropApplyOne: straighten angle += 5° (sequences with straighten must fail)');
  console.log(`Comparing against ${baseDir}  (threshold ${threshold})`);
  const t0 = Date.now();
  compare(baseDir, threshold, mutate)
    .then(ok => { console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`); process.exit(ok ? 0 : 1); })
    .catch(e => { console.error(e); process.exit(1); });

} else {
  console.log('Usage:');
  console.log('  node test/crop-harness.js capture [--dir=NAME]');
  console.log('  node test/crop-harness.js compare --baseline=NAME [--threshold=0] [--mutate]');
  process.exit(1);
}
