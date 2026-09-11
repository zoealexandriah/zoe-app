# Render Comparison Harness

Detects pixel-level render drift across the 6 rendering code paths in the ZOË app.

## Prerequisites

- App server running at `http://localhost:3000`
- Node.js with Playwright: `npm install playwright` (or use the globally installed v1.63.0)

## Photos

Two synthetic images generated in memory each run — no files on disk, fully reproducible:

| ID | Size | Description |
|----|------|-------------|
| portrait | 480×640 | Blown highlights top 20%, deep shadows bottom 40%, warm midtones |
| landscape | 640×480 | Blue-sky gradient top 40%, dark-left / sunlit-right earth bottom |

## Presets (4)

| ID | Effects covered |
|----|----------------|
| velvetroom | filmCrossover · CA · strong grain · halation+halationBloom · diffusion · clarity · vignette |
| automat | filmCrossover · textureOverlay · grain · halationBloom · diffusion · clarity · vignette |
| fresco | filmCrossover · CA · halationBloom · grain · diffusion · clarity · vignette |
| havye | filmCrossover · halationBloom · grain · diffusion · clarity · vignette |

## Render Paths (6)

| ID | Code path |
|----|-----------|
| evRenderCanvasImmediate | Live preview canvas (`_evRenderCanvasImmediate`) |
| evDoSave | Save-button full-res export (`_evDoSave`) — grain applied post-upscale |
| evSaveAndReturn | Checkmark save-and-back (`evSaveAndReturn`) |
| renderBatchThumbnail | Gallery thumbnail pipeline (`_renderBatchThumbnail`, max 800px) |
| exportEntry | Batch export pipeline (`_exportEntry`, full res) |
| applyCanvasEffects | Export-modal download (`exportDownload` → `_applyCanvasEffects`, via Web Worker) |

## Usage

### 1. Capture a baseline

```bash
node test/harness.js capture
```

Writes 48 PNGs to `test/baseline-YYYYMMDD/`.

```bash
node test/harness.js capture --dir=my-baseline
```

Writes to `test/my-baseline/` instead.

### 2. Compare against a baseline

```bash
node test/harness.js compare --baseline=baseline-20260911
```

Re-renders all 48 combinations and reports MAD per combo. Exits 0 if all ≤ threshold (default 0), exits 1 if any exceed it.

```bash
node test/harness.js compare --baseline=baseline-20260911 --threshold=0.5
```

## Output

48 PNG files per capture run (2 photos × 4 presets × 6 paths).  
Filename pattern: `{photo}__{preset}__{path}.png`

**MAD** = mean absolute difference per RGB channel (0–255 scale).  
`0.0000` = pixel-identical output between runs.

## How it works

- Playwright drives a headless Chromium at 375×812 (mobile viewport)
- Canvas `toDataURL` and `toBlob` are hooked at page-load time to intercept the lossless PNG before any JPEG encoding occurs
- Grain uses a seeded XORShift32 PRNG (seed patched over `Math.random` per render) for reproducibility
- Each of the 6 paths calls the real app function — no synthetic replicas — so code changes are accurately detected
- PNG encode/decode runs in pure Node.js (zlib + CRC32) with no native add-ons
