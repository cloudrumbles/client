import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const [{ createRenderer }, { loadCore }, { BrowserWorld }] = await Promise.all([import('/src/renderer.js'), import('/src/wasm.js'), import('/src/world.js')]);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas), core = await loadCore(1), meshes = new Map(), failures = [];
    const registry = { biomes: [{ id: 1, name: 'plains' }, { id: 2, name: 'desert' }], blocks: [{ name: 'air', minStateId: 0, maxStateId: 0, defaultState: 0, states: [], filterLight: 0 }, { name: 'grass_block', minStateId: 600, maxStateId: 600, defaultState: 600, states: [], filterLight: 15 }] };
    const material = { id: 600, name: 'minecraft:grass_block', color: [1,1,1], flags: 3, fullCube: true, collisionBoxes: [[0,0,0,1,1,1]], faces: Object.fromEntries(['east','west','up','down','south','north'].map(name => [name, { tintKind: 1, tint: [1,1,1] }])) };
    const materials = new Map([[0, { id: 0, color: [1,1,1], flags: 128, faces: {}, collisionBoxes: [] }], [600, material]]);
    const world = new BrowserWorld({ core, renderer, onMesh: mesh => meshes.set(mesh.key ?? mesh.index, mesh), onError: error => failures.push(error.message), onStatus: message => { if (/failed|stopped/i.test(message)) failures.push(message); } });
    world.initDemo(1, []);
    const wait = async condition => { for (let i = 0; i < 500; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Worker tint mesh timed out.'); };
    const frame = { eye: [8, 10, 23], yaw: 0, pitch: -.38, dayPhase: .25, timeSeconds: 10, quality: 'low', scale: 1 };
    const definitions = new Map([['minecraft:plains', { temperature: .8, downfall: .4, effects: { grass_color: 0xff0000 } }], ['minecraft:desert', { temperature: 2, downfall: 0, effects: { grass_color: 0x0000ff } }]]);
    const verticesHave = (mesh, color) => mesh?.opaque?.length && Array.from({ length: mesh.opaque.length / 14 }, (_value, i) => i * 14).every(i => color.every((value, axis) => mesh.opaque[i + 6 + axis] === value));
    try {
      await world.reset({ registry, materials, biomeDefinitions: definitions, biomeBlendRadius: 0, minY: 0, height: 16, originX: -1, originZ: -1, width: 3, depth: 3, mode: 'server', worldKey: `biome-proof-${Date.now()}` });
      const blocks = new Uint16Array(4096); for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) blocks[(3 * 16 + z) * 16 + x] = 600;
      const column = biome => ({ x: 0, z: 0, sections: [{ sectionY: 0, blocks: blocks.slice(), biomes: new Uint32Array(64).fill(biome) }] });
      for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) world.loadSectionBiomes(x, 0, z, new Uint32Array(64).fill(1));
      world.ingestColumn(column(1)); await wait(() => verticesHave(meshes.get('0,0'), [1,0,0]));
      renderer.render(frame); renderer.render(frame); const red = (await renderer.readPixels()).pixels;
      const stable = renderer.stats(); renderer.render(frame); const cached = renderer.stats();
      if (cached.meshUploadCount !== stable.meshUploadCount || cached.shadowUpdates !== stable.shadowUpdates) throw new Error('Stable native tint frames changed mesh or shadow cache.');
      for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) world.loadSectionBiomes(x, 0, z, new Uint32Array(64).fill(2));
      world.ingestColumn(column(2)); await wait(() => verticesHave(meshes.get('0,0'), [0,0,1]));
      renderer.render(frame); renderer.render(frame); const blue = (await renderer.readPixels()).pixels;
      let changedPixels = 0; for (let i = 0; i < red.length; i += 4) if (red[i] !== blue[i] || red[i + 1] !== blue[i + 1] || red[i + 2] !== blue[i + 2]) changedPixels++;
      if (changedPixels < 1000) throw new Error(`Biome palette update changed only ${changedPixels} actual HDR pixels.`);
      world.distant.setNearColumns(new Set()); await world.distant.ingest(column(2)); await world.distant.refresh();
      await wait(() => [...meshes].some(([key, mesh]) => key.startsWith('lod:') && verticesHave(mesh, [0,0,1])));
      const lod = [...meshes].find(([key, mesh]) => key.startsWith('lod:') && verticesHave(mesh, [0,0,1]))[1];
      if (core.block_get(8,3,8) !== 600 || core.collides_aabb(8.1,3.1,8.1,8.9,3.9,8.9) !== 1) throw new Error('Biome updates changed confirmed world physics.');
      return { changedPixels, cachedMeshes: cached.meshUploadCount === stable.meshUploadCount, cachedShadows: cached.shadowUpdates === stable.shadowUpdates, lodVertices: lod.opaque.length / 14, lodCacheBytes: world.distant.stats().memoryBytes, errors: [...failures], gpuError: renderer.stats().lastError };
    } finally { world.destroy(); renderer.destroy(); }
  });
  assert.ok(proof.changedPixels > 1000); assert.ok(proof.cachedMeshes && proof.cachedShadows); assert.ok(proof.lodVertices > 0); assert.deepEqual(proof.errors, []); assert.equal(proof.gpuError, null); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...proof, software }, null, 2));
} finally { await browser.close(); }
