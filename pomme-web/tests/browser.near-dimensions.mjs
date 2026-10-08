import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync, zipSync } from '../vendor/fflate.js';

const source = process.env.POMME_MINECRAFT_JAR;
if (!source) throw new Error('Set POMME_MINECRAFT_JAR to your original Minecraft Java 1.20.4 client JAR.');
const entries = unzipSync(new Uint8Array(await readFile(source)), { filter: entry => /^assets\/minecraft\/(models\/block\/.*\.json|blockstates\/(air|netherrack|stone_slab)\.json|textures\/block\/(netherrack|stone)\.png)$/.test(entry.name) });
const assets = Buffer.from(zipSync(entries, { level: 0 })), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.route('**/__native-near-assets.zip', route => route.fulfill({ contentType: 'application/zip', body: assets }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const [{ createRenderer }, { loadCore }, { BrowserWorld }, { loadResourcePack }, { loadMinecraftRegistry }] = await Promise.all([
      import('/src/renderer.js'), import('/src/wasm.js'), import('/src/world.js'), import('/src/assets.js'), import('/src/registry.js'),
    ]);
    const nativeRegistry = await loadMinecraftRegistry(), names = new Set(['air', 'netherrack', 'stone_slab']);
    const registry = { ...nativeRegistry, blocks: nativeRegistry.blocks.filter(block => names.has(block.name)), items: [] };
    const pack = await loadResourcePack(new Uint8Array(await (await fetch('/__native-near-assets.zip')).arrayBuffer()), { registry });
    const native = name => registry.blocks.find(block => block.name === name).defaultState;
    const cube = native('netherrack'), slab = native('stone_slab');
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas);
    const core = await loadCore(1), failures = [], meshes = new Map();
    const world = new BrowserWorld({ core, renderer, onMesh: mesh => meshes.set(mesh.key ?? mesh.index, mesh),
      onError: error => failures.push(error.message), onStatus: message => { if (/failed|stopped/i.test(message)) failures.push(message); } });
    world.initDemo(1, []);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async condition => { for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Native near-world mesh worker did not settle.'); };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const silhouette = (image, empty) => {
      let minX = 320, minY = 180, maxX = -1, maxY = -1, pixels = 0;
      for (let i = 0; i < image.length; i += 4) if ([0,1,2].some(axis => Math.abs(half(image[i + axis]) - half(empty[i + axis])) > .03)) {
        const pixel = i / 4, x = pixel % 320, y = Math.floor(pixel / 320); minX = Math.min(minX,x); minY = Math.min(minY,y); maxX = Math.max(maxX,x); maxY = Math.max(maxY,y); pixels++;
      }
      return { width: maxX < 0 ? 0 : maxX - minX + 1, height: maxY < 0 ? 0 : maxY - minY + 1, pixels, bounds: [minX,minY,maxX,maxY] };
    };
    const results = [], captures = {};
    try {
      for (const dimension of [
        { name: 'baseline', minY: 0, height: 32 }, { name: 'overworld', minY: -64, height: 384 },
        { name: 'low-custom', minY: -40000, height: 32 }, { name: 'high-custom', minY: 40000, height: 32 },
        { name: 'i32-negative', minY: -2147483632, height: 1024 }, { name: 'i32-positive', minY: 2147482608, height: 1024 },
      ]) {
        const { minY, name } = dimension, blockY = minY + 8;
        meshes.clear(); await world.reset({ ...dimension, registry, materials: pack.materials, originX: 0, originZ: 0, width: 1, depth: 1,
          mode: 'server', worldKey: `near-dimension:${Date.now()}:${name}` });
        const blocks = new Uint16Array(4096), source = { x: 0, z: 0, sections: [{ sectionY: minY / 16, blocks }] };
        world.ingestColumn(source); await wait(() => world.nearReady.has('0,0') && meshes.has('0,0'));
        world.distant.setNearColumns(new Set(['0,0']));
        await wait(() => !world.distant.refreshing && !world.distant.refreshTimer && !world.distant.operations.size);
        const frame = { eye: [8.5, minY + 9, 12], yaw: 0, pitch: -.15, dayPhase: .25, timeSeconds: 10, gameTime: 6000n, quality: 'low', scale: 1 };
        const draw = async () => { renderer.render(frame); renderer.render(frame); return (await renderer.readPixels()).pixels; };
        const empty = await draw();
        const set = async (id, extent) => {
          check(world.setBlock(8, blockY, 8, id), `${name}: native block edit was rejected.`);
          await wait(() => {
            const mesh = meshes.get('0,0'); if (!mesh?.opaque?.length) return id === 0;
            const ys = []; for (let i = 0; i < mesh.opaque.length; i += 14) ys.push(mesh.opaque[i + 1]);
            return id !== 0 && Math.min(...ys) === 8 && Math.max(...ys) === 8 + extent;
          });
          if (!id) return;
          const mesh = meshes.get('0,0');
          check(JSON.stringify(mesh.origin) === JSON.stringify([0,minY,0]), `${name}: near worker omitted native Y mesh origin.`);
          check(core.mesh_origin_y() === minY, `${name}: native mesh Y origin export disagrees with the active dimension.`);
          const count = core.mesh_chunk(0,0), direct = new Float32Array(core.memory.buffer, core.mesh_ptr(),count*14).slice();
          check(count === 36 && direct.length === mesh.opaque.length && direct.every((value,i) => value === mesh.opaque[i]), `${name}: worker geometry differs from the actual main WASM source mesh.`);
          check(core.block_get(8,blockY,8) === id && core.collides_aabb(8.1,blockY+.1,8.1,8.9,blockY+extent-.01,8.9) === 1, `${name}: source state or f64 collision changed with mesh rebasing.`);
          check(core.collides_aabb(8.1,blockY+extent+.1,8.1,8.9,blockY+extent+.2,8.9) === 0, `${name}: visual mesh size cannot enlarge source collision.`);
        };
        await set(cube,1); const cubeImage = await draw(), cubeSilhouette = silhouette(cubeImage,empty); captures[`${name}-cube`] = canvas.toDataURL('image/png');
        check(cubeSilhouette.height > 30 && cubeSilhouette.pixels > 1000, `${name}: one-block native cube collapsed on the GPU (${JSON.stringify(cubeSilhouette)}).`);
        const before = renderer.stats(); renderer.render(frame); const stable = renderer.stats();
        check(before.meshUploadCount === stable.meshUploadCount && before.shadowUpdates === stable.shadowUpdates, `${name}: stable native mesh frames lost cache reuse.`);
        await set(slab,.5); const slabImage = await draw(), slabSilhouette = silhouette(slabImage,empty); captures[`${name}-slab`] = canvas.toDataURL('image/png');
        check(slabSilhouette.height > 15 && slabSilhouette.pixels > 400 && cubeSilhouette.height > slabSilhouette.height * 1.35, `${name}: source half-slab template lost its distinct fractional GPU height (${JSON.stringify(slabSilhouette)}).`);
        await set(0,0); await draw();
        check(meshes.get('0,0').opaque.length === 0 && core.block_get(8,blockY,8) === 0, `${name}: removing native terrain left mesh geometry.`);
        results.push({ ...dimension, originY: minY, cube: cubeSilhouette, slab: slabSilhouette, renderOrigin: renderer.stats().renderOrigin,
          cachedMeshes: before.meshUploadCount === stable.meshUploadCount, cachedShadows: before.shadowUpdates === stable.shadowUpdates });
      }
      for (const result of results.slice(1)) {
        check(Math.abs(result.cube.height - results[0].cube.height) <= 2 && Math.abs(result.slab.height - results[0].slab.height) <= 2,
          `${result.name}: rebased GPU height differs from the ordinary origin by more than two raster pixels.`);
      }
      return { dimensions: results, nativeTextureCount: pack.atlas.tiles.length, renderer: renderer.stats(), failures, captures };
    } finally { world.destroy(); renderer.destroy(); }
  });
  assert.deepEqual(errors, []); assert.deepEqual(proof.failures, []); assert.equal(proof.renderer.lastError, null); assert.equal(proof.dimensions.length, 6);
  await mkdir('test-results', { recursive: true });
  for (const [name, data] of Object.entries(proof.captures)) await writeFile(`test-results/near-dimension-${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  delete proof.captures; await writeFile('test-results/near-dimensions.json', JSON.stringify({ ...proof, software }, null, 2));
  console.log(JSON.stringify({ ...proof, software }, null, 2));
} finally { await browser.close(); }
