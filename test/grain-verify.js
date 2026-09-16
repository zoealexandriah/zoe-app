'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const PORT = 3067;

const EXPORT_SIZES = [1200, 2400, 4000];

const srv = http.createServer((req, rsp) => {
  let fp = path.join('C:/Users/zoeal/zoe-app', req.url === '/' ? '/index.html' : req.url.split('?')[0]);
  if (!fs.existsSync(fp)) { rsp.writeHead(404); rsp.end(); return; }
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css',
    '.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(fp)]||'application/octet-stream';
  rsp.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'no-cache'});
  fs.createReadStream(fp).pipe(rsp);
});

srv.listen(PORT, async () => {
  const br  = await chromium.launch({ headless: true });
  const ctx = await br.newContext({ viewport: { width: 375, height: 812 } });
  const page = await ctx.newPage();
  await page.goto('http://localhost:' + PORT + '/', { waitUntil: 'networkidle' });

  // Find highest-GRAIN preset
  const presetInfo = await page.evaluate(() => {
    const best = presets.reduce((b, p) => {
      const g = (p.defaults && p.defaults.GRAIN != null) ? p.defaults.GRAIN : 0;
      return g > b.grain ? { id: p.id, name: p.name, grain: g, grainSize: p.grainSize } : b;
    }, { id: null, name: null, grain: 0, grainSize: null });
    return best;
  });
  console.log('Preset: ' + presetInfo.name + ' (GRAIN=' + presetInfo.grain + ' grainSize=' + presetInfo.grainSize + ')');

  // Build flat mid-grey test image 480x640
  const dataURL = await page.evaluate(() => {
    const C = document.createElement('canvas'); C.width = 480; C.height = 640;
    C.getContext('2d').fillStyle = '#888';
    C.getContext('2d').fillRect(0, 0, 480, 640);
    return C.toDataURL('image/jpeg', 0.92);
  });

  // Open image and apply preset
  await page.evaluate(async ([durl, pid]) => {
    const img = await new Promise((res,rej) => { const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=durl; });
    library.length = 0;
    library.push({ id:'t1', dataURL: durl, img });
    galleryOpenInEditor(0);
    await new Promise(r => setTimeout(r, 600));
    const p = presets.find(x => x.id === pid);
    if (p && typeof applyLookToUserImage === 'function') {
      applyLookToUserImage(p.id);
      await new Promise(r => setTimeout(r, 500));
    }
  }, [dataURL, presetInfo.id]);
  await page.waitForTimeout(1200);

  // ── Editor stdDev (reference) ─────────────────────────────────────────────
  const editorResult = await page.evaluate(() => {
    function patchSample(canvas) {
      const cx = Math.floor(canvas.width / 2), cy = Math.floor(canvas.height / 2);
      const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx2.getImageData(cx - 20, cy - 20, 40, 40).data;
      let sum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) { const lum = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; sum+=lum; count++; }
      const mean = sum / count;
      let varSum = 0;
      for (let i = 0; i < data.length; i += 4) { const lum = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; varSum+=(lum-mean)*(lum-mean); }
      return { stdDev: Math.sqrt(varSum/count).toFixed(3), w: canvas.width, h: canvas.height };
    }

    if (typeof _evRenderCanvasImmediate === 'function') _evRenderCanvasImmediate();
    const edCanvas = document.getElementById('ev-canvas');
    if (!edCanvas) return { error: 'no ev-canvas' };

    // Also capture a 1:1 crop from editor for before/after comparison
    const cropW = 200, cropH = 200;
    const cx = Math.floor(edCanvas.width/2), cy = Math.floor(edCanvas.height/2);
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW; cropCanvas.height = cropH;
    cropCanvas.getContext('2d').drawImage(edCanvas, cx-cropW/2, cy-cropH/2, cropW, cropH, 0, 0, cropW, cropH);

    return {
      stats: patchSample(edCanvas),
      cropDataURL: cropCanvas.toDataURL('image/png')
    };
  });
  console.log('\n── Editor ──');
  console.log(JSON.stringify(editorResult.stats));
  const editorStdDev = parseFloat(editorResult.stats.stdDev);
  const edW = editorResult.stats.w, edH = editorResult.stats.h;

  // Save editor crop
  const editorCropBase64 = editorResult.cropDataURL.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync('C:/Users/zoeal/zoe-app/test/grain-editor-crop.png', Buffer.from(editorCropBase64, 'base64'));
  console.log('Editor crop saved: grain-editor-crop.png (' + edW + 'x' + edH + ')');

  // ── Export stdDev at each size ────────────────────────────────────────────
  const exportResults = await page.evaluate(async ([sizes, edW, edH, pid]) => {
    function patchSample(canvas) {
      const cx = Math.floor(canvas.width / 2), cy = Math.floor(canvas.height / 2);
      const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx2.getImageData(cx - 20, cy - 20, 40, 40).data;
      let sum = 0, count = 0;
      for (let i = 0; i < data.length; i += 4) { const lum = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; sum+=lum; count++; }
      const mean = sum / count;
      let varSum = 0;
      for (let i = 0; i < data.length; i += 4) { const lum = 0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; varSum+=(lum-mean)*(lum-mean); }
      return { stdDev: Math.sqrt(varSum/count).toFixed(3), w: canvas.width, h: canvas.height };
    }

    const p = activePreset;
    if (!p || !userImage) return { error: 'no preset/image' };
    const st = sliderState[p.id];
    const merged = _evMergeAdjState(p, st);
    const adj = buildAdjustments(merged);
    const exportGrain = adj.grain || 0;
    adj.grain = 0;
    const intensity = (typeof presetIntensity !== 'undefined') ? presetIntensity : 1.0;
    const grainSize = p.grainSize || 1;

    const results = [];
    for (const targetLong of sizes) {
      const nw = userImage.naturalWidth, nh = userImage.naturalHeight;
      const scale = targetLong / Math.max(nw, nh);
      const pw = Math.round(nw * scale), ph = Math.round(nh * scale);

      const proxy = document.createElement('canvas');
      proxy.width = pw; proxy.height = ph;
      const pCtx = proxy.getContext('2d');
      pCtx.drawImage(userImage, 0, 0, pw, ph);

      // Apply same pixel adjustments as export
      const adjCopy = Object.assign({}, adj);
      const origData = pCtx.getImageData(0, 0, pw, ph);
      const processed = applyPixelAdjustments(origData, adjCopy);
      pCtx.putImageData(new ImageData(processed, pw, ph), 0, 0);

      // Apply grain
      if (exportGrain > 0.005) applyFilmGrain(proxy, exportGrain * intensity, grainSize);

      // Measure at export resolution
      const exportStats = patchSample(proxy);

      // Downscale to editor canvas size and measure
      const ds = document.createElement('canvas');
      ds.width = edW; ds.height = edH;
      ds.getContext('2d').drawImage(proxy, 0, 0, edW, edH);
      const dsStats = patchSample(ds);

      // Save a 1:1 crop at 200x200 from center of export (for 2400px only)
      let cropDataURL = null;
      if (targetLong === 2400) {
        const cropW = 200, cropH = 200;
        const cx = Math.floor(proxy.width/2), cy = Math.floor(proxy.height/2);
        const cropC = document.createElement('canvas');
        cropC.width = cropW; cropC.height = cropH;
        cropC.getContext('2d').drawImage(proxy, cx-cropW/2, cy-cropH/2, cropW, cropH, 0, 0, cropW, cropH);
        cropDataURL = cropC.toDataURL('image/png');
      }

      // Compute cell size for reporting
      const cellRef = window.ZGRAIN ? window.ZGRAIN.cellRef : 500;
      const cell = Math.max(1, (Math.max(pw, ph) / cellRef) * grainSize);

      results.push({ targetLong, pw, ph, exportStats, dsStats, cell: cell.toFixed(2), cropDataURL });
    }
    return { results, exportGrain, intensity, grainSize, cellRef: window.ZGRAIN ? window.ZGRAIN.cellRef : null };
  }, [EXPORT_SIZES, edW, edH, presetInfo.id]);

  console.log('\n── Export results (downscaled to ' + edW + 'x' + edH + ' editor size) ──');
  console.log('exportGrain=' + exportResults.exportGrain + ' intensity=' + exportResults.intensity + ' grainSize=' + exportResults.grainSize);
  for (const r of exportResults.results) {
    const nativeRatio = (parseFloat(r.exportStats.stdDev) / editorStdDev * 100).toFixed(1);
    const dsRatio = (parseFloat(r.dsStats.stdDev) / editorStdDev * 100).toFixed(1);
    const pass = Math.abs(parseFloat(nativeRatio) - 100) <= 20 ? 'PASS' : 'FAIL';
    console.log(r.targetLong + 'px: cell=' + r.cell + 'px | native stdDev=' + r.exportStats.stdDev +
      ' (' + nativeRatio + '% [' + pass + ']) | downscaled=' + r.dsStats.stdDev + ' (' + dsRatio + '%)');

    if (r.cropDataURL) {
      const b64 = r.cropDataURL.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync('C:/Users/zoeal/zoe-app/test/grain-export-2400-crop.png', Buffer.from(b64, 'base64'));
      console.log('Export 2400px crop saved: grain-export-2400-crop.png');
    }
  }

  // ── GRAIN=0 check ─────────────────────────────────────────────────────────
  const zeroGrainResult = await page.evaluate(() => {
    function patchSample(canvas) {
      const cx = Math.floor(canvas.width/2), cy = Math.floor(canvas.height/2);
      const ctx2 = canvas.getContext('2d', { willReadFrequently: true });
      const data = ctx2.getImageData(cx-20, cy-20, 40, 40).data;
      let sum=0, count=0;
      for (let i=0;i<data.length;i+=4){const lum=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];sum+=lum;count++;}
      const mean=sum/count; let v=0;
      for (let i=0;i<data.length;i+=4){const lum=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];v+=(lum-mean)*(lum-mean);}
      return Math.sqrt(v/count).toFixed(3);
    }

    // Simulate export with GRAIN=0
    if (!userImage || !activePreset) return { error: 'no image/preset' };
    const p = activePreset;
    const st = sliderState[p.id];
    const merged = _evMergeAdjState(p, st);
    // Override GRAIN to 0
    merged['GRAIN'] = 0;
    const adj = buildAdjustments(merged);
    const exportGrain = adj.grain || 0;

    const nw = userImage.naturalWidth, nh = userImage.naturalHeight;
    const scale = 2400 / Math.max(nw, nh);
    const pw = Math.round(nw * scale), ph = Math.round(nh * scale);
    const proxy = document.createElement('canvas');
    proxy.width = pw; proxy.height = ph;
    proxy.getContext('2d').drawImage(userImage, 0, 0, pw, ph);

    // Do NOT call applyFilmGrain (exportGrain should be 0)
    if (exportGrain > 0.005) applyFilmGrain(proxy, exportGrain, p.grainSize || 1);

    const stdDev = patchSample(proxy);
    return { exportGrain, stdDev, pass: parseFloat(stdDev) < 0.5 ? 'PASS' : 'FAIL' };
  });
  console.log('\n── GRAIN=0 check ──');
  console.log(JSON.stringify(zeroGrainResult));

  // ── Effect harness baseline ───────────────────────────────────────────────
  // Re-render editor and save a full screenshot for harness comparison
  const harnessResult = await page.evaluate(() => {
    if (typeof _evRenderCanvasImmediate === 'function') _evRenderCanvasImmediate();
    const edCanvas = document.getElementById('ev-canvas');
    if (!edCanvas) return null;
    return { dataURL: edCanvas.toDataURL('image/png'), w: edCanvas.width, h: edCanvas.height };
  });
  if (harnessResult) {
    const b64 = harnessResult.dataURL.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync('C:/Users/zoeal/zoe-app/test/grain-harness-baseline.png', Buffer.from(b64, 'base64'));
    console.log('\nHarness baseline saved: grain-harness-baseline.png (' + harnessResult.w + 'x' + harnessResult.h + ')');
  }

  console.log('\n── Summary ──');
  console.log('cellRef=' + (exportResults.cellRef || '?') + ' | editor stdDev=' + editorStdDev);
  for (const r of exportResults.results) {
    const nativeRatio = (parseFloat(r.exportStats.stdDev) / editorStdDev * 100).toFixed(1);
    const pass = Math.abs(parseFloat(nativeRatio) - 100) <= 20 ? 'PASS' : 'FAIL';
    console.log('  ' + r.targetLong + 'px: cell=' + r.cell + 'px native-stdDev=' + r.exportStats.stdDev + ' ' + nativeRatio + '% [' + pass + ']');
  }

  await br.close();
  srv.close();
});
