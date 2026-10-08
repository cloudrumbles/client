// Original textures are supplied privately by the developer; this proof never
// adds Minecraft assets to the repository or deployable bundle.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const jar = process.env.POMME_MINECRAFT_JAR;
if (!jar) throw new Error('Set POMME_MINECRAFT_JAR to a privately supplied matching client JAR.');
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
const bytes = await readFile(jar), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/private-client.jar', route => route.fulfill({ status: 200, contentType: 'application/zip', body: bytes }));
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto(new URL('/src/shaders/water.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async version => {
    const [{ createRenderer }, { loadResourcePack, MATERIAL_FLAGS: F }, { applyMaterials, activateMaterials }, { copyMesh }] = await Promise.all([
      import('/src/renderer.js'), import('/src/assets.js'), import('/src/registry.js'), import('/src/wasm.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json();
    const pack = await loadResourcePack(new Uint8Array(await (await fetch('/private-client.jar')).arrayBuffer()), { registry });
    const compiled = await WebAssembly.compileStreaming(fetch('/public/core.wasm'));
    const water = [...pack.materials.values()].find(m => m.name === 'minecraft:water' && m.properties.level === '0');
    const make = async (plant, missing = false) => {
      const { exports: core } = await WebAssembly.instantiate(compiled);
      if (!core.world_reset(0, 16, 0, 0, 1, 1)) throw new Error('Fixture reset failed.');
      const materials = new Map(pack.materials);
      if (missing) materials.set(plant.id, { ...plant, fluid: null });
      const active = applyMaterials(core, materials); activateMaterials(core, materials, [plant.id, water.id], active);
      const values = new Uint16Array(4096).fill(water.id); values[(8 * 16 + 8) * 16 + 8] = plant.id;
      const ptr = core.world_stage_ptr(); new Uint16Array(core.memory.buffer, ptr, 4096).set(values);
      if (!core.world_load_section(0, 0, 0, ptr, 4096)) throw new Error('Fixture section failed.');
      return { solid: copyMesh(core, 0, false), liquid: copyMesh(core, 0, true) };
    };
    document.body.replaceChildren();
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:480px;height:270px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas);
    renderer.configureWorld({ min: [0, 0, 0], max: [16, 16, 16] });
    const frame = { eye: [8.5, 8.55, 11], yaw: 0, pitch: 0, timeSeconds: 1, gameTime: 0n, dayPhase: .22, quality: 'low', scale: 1 };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023;
      return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const difference = (a, b) => { let changed = 0; for (let at = 0; at < a.pixels.length; at += 4)
      if ([0, 1, 2].some(channel => Math.abs(half(a.pixels[at + channel]) - half(b.pixels[at + channel])) > .005)) changed++;
      return changed; };
    const draw = async (solid, liquid) => { renderer.uploadChunk('fluid', solid, liquid, { min: [0, 0, 0], max: [16, 16, 16] }, { stride: 14 });
      renderer.render(frame); return renderer.readPixels(); };
    const results = [];
    try {
      const reference = await make(water);
      for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']) {
        const plant = [...pack.materials.values()].find(m => m.name === `minecraft:${name}`);
        if (!plant || plant.flags & F.FLUID || !(plant.flags & F.CUSTOM_MODEL)) throw new Error(`Invalid native plant flags: ${name}`);
        const actual = await make(plant), missing = await make(plant, true);
        if (actual.liquid.length !== reference.liquid.length || !actual.liquid.every((value, at) => value === reference.liquid[at]))
          throw new Error(`${name} fragments the native water boundary.`);
        const correct = await draw(actual.solid, actual.liquid), expected = await draw(actual.solid, reference.liquid);
        const wrong = await draw(missing.solid, missing.liquid), empty = await draw([], reference.liquid);
        const boundaryPixels = difference(correct, expected), repairedPixels = difference(correct, wrong), nativePlantPixels = difference(correct, empty);
        if (boundaryPixels !== 0 || repairedPixels < 10 || nativePlantPixels < 10)
          throw new Error(`${name}: image proof failed (${boundaryPixels} boundary, ${repairedPixels} repaired, ${nativePlantPixels} plant pixels).`);
        results.push({ name, stateId: plant.id, flags: plant.flags, solidVertices: actual.solid.length / 14,
          liquidVertices: actual.liquid.length / 14, falseFluidVerticesRemoved: (missing.liquid.length - actual.liquid.length) / 14,
          boundaryPixels, repairedPixels, nativePlantPixels });
        await draw(actual.solid, actual.liquid);
      }
      const before = renderer.stats(); renderer.render(frame); const after = renderer.stats();
      if (after.meshUploadCount !== before.meshUploadCount || after.shadowUpdates !== before.shadowUpdates) throw new Error('Unchanged native water must reuse geometry and shadows.');
      if (after.lastError) throw new Error(after.lastError);
      return { originalAssets: true, version, results, adapter: after.adapterInfo,
        meshUploads: [before.meshUploadCount, after.meshUploadCount], shadowUpdates: [before.shadowUpdates, after.shadowUpdates], error: after.lastError };
    } finally { globalThis.fluidProofRenderer = renderer; }
  }, version);
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/contained-fluid.png' });
  await writeFile('test-results/contained-fluid.json', JSON.stringify({ ...proof, softwareGPU: software }, null, 2));
  await page.evaluate(() => globalThis.fluidProofRenderer?.destroy());
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
