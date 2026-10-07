import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Exercise real GPU passes independently of the application/worker boot. HDR
// readback uses copyTextureToBuffer: canvas2d snapshots of a presented WebGPU
// canvas can be blank and must not be mistaken for rendering evidence.
const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  const base = process.env.POMME_URL ?? 'http://127.0.0.1:5173';
  await page.goto(new URL('/src/shaders/world.wgsl', base).href);
  const result = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    document.body.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.style.width = '320px'; canvas.style.height = '180px';
    document.body.append(canvas);
    const renderer = await createRenderer(canvas);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const lit = 512 | (15 << 10);
    const quad = (positions, normal, color, flags = 0, tile = -1) => positions.flatMap((position, index) => [
      ...position, ...normal, ...color, 1, index % 2, index % 3, tile, flags | lit,
    ]);
    const top = (y, radius = 6) => [[-radius, y, -radius], [-radius, y, radius], [radius, y, radius], [-radius, y, -radius], [radius, y, radius], [radius, y, -radius]];
    const frame = { eye: [0, 2, 4], yaw: 0, pitch: -0.35, timeSeconds: 10, dayPhase: 0.22, quality: 'balanced', scale: 1 };
    const wall = [[-1.5, 0, -2], [1.5, 0, -2], [1.5, 3, -2], [-1.5, 0, -2], [1.5, 3, -2], [-1.5, 3, -2]];
    const ground = new Float32Array(quad(top(-0.5), [0, 1, 0], [0.2, 0.6, 0.2]));
    const wallBack = [wall[0], wall[2], wall[1], wall[3], wall[5], wall[4]];
    const redWall = new Float32Array([...quad(wall, [0, 0, 1], [1, 0.015, 0.01], 8 | 1), ...quad(wallBack, [0, 0, -1], [1, 0.015, 0.01], 8 | 1)]);
    const water = new Float32Array(quad(top(0), [0, 1, 0], [0.1, 0.3, 0.5], 4));
    const opaque = new Float32Array([...ground, ...redWall]);
    const bounds = { min: [-6, -0.5, -6], max: [6, 3, 6] };
    const halfFloat = bits => {
      const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, mantissa = bits & 1023;
      return sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15));
    };
    const draw = async options => { renderer.render(options); const image = await renderer.readPixels(); check(renderer.stats().lastError === null, renderer.stats().lastError); return image; };
    const centerRGB = image => {
      const index = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
      return Array.from(image.pixels.subarray(index, index + 3), halfFloat);
    };

    try {
      renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8] });
      renderer.uploadChunk('scene', opaque, water, bounds, { stride: 14 });
      await draw(frame); await draw(frame);
      check(renderer.stats().historyUsed, 'A stable scene must accumulate temporal history.');
      const cached = renderer.stats();
      await draw(frame);
      check(renderer.stats().shadowUpdates === cached.shadowUpdates, 'Jitter must not invalidate cached shadows.');
      check(renderer.stats().skyCacheUpdates === cached.skyCacheUpdates, 'Frozen sky must reuse its environment map.');
      check(renderer.stats().meshUploadCount === cached.meshUploadCount, 'Rendering must not upload stable geometry.');

      // Streamed terrain outside the cached light frustum cannot alter its
      // depth. Root revision counters still change as meshes arrive, so they
      // must not override the renderer's actual caster-coverage decision.
      const cachedDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      const distantWall = redWall.slice();
      for (let vertex = 0; vertex < distantWall.length; vertex += 14) distantWall[vertex] += 320;
      const distantBounds = { min: [318.5, 0, -2], max: [321.5, 3, -2] };
      renderer.uploadChunk('streamed-caster', distantWall, [], distantBounds, { stride: 14 });
      await draw({ ...frame, revision: 1 });
      check(renderer.stats().shadowUpdates === cached.shadowUpdates, 'Outside streamed casters must preserve cached shadow work despite root revision changes.');
      const outsideDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      check(outsideDepth.every((value, index) => value === cachedDepth[index]), 'Outside uploads must retain actual cached GPU depth.');
      const nearbyWall = redWall.slice();
      for (let vertex = 0; vertex < nearbyWall.length; vertex += 14) nearbyWall[vertex] += 0.5;
      const nearbyBounds = { min: [-1, 0, -2], max: [2, 3, -2] };
      renderer.uploadChunk('streamed-caster', nearbyWall, [], nearbyBounds, { stride: 14 });
      await draw({ ...frame, revision: 2 });
      check(renderer.stats().shadowUpdates === cached.shadowUpdates + 1 && renderer.stats().lastShadowReason === 'world edit', 'A new caster inside cached coverage must rebuild static shadows.');
      const insideDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      let streamedShadowPixels = 0;
      for (let index = 0; index < insideDepth.length; index++) if (insideDepth[index] < cachedDepth[index] - 0.000001) streamedShadowPixels++;
      check(streamedShadowPixels > 20, 'Visible streamed casters must produce actual new shadow depth.');
      renderer.uploadChunk('streamed-caster', distantWall, [], distantBounds, { stride: 14 });
      await draw({ ...frame, revision: 3 });
      check(renderer.stats().shadowUpdates === cached.shadowUpdates + 2, 'Moving a caster outside coverage must invalidate its old covered bounds.');
      const movedOutsideDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      check(movedOutsideDepth.every((value, index) => value === cachedDepth[index]), 'Moving away must remove the cached caster silhouette.');
      renderer.removeChunk('streamed-caster'); await draw({ ...frame, revision: 4 });
      check(renderer.stats().shadowUpdates === cached.shadowUpdates + 2, 'Removing an outside caster must preserve cached shadow work.');

      // Actual terrain SSR: hold every other render setting constant, then
      // compare water pixels with depth tracing enabled versus environment only.
      const reflectionOff = await draw({ ...frame, reflections: false });
      const reflectionOn = await draw({ ...frame, reflections: true });
      let reflectedPixels = 0;
      for (let y = 95; y < 170; y++) for (let x = 20; x < 300; x++) {
        const index = (y * reflectionOn.width + x) * 4;
        let difference = 0;
        for (let channel = 0; channel < 3; channel++) difference += Math.abs(halfFloat(reflectionOff.pixels[index + channel]) - halfFloat(reflectionOn.pixels[index + channel]));
        if (difference > 0.005) reflectedPixels++;
      }
      check(reflectedPixels > 100, `On-screen terrain must contribute to water reflections (${reflectedPixels} changed pixels).`);

      // History cannot survive geometry edits, a teleport, a lighting jump,
      // an atlas replacement, or new resolution-dependent render targets.
      await draw(frame);
      renderer.uploadChunk('scene', opaque, water, bounds, { stride: 14 });
      await draw(frame); check(!renderer.stats().historyUsed && renderer.stats().lastTemporalReset === 'world edit', 'Edits must reject old history.');
      await draw(frame); await draw({ ...frame, eye: [20, 10, 4] });
      check(!renderer.stats().historyUsed && renderer.stats().lastTemporalReset === 'camera cut', 'Camera cuts must reject old history.');
      await draw({ ...frame, eye: [20, 10, 4], dayPhase: 0.75 });
      check(!renderer.stats().historyUsed && renderer.stats().lastTemporalReset === 'day phase jump', 'Day jumps must reject old history.');
      renderer.resize(0.7); await draw({ ...frame, scale: 0.7 });
      check(!renderer.stats().historyUsed && renderer.stats().temporalUpscaling, 'Resolution changes must restart temporal upscaling.');
      check(renderer.stats().historyResolution[0] === 320 && renderer.stats().renderWidth === 224, 'Temporal history must resolve to output resolution.');

      const beforeDynamic = renderer.stats().shadowUpdates;
      const staticDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      const entity = redWall.slice(); for (let vertex = 0; vertex < entity.length; vertex += 14) entity[vertex] += 0.5;
      renderer.uploadDynamicMesh('entity', entity, [], bounds, { stride: 14 });
      await draw({ ...frame, scale: 0.7 });
      const dynamicBytes = renderer.stats().dynamicGeometryBytes;
      const dynamicDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      let shadowPixels = 0;
      for (let index = 0; index < staticDepth.length; index++) if (dynamicDepth[index] < staticDepth[index] - 0.000001) shadowPixels++;
      check(shadowPixels > 20 && renderer.stats().dynamicShadowUpdates > 0, 'Entities must contribute actual dynamic shadow depth.');
      const moved = entity.slice(); for (let vertex = 0; vertex < moved.length; vertex += 14) moved[vertex] += 0.1;
      renderer.uploadDynamicMesh('entity', moved, [], bounds, { stride: 14 });
      await draw({ ...frame, scale: 0.7 });
      check(renderer.stats().shadowUpdates === beforeDynamic, 'Animated entities must not rebuild static terrain shadows.');
      check(renderer.stats().dynamicGeometryBytes === dynamicBytes && renderer.stats().entityTriangles > 0, 'Dynamic meshes must reuse GPU capacity and render.');
      renderer.removeMesh('entity'); await draw({ ...frame, scale: 0.7 });
      const removedDepth = (await renderer.readPixels({ source: 'shadow' })).pixels;
      check(removedDepth.every((value, index) => value === staticDepth[index]), 'Removing entities must remove their shadow silhouettes.');
      renderer.removeChunk('scene');

      // Atlas sampling must change the rendered surface, not only metadata.
      const plane = new Float32Array(quad(top(0, 4), [0, 1, 0], [1, 1, 1], 0, 0));
      const setColor = rgba => renderer.setTextureAtlas({ pixels: new Uint8Array(rgba), width: 1, height: 1, tiles: [{ id: 0, x: 0, y: 0, width: 1, height: 1 }] });
      const planeFrame = { ...frame, eye: [0, 3, 5], pitch: -0.5, quality: 'low', scale: 1 };
      renderer.uploadChunk('plane', plane, [], { min: [-4, 0, -4], max: [4, 0.1, 4] }, { stride: 14 });
      setColor([0, 255, 0, 255]); const green = centerRGB(await draw(planeFrame));
      setColor([255, 0, 0, 255]); const red = centerRGB(await draw(planeFrame));
      check(green[1] > green[0] * 3 && red[0] > red[1] * 3, 'Minecraft atlas texels must reach the GPU surface.');
      renderer.setTextureAtlas({
        pixels: new Uint8Array([0, 255, 0, 255]), width: 1, height: 1,
        tiles: [{ id: 0, x: 0, y: 0, width: 1, height: 1 }],
        animations: [{ tile: 0, width: 1, height: 1, frames: [new Uint8Array([0, 255, 0, 255]), new Uint8Array([255, 0, 0, 255])], durationsTicks: [1, 1], interpolate: false }],
      });
      const animatedGreen = centerRGB(await draw({ ...planeFrame, timeSeconds: 0 }));
      const animatedCache = renderer.stats();
      await draw({ ...planeFrame, timeSeconds: 0 });
      check(renderer.stats().animationUpdates === animatedCache.animationUpdates, 'Frozen animation frames must not upload textures again.');
      const animatedRed = centerRGB(await draw({ ...planeFrame, timeSeconds: 0.051 }));
      check(animatedGreen[1] > animatedGreen[0] * 3 && animatedRed[0] > animatedRed[1] * 3, 'Native texture frames must change actual GPU pixels.');
      check(renderer.stats().meshUploadCount === animatedCache.meshUploadCount && renderer.stats().shadowUpdates === animatedCache.shadowUpdates, 'Texture animation must preserve mesh and shadow caches.');

      // BLEND materials belong in a depth-tested alpha pass. A blue pane must
      // preserve the red terrain behind it and must not cast an opaque shadow.
      setColor([255, 255, 255, 255]);
      const redPlane = new Float32Array(quad(top(0, 4), [0, 1, 0], [1, 0.01, 0.01], 1, 0));
      const blueGlass = new Float32Array(quad(top(1, 4), [0, 1, 0], [0.01, 0.01, 0.8], 64, 0));
      renderer.uploadChunk('plane', redPlane, [], { min: [-4, 0, -4], max: [4, 0.1, 4] }, { stride: 14 });
      const behindGlass = centerRGB(await draw(planeFrame));
      const noGlassShadow = (await renderer.readPixels({ source: 'shadow' })).pixels;
      renderer.uploadChunk('plane', new Float32Array([...redPlane, ...blueGlass]), [], { min: [-4, 0, -4], max: [4, 1.1, 4] }, { stride: 14 });
      const throughGlass = centerRGB(await draw(planeFrame));
      const glassShadow = (await renderer.readPixels({ source: 'shadow' })).pixels;
      const backgroundFraction = throughGlass[0] / behindGlass[0];
      check(backgroundFraction > 0.3 && backgroundFraction < 0.8 && throughGlass[2] > behindGlass[2] + 0.1, 'Translucent materials must blend with visible opaque terrain.');
      check(renderer.stats().translucentTriangles === 2 && glassShadow.every((value, index) => value === noGlassShadow[index]), 'Glass must render separately and avoid opaque shadow depth.');

      // The same local geometry at the world border must remain visible and
      // match the origin image. Require colored pixels to avoid blank evidence.
      setColor([160, 220, 80, 255]);
      const images = [];
      for (const originX of [0, 30_000_000]) {
        renderer.configureWorld({ min: [originX - 128, -64, -128], max: [originX + 128, 320, 128] });
        renderer.uploadChunk('plane', plane, [], { min: [originX - 4, 0, -4], max: [originX + 4, 0.1, 4] }, { stride: 14, origin: [originX, 0, 0] });
        images.push(await draw({ ...planeFrame, eye: [originX, 3, 5] }));
      }
      let maximumHDRDifference = 0, coloredPixels = 0;
      for (let index = 0; index < images[0].pixels.length; index++) {
        if (index % 4 === 3) continue;
        const a = halfFloat(images[0].pixels[index]), b = halfFloat(images[1].pixels[index]);
        maximumHDRDifference = Math.max(maximumHDRDifference, Math.abs(a - b));
        if (a > 0.02) coloredPixels++;
      }
      check(coloredPixels > 10_000, 'Precision comparison requires a nonblank GPU image.');
      check(renderer.stats().visibleChunks === 1 && maximumHDRDifference < 0.003, `World-border geometry must match origin rendering (${maximumHDRDifference}).`);

      // Lava shares the fluid bucket, but must stay warm and emissive in a
      // dimension with no skylight instead of taking blue water shading.
      renderer.removeChunk('plane');
      renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8], hasSkylight: false });
      const lava = new Float32Array(quad(top(0, 4), [0, 1, 0], [1, 0.3, 0.025], 4 | 8));
      renderer.uploadChunk('lava', [], lava, { min: [-4, 0, -4], max: [4, 0.1, 4] }, { stride: 14 });
      const lavaRGB = centerRGB(await draw(planeFrame));
      check(lavaRGB[0] > 1 && lavaRGB[0] > lavaRGB[2] * 4 && !renderer.stats().hasSkylight, 'Lava must remain warm HDR emission without skylight.');
      renderer.configureWorld({ min: [-8, -4, -8], max: [8, 8, 8], hasSkylight: true });
      await draw({ ...planeFrame, quality: 'high' });
      check(renderer.stats().volumetricCloudSteps === 6 && renderer.stats().lastError === null, 'High quality pipelines must validate.');
      return { reflectedPixels, streamedShadowPixels, shadowPixels, backgroundFraction, maximumHDRDifference, coloredPixels, lavaRGB, temporalResets: renderer.stats().temporalResets, adapterInfo: renderer.stats().adapterInfo };
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors, [], 'No JavaScript or WebGPU validation errors.');
  console.log(JSON.stringify({ validation: 'passed', softwareGPU: software, ...result }, null, 2));
} finally { await browser.close(); }
