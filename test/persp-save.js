'use strict';
// Verify Save commits pending perspective/fisheye/straighten; discard routes still discard.
// Pixel-level assertions: MAD vs a reference save (no transforms) must be clearly non-zero.
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const http = require('http');

const APP_DIR = 'C:/Users/zoeal/zoe-app';
const PORT    = 3013;
const OUT_DIR = path.join(APP_DIR, 'test', 'persp-save-out');

function startServer() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let fp = path.join(APP_DIR, req.url === '/' ? '/index.html' : req.url.split('?')[0]);
      if (!fs.existsSync(fp)) { rsp.writeHead(404); rsp.end(); return; }
      const ext = path.extname(fp).toLowerCase();
      const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css',
        '.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.json':'application/json'}[ext]||'application/octet-stream';
      rsp.writeHead(200,{'Content-Type':mime});
      fs.createReadStream(fp).pipe(rsp);
    });
    srv.listen(PORT,()=>res(srv));
  });
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, {recursive:true});

async function main() {
  const srv = await startServer();
  const browser = await chromium.launch({ headless: true });
  const bCtx = await browser.newContext({ viewport:{width:375,height:812}, acceptDownloads: true });

  // Capture the download anchor href just before click, then fetch the blob
  // on _showSavedToast so we get the ACTUAL exported bytes (not intermediate renders).
  await bCtx.addInitScript(() => {
    window.__lastAnchorHref = null;
    window.__saveResolvers  = [];
    const _origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (this.download && this.href) window.__lastAnchorHref = this.href;
      return _origClick.call(this);
    };
    function patchToast() {
      if (typeof window._showSavedToast === 'undefined') { setTimeout(patchToast, 50); return; }
      const _orig = window._showSavedToast;
      window._showSavedToast = function() {
        _orig && _orig.apply(this, arguments);
        const href     = window.__lastAnchorHref;
        const resolver = window.__saveResolvers.shift();
        if (!resolver) return;
        if (!href) { resolver(null); return; }
        (href.startsWith('blob:')
          ? fetch(href).then(r=>r.blob()).then(blob=>new Promise(res=>{
              const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob);
            }))
          : Promise.resolve(href))
          .then(dataURL => resolver(dataURL))
          .catch(() => resolver(null));
      };
    }
    window.addEventListener('load', patchToast);
  });

  const page = await bCtx.newPage();
  page.setDefaultTimeout(45000);
  await page.goto(`http://localhost:${PORT}/`, {waitUntil:'networkidle'});

  const baseImg = await page.evaluate(async () => {
    const W=480, H=640;
    const cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    const g=cv.getContext('2d');
    const id=g.createImageData(W,H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      const i=(y*W+x)*4; id.data[i]=Math.round(x/W*200+55); id.data[i+1]=Math.round(y/H*200+55); id.data[i+2]=100; id.data[i+3]=255;
    }
    g.putImageData(id,0,0);
    return cv.toDataURL('image/png');
  });

  async function resetState() {
    await page.evaluate(async ([dataURL]) => {
      const img = await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=dataURL;});
      const p = presets.find(x=>x.id==='automat')||presets[0];
      initSliderState(p);
      userImage = img; activePreset = p; evActivePreset = p; presetIntensity = 1;
      library.length = 0;
      library.push({id:'ptest',dataURL,editState:{presetId:p.id,sliders:{},intensity:1,originalDataURL:dataURL}});
      editingIdx = 0;
      _cropSourceImage = img;
      _cropTransforms  = [];
      if(typeof _cropFisheyeVal!=='undefined') _cropFisheyeVal=0;
      if(typeof _cropFisheyeOrig!=='undefined') _cropFisheyeOrig=null;
      if(typeof _cropPerspFlushPending!=='undefined') _cropPerspFlushPending=false;
      if(typeof _etPerspOrigImg!=='undefined') _etPerspOrigImg=null;
      if(typeof _etPerspVVal!=='undefined') _etPerspVVal=0;
      if(typeof _etPerspHVal!=='undefined') _etPerspHVal=0;
      if(typeof _cropStraightenVal!=='undefined') _cropStraightenVal=0;
      if(typeof _cropStraightenOrig!=='undefined') _cropStraightenOrig=null;
      var fw=document.getElementById('crop-fisheye-work'); if(fw) fw.remove();
      var pw=document.getElementById('crop-perspective-work'); if(pw) pw.remove();
      var sw=document.getElementById('crop-straighten-work'); if(sw) sw.remove();
      var gv=document.getElementById('gallery-view'),ev=document.getElementById('editor-view');
      if(gv)gv.style.display='none'; if(ev)ev.style.display='flex';
      var area=document.getElementById('ev-canvas-area');
      if(area){area.style.width='375px';area.style.height='500px';}
      var ac = (typeof getActiveCanvas==='function') ? getActiveCanvas() : document.getElementById('ev-canvas');
      if(ac) { ac.width=375; ac.height=281; ac.getContext('2d').drawImage(img,0,0,375,281); }
    }, [baseImg]);
  }

  function makeFisheyeState() {
    return page.evaluate(async () => {
      _cropFisheyeOrig = userImage;
      _cropFisheyeVal  = 80;
      var ac = (typeof getActiveCanvas==='function') ? getActiveCanvas() : document.getElementById('ev-canvas');
      var fw = document.createElement('canvas');
      fw.id='crop-fisheye-work'; fw.width=100; fw.height=133;
      if(ac && ac.parentElement) ac.parentElement.appendChild(fw);
    });
  }

  function makePerspState() {
    return page.evaluate(async () => {
      var ac = (typeof getActiveCanvas==='function') ? getActiveCanvas() : document.getElementById('ev-canvas');
      var pw = document.createElement('canvas');
      pw.id='crop-perspective-work'; pw.width=375; pw.height=281;
      pw.getContext('2d').drawImage(ac,0,0);
      if(ac && ac.parentElement) ac.parentElement.appendChild(pw);
      _etPerspOrigImg = userImage; _etPerspVVal=30; _etPerspHVal=0;
      var sl=document.getElementById('crop-persp-v-slider');
      if(!sl){sl=document.createElement('input');sl.type='range';sl.id='crop-persp-v-slider';document.body.appendChild(sl);}
      sl.value=30;
      var slh=document.getElementById('crop-persp-h-slider');
      if(!slh){slh=document.createElement('input');slh.type='range';slh.id='crop-persp-h-slider';document.body.appendChild(slh);}
      slh.value=0;
    });
  }

  function makeStraightenState() {
    return page.evaluate(async () => {
      _cropStraightenOrig = userImage;
      _cropStraightenVal  = 5;
      var ac = (typeof getActiveCanvas==='function') ? getActiveCanvas() : document.getElementById('ev-canvas');
      var sw = document.createElement('canvas');
      sw.id='crop-straighten-work'; sw.width=375; sw.height=281;
      sw.getContext('2d').drawImage(ac,0,0);
      if(ac && ac.parentElement) ac.parentElement.appendChild(sw);
    });
  }

  async function doSave(label) {
    const dataURL = await page.evaluate(() => new Promise((res,rej)=>{
      const t=setTimeout(()=>rej(new Error('save timeout')),35000);
      window.__saveResolvers.push(url=>{clearTimeout(t);res(url);});
      _evDoSave();
    }));
    if (dataURL && dataURL.startsWith('data:')) {
      const m = dataURL.match(/^data:[^;]+;base64,(.+)/);
      if (m) fs.writeFileSync(path.join(OUT_DIR,`${label}.jpg`), Buffer.from(m[1],'base64'));
    }
    return dataURL;
  }

  // Decode two dataURLs in the browser, compute MAD over min(w,h) overlap
  async function computeMAD(u1, u2) {
    return page.evaluate(async ([a,b]) => {
      async function pxData(src) {
        const img = await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src;});
        const cv=document.createElement('canvas'); cv.width=img.naturalWidth; cv.height=img.naturalHeight;
        cv.getContext('2d').drawImage(img,0,0);
        return {d:cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data, w:cv.width, h:cv.height};
      }
      const s=await pxData(a), r=await pxData(b);
      const w=Math.min(s.w,r.w), h=Math.min(s.h,r.h);
      let sum=0;
      for(let i=0;i<w*h*4;i+=4)
        sum+=(Math.abs(s.d[i]-r.d[i])+Math.abs(s.d[i+1]-r.d[i+1])+Math.abs(s.d[i+2]-r.d[i+2]))/3;
      return {mad:+(sum/(w*h)).toFixed(2), sw:s.w, sh:s.h, rw:r.w, rh:r.h};
    }, [u1,u2]);
  }

  let allPass = true;
  function pass(msg) { console.log(`  PASS: ${msg}`); }
  function fail(msg) { console.log(`  FAIL: ${msg}`); allPass=false; }

  // ── Reference save (no transforms) ─────────────────────────────────────────
  await resetState();
  const refURL = await doSave('ref_no_transforms');
  console.log(`\nReference save: ${refURL ? (refURL.length+' byte dataURL') : 'null'}`);

  // ── Item 1: Fisheye (no checkmark) → Save ──────────────────────────────────
  console.log('\n=== Item 1: Fisheye (no checkmark) → Save ===');
  await resetState(); await makeFisheyeState();
  const u1 = await doSave('item1_fisheye_nosave');
  const r1 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r1.transforms.some(t=>t.op==='fisheye') ? pass('fisheye in _cropTransforms') : fail('fisheye NOT in _cropTransforms');
  if (u1 && refURL) {
    const m1 = await computeMAD(u1, refURL);
    console.log(`  Dims: saved=${m1.sw}×${m1.sh} ref=${m1.rw}×${m1.rh}  MAD=${m1.mad}`);
    m1.mad > 2 ? pass(`MAD ${m1.mad} clearly non-zero`) : fail(`MAD ${m1.mad} too small — transform may not have reached pixels`);
  } else { fail('no dataURL captured — cannot do pixel check'); }

  // ── Item 2: V-perspective (no checkmark) → Save ────────────────────────────
  console.log('\n=== Item 2: V-perspective (no checkmark) → Save ===');
  await resetState(); await makePerspState();
  const u2 = await doSave('item2_persp_v_nosave');
  const r2 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r2.transforms.some(t=>t.op==='perspective') ? pass('perspective in _cropTransforms') : fail('perspective NOT in _cropTransforms');
  if (u2 && refURL) {
    const m2 = await computeMAD(u2, refURL);
    console.log(`  Dims: saved=${m2.sw}×${m2.sh} ref=${m2.rw}×${m2.rh}  MAD=${m2.mad}`);
    m2.mad > 2 ? pass(`MAD ${m2.mad} clearly non-zero`) : fail(`MAD ${m2.mad} too small`);
  } else { fail('no dataURL captured'); }

  // ── Item 3: Checkmark → Save → one fisheye entry ───────────────────────────
  console.log('\n=== Item 3: Checkmark → Save → no double-commit ===');
  await resetState(); await makeFisheyeState();
  await page.evaluate(()=>new Promise(res=>{ _cropPerspFlush(res); }));
  const fp3 = await doSave('item3_checkmark_then_save');
  const r3 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r3.transforms.filter(t=>t.op==='fisheye').length===1
    ? pass('exactly 1 fisheye after checkmark+save') : fail('Expected 1, got '+JSON.stringify(r3.transforms));

  // ── Item 4: Fisheye → discard → Save → NOT in transforms ───────────────────
  console.log('\n=== Item 4: Fisheye → discard → Save → not in transforms ===');
  await resetState(); await makeFisheyeState();
  await page.evaluate(()=>new Promise(res=>{ _cropPerspDiscard(res); }));
  const u4 = await doSave('item4_discard_then_save');
  const r4 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  !r4.transforms.some(t=>t.op==='fisheye') ? pass('no fisheye after discard+save') : fail('fisheye present after discard');
  if (u4 && refURL) {
    const m4 = await computeMAD(u4, refURL);
    console.log(`  MAD vs ref: ${m4.mad} (should be near 0)`);
    m4.mad < 5 ? pass(`MAD ${m4.mad} near-zero (discard worked)`) : fail(`MAD ${m4.mad} unexpectedly large after discard`);
  }

  // ── Item 5: Straighten (no checkmark) → Save ───────────────────────────────
  console.log('\n=== Item 5: Straighten (no checkmark) → Save ===');
  await resetState(); await makeStraightenState();
  const u5 = await doSave('item5_straighten_nosave');
  const r5 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r5.transforms.filter(t=>t.op==='straighten').length===1
    ? pass('exactly 1 straighten in _cropTransforms') : fail('Expected 1 straighten: '+JSON.stringify(r5.transforms));
  if (u5 && refURL) {
    const m5 = await computeMAD(u5, refURL);
    console.log(`  Dims: saved=${m5.sw}×${m5.sh} ref=${m5.rw}×${m5.rh}  MAD=${m5.mad}`);
    m5.mad > 2 ? pass(`MAD ${m5.mad} clearly non-zero`) : fail(`MAD ${m5.mad} too small`);
    (m5.sw !== m5.rw || m5.sh !== m5.rh)
      ? pass(`dimensions differ: ${m5.sw}×${m5.sh} vs ${m5.rw}×${m5.rh}`)
      : console.log(`  INFO: dimensions unchanged (${m5.sw}×${m5.sh}) — straighten preserves canvas size`);
  } else { fail('no dataURL captured'); }

  // ── Item 6: Checkmark straighten → Save → no double-commit ─────────────────
  console.log('\n=== Item 6: Checkmark straighten → Save → no double-commit ===');
  await resetState(); await makeStraightenState();
  await page.evaluate(()=>new Promise(res=>{ _cropBakeStraighten(res); }));
  const fp6 = await doSave('item6_checkmark_straighten_save');
  const r6 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r6.transforms.filter(t=>t.op==='straighten').length===1
    ? pass('exactly 1 straighten after checkmark+save') : fail('Expected 1: '+JSON.stringify(r6.transforms));

  // ── Item 7: Straighten + Fisheye (neither confirmed) → Save ────────────────
  console.log('\n=== Item 7: Straighten + Fisheye (neither confirmed) → Save → both in transforms ===');
  await resetState(); await makeStraightenState(); await makeFisheyeState();
  const u7 = await doSave('item7_straighten_and_fisheye');
  const r7 = await page.evaluate(()=>({transforms:JSON.parse(JSON.stringify(_cropTransforms))}));
  r7.transforms.filter(t=>t.op==='fisheye').length===1   ? pass('fisheye in transforms')   : fail('fisheye missing');
  r7.transforms.filter(t=>t.op==='straighten').length===1 ? pass('straighten in transforms') : fail('straighten missing');
  if (u7 && refURL) {
    const m7 = await computeMAD(u7, refURL);
    console.log(`  Dims: saved=${m7.sw}×${m7.sh} ref=${m7.rw}×${m7.rh}  MAD=${m7.mad}`);
    m7.mad > 2 ? pass(`MAD ${m7.mad} clearly non-zero`) : fail(`MAD ${m7.mad} too small`);
  } else { fail('no dataURL captured'); }

  console.log('\n' + (allPass ? 'ALL PASS' : 'SOME FAILED'));
  await browser.close();
  srv.close();
  process.exit(allPass ? 0 : 1);
}

main().catch(e=>{console.error(e);process.exit(1);});
