import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    document.body.replaceChildren();
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:320px;height:180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas);
    const pixels = new Uint8Array(16 * 8 * 4);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
      const star = (x * 3 + y * 5) % 7 < 2;
      pixels.set(x < 8 ? star ? [220, 190, 255, 255] : [30, 100, 90, 255] : star ? [70, 140, 240, 255] : [8, 18, 45, 255], (y * 16 + x) * 4);
    }
    const atlas = { pixelsRGBA: pixels, width: 16, height: 8, tiles: [
      { id: 0, x: 0, y: 0, width: 8, height: 8, portalLayers: 15, portalSkyTile: 1 },
      { id: 1, x: 8, y: 0, width: 8, height: 8 },
      { id: 2, x: 0, y: 0, width: 8, height: 8, portalLayers: 16, portalSkyTile: 1 },
    ] };
    renderer.setTextureAtlas(atlas); renderer.configureWorld({ min: [-16, -16, -16], max: [16, 16, 16] });
    const quad = tile => new Float32Array([[-1,-1,0,0,0], [1,-1,0,1,0], [1,1,0,1,1], [-1,-1,0,0,0], [1,1,0,1,1], [-1,1,0,0,1]]
      .flatMap(([x,y,z,u,v]) => [x,y,z,0,0,1,1,1,1,1,u,v,tile,512]));
    const frame = { eye: [0, 0, 4], yaw: 0, pitch: 0, timeSeconds: 1, gameTime: 0n, dayPhase: 0.22, quality: 'low', scale: 1 };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023;
      return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const changed = (a,b) => { let count = 0; for (let i = 0; i < a.pixels.length; i += 4)
      if ([0,1,2].some(c => Math.abs(half(a.pixels[i+c]) - half(b.pixels[i+c])) > 0.005)) count++; return count; };
    const draw = async gameTime => { renderer.render({ ...frame, gameTime }); return renderer.readPixels(); };
    try {
      renderer.uploadChunk('portal', quad(0), [], { min: [-1,-1,0], max: [1,1,0] }, { stride: 14 });
      const initial = await draw(0n), before = renderer.stats(), advanced = await draw(12000n), after = renderer.stats();
      const clockPixels = changed(initial, advanced);
      if (clockPixels < 50) throw new Error(`Native projected portal layers must animate (${clockPixels} pixels).`);
      if (after.shadowUpdates !== before.shadowUpdates || after.meshUploadCount !== before.meshUploadCount)
        throw new Error('Portal animation must preserve terrain geometry and cached shadows.');
      const cycle = await draw(24000n);
      if (changed(initial, cycle) !== 0) throw new Error('Native portal GameTime repeats after 24000 ticks.');
      renderer.uploadChunk('portal', quad(2), [], { min: [-1,-1,0], max: [1,1,0] }, { stride: 14 });
      const gateway = await draw(0n), layerPixels = changed(initial, gateway);
      if (layerPixels < 50) throw new Error('Gateway material must render its sixteenth native layer.');
      const stats = renderer.stats(); if (stats.lastError) throw new Error(stats.lastError);
      return { clockPixels, layerPixels, cyclePixels: changed(initial, cycle), shadowUpdates: [before.shadowUpdates, after.shadowUpdates],
        meshUploads: [before.meshUploadCount, after.meshUploadCount], adapter: stats.adapterInfo, error: stats.lastError };
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true });
  await writeFile('test-results/portal-rendering.json', JSON.stringify({ ...proof, softwareGPU: software }, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
