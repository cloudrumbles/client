import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { unzipSync, zipSync } from '../vendor/fflate.js';

const source = process.env.POMME_MINECRAFT_JAR;
if (!source) throw new Error('Set POMME_MINECRAFT_JAR to your original Minecraft Java 1.20.4 client JAR.');
// Read original textures/model parents at run time; no game files are bundled.
const entries = unzipSync(new Uint8Array(await readFile(source)), { filter: entry => /^assets\/minecraft\/(models\/block\/.*\.json|blockstates\/(air|grass_block|netherrack|water)\.json|textures\/(colormap\/(grass|foliage)\.png|block\/(grass_block_top|grass_block_side|grass_block_side_overlay|dirt|netherrack|water_still)\.png(\.mcmeta)?))$/.test(entry.name) });
const assets = Buffer.from(zipSync(entries, { level: 0 })), software = process.env.POMME_SOFTWARE_GPU === '1';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
  await page.route('**/__native-distant-assets.zip', route => route.fulfill({ contentType: 'application/zip', body: assets }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const [{ createRenderer }, { loadCore }, { BrowserWorld }, { loadResourcePack }, { loadMinecraftRegistry }] = await Promise.all([
      import('/src/renderer.js'), import('/src/wasm.js'), import('/src/world.js'), import('/src/assets.js'), import('/src/registry.js'),
    ]);
    const nativeRegistry = await loadMinecraftRegistry(), names = new Set(['air', 'grass_block', 'netherrack', 'water']);
    const registry = { ...nativeRegistry, blocks: nativeRegistry.blocks.filter(block => names.has(block.name)), items: [] };
    const pack = await loadResourcePack(new Uint8Array(await (await fetch('/__native-distant-assets.zip')).arrayBuffer()), { registry });
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.append(canvas);
    const renderer = await createRenderer(canvas); renderer.setTextureAtlas(pack.atlas);
    const core = await loadCore(1), failures = [], meshes = new Map();
    const world = new BrowserWorld({ core, renderer, onMesh: mesh => meshes.set(mesh.key ?? mesh.index, mesh),
      onError: error => failures.push(error.message), onStatus: message => { if (/failed|stopped/i.test(message)) failures.push(message); } });
    const native = name => registry.blocks.find(block => block.name === name).defaultState;
    const grass = native('grass_block'), stone = native('netherrack'), water = native('water');
    const plains = registry.biomes.find(biome => biome.name.replace(/^minecraft:/, '') === 'plains').id;
    const desert = registry.biomes.find(biome => biome.name.replace(/^minecraft:/, '') === 'desert').id;
    // Diagnostic palettes exercise native quart-Y selection on actual textures.
    const definitions = new Map([['minecraft:plains', { temperature: .8, downfall: .4, effects: { grass_color: 0xff0000 } }],
      ['minecraft:desert', { temperature: 2, downfall: 0, effects: { grass_color: 0x0000ff } }]]);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async condition => { for (let i = 0; i < 1000; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Distant dimension worker did not settle.'); };
    const settle = () => wait(() => !world.distant.refreshing && !world.distant.refreshTimer && !world.distant.operations.size && !world.distant.jobs.size);
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const colored = (pixels, axis) => { let count = 0; for (let i = 0; i < pixels.length; i += 4) {
      const rgb = [0, 1, 2].map(channel => half(pixels[i + channel])); if (rgb[axis] > .0005 && rgb[axis] > rgb[(axis + 1) % 3] * 1.5 && rgb[axis] > rgb[(axis + 2) % 3] * 1.5) count++;
    } return count; };
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if ([0, 1, 2].some(axis => Math.abs(half(a[i + axis]) - half(b[i + axis])) > .001)) count++; return count; };
    const results = [], captures = {};
    try {
      for (const dimension of [
        { name: 'nether', minY: 0, height: 256, hasSkylight: false },
        { name: 'negative', minY: -320, height: 512, hasSkylight: true },
        { name: 'low-custom', minY: -40000, height: 32, hasSkylight: true },
        { name: 'high-custom', minY: 40000, height: 32, hasSkylight: true },
        { name: 'i32-negative', minY: -2147483632, height: 1024, hasSkylight: true },
        { name: 'i32-positive', minY: 2147482608, height: 1024, hasSkylight: true },
      ]) {
        const { minY, height, name } = dimension, maxY = minY + height;
        meshes.clear();
        await world.reset({ ...dimension, registry, materials: pack.materials, colormaps: pack.atlas.colormaps,
          biomeDefinitions: definitions, biomeBlendRadius: 0, originX: -8, originZ: 0, width: 4, depth: 4, mode: 'server', worldKey: `lod-dimension:${Date.now()}:${name}` });
        check(world.distant.stats().minY === minY && world.distant.stats().height === height, 'World reset must pass native dimension bounds into persistent LOD.');
        check(world.distant.stats().biomeSampler === 'wasm', 'Browser LOD must use the actual native WASM biome sampler.');
        const makeColumn = (x, z, flipped = false) => {
          const sections = [];
          for (let layer = 0; layer < height / 16; layer++) {
            const sectionY = minY / 16 + layer, blocks = new Uint16Array(4096), biomes = new Uint32Array(64).fill(flipped ? desert : plains);
            if (layer === height / 16 - 1) biomes.fill(flipped ? plains : desert);
            if (x === -7 && z === 1) {
              for (const [vx, y, vz, id] of [[4, minY, 4, grass], [11, maxY - 1, 11, grass], [11, minY + 8, 4, stone], [4, minY + 8, 11, water]]) {
                if (Math.floor(y / 16) === sectionY) blocks[(((y % 16 + 16) % 16) * 16 + vz) * 16 + vx] = id;
              }
            }
            sections.push({ sectionY, blocks, biomes });
          }
          return { x, z, sections };
        };
        // Known empty neighboring columns carry actual biome palettes. They
        // supply native fuzzy quart sampling but never create terrain geometry.
        for (let z = 0; z <= 2; z++) for (let x = -8; x <= -6; x++) await world.distant.ingest(makeColumn(x, z));
        await settle();
        const mesh = meshes.get('lod:-2,0');
        check(mesh?.opaque?.length && mesh.water.length === 36 * 14, `${name}: source terrain and water must reach the distant renderer.`);
        check(JSON.stringify(mesh.bounds) === JSON.stringify({ min: [-128, minY, 0], max: [-64, maxY, 64] }), `${name}: region bounds must match the active dimension.`);
        check(JSON.stringify(mesh.origin) === JSON.stringify([-128, minY, 0]), `${name}: signed local mesh origin is incorrect.`);
        const ups = []; for (let i = 0; i < mesh.opaque.length; i += 14) if (mesh.opaque[i + 4] === 1 && mesh.opaque[i + 12] === pack.materials.get(grass).faces.up.tile) ups.push(i);
        check(ups.filter(i => mesh.opaque[i + 1] === 4).every(i => mesh.opaque[i + 6] === 1 && mesh.opaque[i + 7] === 0 && mesh.opaque[i + 8] === 0), `${name}: minimum-Y grass must use the first native biome section.`);
        check(ups.filter(i => mesh.opaque[i + 1] === height).every(i => mesh.opaque[i + 6] === 0 && mesh.opaque[i + 7] === 0 && mesh.opaque[i + 8] === 1), `${name}: maximum-Y grass must use the final native biome section.`);
        check(ups.some(i => mesh.opaque[i + 1] === 4) && ups.some(i => mesh.opaque[i + 1] === height), `${name}: boundary cells were lost.`);
        for (const stream of [mesh.opaque, mesh.water]) for (let i = 0; i < stream.length; i += 14) {
          check(stream[i] >= 16 && stream[i] <= 32 && stream[i + 2] >= 16 && stream[i + 2] <= 32 && stream[i + 1] >= 0 && stream[i + 1] <= height, `${name}: an unknown source column created vertices.`);
        }
        const frame = { eye: [-106, minY + 9, 37], yaw: 0, pitch: -.4, dayPhase: .25, timeSeconds: 10, gameTime: 6000n, quality: 'low', scale: 1 };
        const draw = async current => { renderer.render(current); renderer.render(current); return (await renderer.readPixels()).pixels; };
        const bottom = await draw(frame), bottomRedPixels = colored(bottom, 0); captures[name] = canvas.toDataURL('image/png');
        check(bottomRedPixels > 30, `${name}: original bottom grass texture did not render red native-biome pixels (${bottomRedPixels}).`);
        const before = renderer.stats(); renderer.render(frame); const stable = renderer.stats();
        check(before.meshUploadCount === stable.meshUploadCount && before.shadowUpdates === stable.shadowUpdates, `${name}: stationary LOD must retain geometry and shadows.`);
        const topFrame = { ...frame, eye: [-98, maxY + 6, 45], pitch: -.4 };
        const top = await draw(topFrame), topBluePixels = colored(top, 2);
        check(topBluePixels > 30, `${name}: original top grass texture did not render blue native-biome pixels (${topBluePixels}).`);
        for (let z = 0; z <= 2; z++) for (let x = -8; x <= -6; x++) await world.distant.ingest(makeColumn(x, z, true));
        await settle();
        const blue = await draw(frame), bottomBluePixels = colored(blue, 2), biomeChangedPixels = changed(bottom, blue);
        check(bottomBluePixels > 30 && biomeChangedPixels > 30, `${name}: native dimension palette update did not change actual GPU colors.`);
        const previousBytes = world.distant.stats().meshBytes;
        await world.distant.updateBlock(-108, minY, 20, 0); await settle();
        check(world.distant.stats().meshBytes === previousBytes - 36 * 14 * 4, `${name}: removing a confirmed boundary voxel must remove its distant geometry.`);
        const deleted = await draw(frame), deletedPixels = changed(blue, deleted);
        check(deletedPixels > 30, `${name}: a removed boundary voxel left ghost pixels (${deletedPixels}).`);
        results.push({ ...dimension, bottomRedPixels, topBluePixels, bottomBluePixels, biomeChangedPixels, deletedPixels,
          cacheBytes: world.distant.stats().memoryBytes, meshBytes: world.distant.stats().meshBytes, sampler: world.distant.stats().biomeSampler,
          cachedMeshes: before.meshUploadCount === stable.meshUploadCount, cachedShadows: before.shadowUpdates === stable.shadowUpdates,
          renderOrigin: renderer.stats().renderOrigin });
      }
      return { dimensions: results, nativeTextureCount: pack.atlas.tiles.length, renderer: renderer.stats(), failures, captures };
    } finally { world.destroy(); renderer.destroy(); }
  });
  assert.deepEqual(errors, []); assert.deepEqual(proof.failures, []); assert.equal(proof.renderer.lastError, null); assert.equal(proof.dimensions.length, 6);
  await mkdir('test-results', { recursive: true });
  for (const [name, data] of Object.entries(proof.captures)) await writeFile(`test-results/distant-dimension-${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  delete proof.captures; await writeFile('test-results/distant-dimensions.json', JSON.stringify({ ...proof, software }, null, 2));
  console.log(JSON.stringify({ ...proof, software }, null, 2));
} finally { await browser.close(); }
