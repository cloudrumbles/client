import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    document.body.replaceChildren();
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:256px;height:144px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas);
    let worldBounds = { min: [-32, -16, -32], max: [32, 16, 32] };
    const frame = { eye: [0, 0, 0], yaw: 0, pitch: 0, timeSeconds: 1, gameTime: 20n, dayPhase: .22, quality: 'low', scale: 1 };
    const atlas = rgba => ({ pixelsRGBA: new Uint8Array(rgba), width: 1, height: 1, tiles: [{ id: 0, x: 0, y: 0, width: 1, height: 1 }] });
    const cube = (x, z, { size = 1.8, tile = 0, flags = 15872, color = [1, 1, 1] } = {}) => {
      const l = x - size / 2, r = x + size / 2, b = -size / 2, t = size / 2, n = z - size / 2, f = z + size / 2;
      const faces = [
        [[[l,b,f],[r,b,f],[r,t,f],[l,t,f]],[0,0,1]], [[[r,b,n],[l,b,n],[l,t,n],[r,t,n]],[0,0,-1]],
        [[[l,t,f],[r,t,f],[r,t,n],[l,t,n]],[0,1,0]], [[[l,b,n],[r,b,n],[r,b,f],[l,b,f]],[0,-1,0]],
        [[[r,b,f],[r,b,n],[r,t,n],[r,t,f]],[1,0,0]], [[[l,b,n],[l,b,f],[l,t,f],[l,t,n]],[-1,0,0]],
      ];
      const vertices = [];
      for (const [points, normal] of faces) for (const i of [0,1,2,0,2,3]) vertices.push(...points[i], ...normal, ...color, 1, i === 1 || i === 2 ? 1 : 0, i >= 2 ? 1 : 0, tile, flags);
      return { vertices: new Float32Array(vertices), bounds: { min: [l,b,n], max: [r,t,f] } };
    };
    const upload = (key, mesh) => renderer.uploadChunk(key, mesh.vertices, [], mesh.bounds, { stride: 14 });
    const capture = async (options = {}, terrainBundles = true, reset = false) => {
      if (reset) renderer.configureWorld(worldBounds);
      renderer.render({ ...frame, ...options, terrainBundles });
      const hdr = await renderer.readPixels(), depth = await renderer.readPixels({ source: 'depth' });
      return { hdr, depth, stats: renderer.stats() };
    };
    const mismatch = (a, b) => { if (a.length !== b.length) throw new Error('Diagnostic image dimensions differ.'); let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
    const comparisons = [];
    const parity = async (name, options = {}) => {
      const cached = await capture(options, true, true);
      const shadow = name === 'initial terrain' || name.startsWith('dynamic shadow') ? await renderer.readPixels({ source: 'shadow' }) : null;
      const direct = await capture(options, false, true);
      const hdrMismatches = mismatch(cached.hdr.pixels, direct.hdr.pixels), depthMismatches = mismatch(cached.depth.pixels, direct.depth.pixels);
      if (hdrMismatches || depthMismatches) throw new Error(`${name}: bundled/direct HDR differs at ${hdrMismatches} components and depth at ${depthMismatches} pixels.`);
      const shadowMismatches = shadow ? mismatch(shadow.pixels, (await renderer.readPixels({ source: 'shadow' })).pixels) : null;
      if (shadowMismatches) throw new Error(`${name}: bundled/direct cached shadow depth differs at ${shadowMismatches} pixels.`);
      comparisons.push({ name, hdrMismatches, depthMismatches, shadowMismatches, visibleChunks: cached.stats.visibleChunks });
      return cached;
    };
    try {
      renderer.setTextureAtlas(atlas([230, 140, 70, 255])); renderer.configureWorld(worldBounds);
      upload('near', cube(0, -4));
      for (let i = 0; i < 16; i++) { const angle = i / 16 * Math.PI * 2; upload(`ring:${i}`, cube(Math.sin(angle) * 12, Math.cos(angle) * 12)); }
      const initial = await parity('initial terrain');
      if (!initial.depth.pixels.some(depth => depth < .999)) throw new Error('The terrain fixture must write actual world depth.');
      const beforeStable = renderer.stats(); renderer.render(frame); const afterStable = renderer.stats();
      if (afterStable.terrainBundleEncodes !== beforeStable.terrainBundleEncodes || afterStable.terrainBundleReuses <= beforeStable.terrainBundleReuses)
        throw new Error('An unchanged visible terrain set must reuse encoded commands.');
      const stable = { encodes: [beforeStable.terrainBundleEncodes, afterStable.terrainBundleEncodes], reuses: [beforeStable.terrainBundleReuses, afterStable.terrainBundleReuses] };
      const beforeMotion = renderer.stats(); renderer.render({ ...frame, eye: [.05, 0, 0] }); const afterMotion = renderer.stats();
      if (afterMotion.terrainBundleEncodes !== beforeMotion.terrainBundleEncodes) throw new Error('Camera uniform changes with unchanged visibility must retain commands.');
      await parity('camera uniform motion', { eye: [.05, 0, 0] });

      const beforeOffscreen = renderer.stats(); upload('offscreen', cube(1000, 1000)); renderer.render(frame); renderer.removeChunk('offscreen'); renderer.render(frame);
      const afterOffscreen = renderer.stats();
      if (afterOffscreen.terrainBundleEncodes !== beforeOffscreen.terrainBundleEncodes) throw new Error('An offscreen upload/removal must retain unrelated visible bundles.');
      const turned = await parity('frustum visibility changes', { yaw: Math.PI / 2 });
      if (turned.stats.visibleChunks === initial.stats.visibleChunks && mismatch(turned.hdr.pixels, initial.hdr.pixels) === 0) throw new Error('The culling fixture did not change visible geometry.');

      const beforeEdit = renderer.stats(); upload('near', cube(0, -4, { size: 2.7 })); const edited = await parity('visible terrain replacement');
      if (edited.stats.terrainBundleEncodes <= beforeEdit.terrainBundleEncodes || mismatch(initial.depth.pixels, edited.depth.pixels) === 0) throw new Error('A visible edit must encode new commands and change depth.');
      renderer.removeChunk('near'); const removed = await parity('visible terrain removal');

      const beforeAtlas = renderer.stats(); renderer.setTextureAtlas(atlas([70, 160, 240, 255])); const replacedAtlas = await parity('atlas binding replacement');
      if (replacedAtlas.stats.terrainBundleEncodes <= beforeAtlas.terrainBundleEncodes) throw new Error('A replaced atlas must rebuild material-bound commands.');
      if (!mismatch(removed.hdr.pixels, replacedAtlas.hdr.pixels)) throw new Error('The replacement atlas must change rendered terrain pixels.');
      const runtimeTile = renderer.appendAtlasTile({ pixelsRGBA: new Uint8Array([30, 250, 120, 255]), width: 1, height: 1 });
      upload('map', cube(0, -4, { tile: runtimeTile.id })); const beforePixelImage = await capture(); const beforePixelUpdate = renderer.stats();
      renderer.updateAtlasTile(runtimeTile.id, { pixelsRGBA: new Uint8Array([250, 30, 180, 255]), width: 1, height: 1 });
      renderer.render(frame); const afterPixelUpdate = renderer.stats();
      if (afterPixelUpdate.terrainBundleEncodes !== beforePixelUpdate.terrainBundleEncodes) throw new Error('An in-place map texture update must retain terrain commands.');
      if (!mismatch(beforePixelImage.hdr.pixels, (await renderer.readPixels()).pixels)) throw new Error('An in-place map update must change actual terrain pixels.');
      await parity('runtime texture pixel update');

      await parity('balanced quality bindings', { quality: 'balanced' });
      await parity('low quality bindings', { quality: 'low' });
      await parity('resized attachments', { scale: .75 });
      await parity('full resolution attachments', { scale: 1 });
      const beforeRebase = renderer.stats(); worldBounds = { min: [-32, -16, -32], max: [544, 16, 32] };
      renderer.configureWorld(worldBounds); renderer.render(frame); const afterRebase = renderer.stats();
      if (afterRebase.geometryRebases <= beforeRebase.geometryRebases || afterRebase.terrainBundleEncodes !== beforeRebase.terrainBundleEncodes)
        throw new Error('An origin rebase must rewrite retained vertices without rebuilding identical command lists.');
      await parity('world origin rebase');

      const moving = cube(.5, -2, { size: .7, color: [.5, 1, .5] });
      renderer.uploadDynamicMesh('entity', moving.vertices, [], moving.bounds, { stride: 14 });
      await parity('dynamic shadow receiver binding and direct entity draw');
      const withEntity = renderer.stats(); renderer.render(frame); const entityStable = renderer.stats();
      if (entityStable.terrainBundleEncodes !== withEntity.terrainBundleEncodes) throw new Error('An unchanged dynamic receiver binding must retain terrain commands.');
      renderer.removeMesh('entity'); await parity('return to static shadow receiver binding');

      const glass = cube(0, -2, { size: 1.5, flags: 64 }); upload('glass', glass);
      const water = cube(0, -3, { size: 2, color: [.1, .4, .7] }); renderer.uploadChunk('water', [], water.vertices, water.bounds, { stride: 14 });
      const hand = cube(.4, -.7, { size: .2 }); renderer.uploadFirstPersonMesh(hand.vertices, [], hand.bounds, { stride: 14 });
      await parity('transparent water and first person direct paths');
      renderer.clearFirstPersonMesh(); renderer.removeChunk('glass'); renderer.removeChunk('water');

      for (let i = 0; i < 24; i++) renderer.render({ ...frame, yaw: i / 24 * Math.PI * 2 });
      const bounded = renderer.stats();
      if (bounded.renderBundleEntries > bounded.renderBundleMaxEntries || bounded.renderBundleDraws > bounded.renderBundleMaxDraws || !bounded.renderBundleEvictions)
        throw new Error('Distinct visibility sets must evict through the bounded bundle LRU.');
      for (let i = 0; i < 16; i++) renderer.removeChunk(`ring:${i}`); renderer.removeChunk('map'); renderer.render(frame);
      const empty = renderer.stats();
      if (empty.renderBundleEntries || empty.renderBundleDraws || empty.renderBundleMetadataBytesEstimate) throw new Error('Removing a world must release cached terrain commands and metadata.');
      if (empty.lastError) throw new Error(empty.lastError);
      return { comparisons, stable, rebase: { encodes: [beforeRebase.terrainBundleEncodes, afterRebase.terrainBundleEncodes], origin: afterRebase.renderOrigin },
        counters: { encodes: bounded.renderBundleEncodes, reuses: bounded.renderBundleReuses, executions: bounded.renderBundleExecutions, evictions: bounded.renderBundleEvictions,
          directDraws: bounded.renderBundleDirectDraws, entries: bounded.renderBundleEntries, draws: bounded.renderBundleDraws, metadataBytesEstimate: bounded.renderBundleMetadataBytesEstimate },
        limits: { entries: bounded.renderBundleMaxEntries, draws: bounded.renderBundleMaxDraws }, releasedEntries: empty.renderBundleEntries, adapter: empty.adapterInfo, error: empty.lastError };
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/render-bundles.json', JSON.stringify({ ...proof, softwareGPU: software }, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
