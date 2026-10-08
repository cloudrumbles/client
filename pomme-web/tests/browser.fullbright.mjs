import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 160, height: 160 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), color = [.5, .25, .125], flags = 32 | 512 | 16777216;
    const points = [[0,0,0],[1,0,0],[1,1,0],[0,0,0],[1,1,0],[0,1,0]];
    const vertices = new Float32Array(points.flatMap(position => [...position,0,0,1,...color,1,0,0,0,flags]));
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    try {
      renderer.setTextureAtlas({ pixelsRGBA: new Uint8Array([255,255,255,255]), width: 1, height: 1,
        tiles: [{ id: 0, name: 'test:glyph', x: 0, y: 0, width: 1, height: 1 }] });
      renderer.configureWorld({ min: [0,0,-1], max: [1,1,1], hasSkylight: true, fogDensity: 0 });
      renderer.uploadDynamicMesh('fullbright-glyph', vertices, [], { min: [0,0,0], max: [1,1,0] }, { stride: 14 });
      const samples = [];
      for (const dayPhase of [.25, .75, .05]) {
        const frame = { eye: [.5,.5,2], yaw: 0, pitch: 0, dayPhase, timeSeconds: 10, quality: 'low', scale: 1 };
        renderer.render(frame); renderer.render(frame);
        const image = await renderer.readPixels(), index = ((Math.floor(image.height / 2) * image.width) + Math.floor(image.width / 2)) * 4;
        samples.push([...image.pixels.subarray(index, index + 3)].map(half));
      }
      for (const sample of samples) for (let axis = 0; axis < 3; axis++) if (Math.abs(sample[axis] - color[axis]) > .001) throw new Error(`Full-bright glyph acquired sunlight or material emission: ${JSON.stringify(samples)}`);
      if (renderer.stats().lastError) throw new Error(renderer.stats().lastError);
      return { samples, expectedAlbedo: color, packedFlags: [...new Set(vertices.filter((_value, index) => index % 14 === 13))], adapter: renderer.stats().adapterInfo };
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/fullbright.json', JSON.stringify({ ...proof, softwareGPU: software, errors }, null, 2));
  console.log(JSON.stringify(proof));
} finally { await browser.close(); }
