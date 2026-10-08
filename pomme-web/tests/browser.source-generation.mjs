import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/generation/source-generation.js', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async () => {
    const [{ SourceGenerationWorker }, { SourceGeneratedWorld }, { BrowserWorld }, { registryStates }] = await Promise.all([
      import('/generation/source-generation.js'), import('/generation/source-generated-world.js'), import('/src/world.js'), import('/src/anvil.js'),
    ]);
    const registry = await (await fetch('/data/1.21.11-registry.json')).json(), native = registryStates(registry);
    const target = { version: '1.21.11', lookup: native.lookup, biomes: registry.biomes };
    const check = (value, message) => { if (!value) throw new Error(message); };
    const worldErrors = [];
    let heartbeats = 0; const heartbeat = setInterval(() => heartbeats++, 10), progress = [];
    const worker = new SourceGenerationWorker({ maximumRequests: 2, onProgress: value => progress.push(value) });
    const worldKey = `generated-proof-${crypto.randomUUID()}`;
    const context = { worldKey, seed: '42', dimension: 'minecraft:overworld', version: '1.21.11' };
    worker.configure(context, target);
    const controller = new AbortController();
    const cancelled = worker.request({ x: 0, z: 0, signal: controller.signal }).then(() => 'unexpected', error => error.name);
    const retained = worker.request({ x: 1, z: 0 });
    const overflow = await worker.request({ x: 2, z: 0 }).then(() => false, error => /queue is full/.test(error.message));
    controller.abort();
    check(await cancelled === 'AbortError' && (await retained).x === 1 && overflow, 'Bounded queue must preserve another request while cancelling the first.');
    const stale = worker.request({ x: 0, z: 1 }).then(() => 'unexpected', error => error.name);
    worker.configure({ ...context, worldKey: `${worldKey}-new`, seed: '-1', dimension: 'minecraft:the_end' }, target);
    check(await stale === 'AbortError', 'Changing worlds must abort old terrain.');
    check((await worker.request({ x: -17, z: 31 })).context.worldKey === `${worldKey}-new`, 'New results require the new world identity.');
    for (const bad of [{ ...context, seed: 9007199254740992 }, { ...context, seed: '9223372036854775808' }, { ...context, version: '26.1' }, { ...context, dimension: 'custom:test' }]) {
      let rejected = false; try { worker.configure(bad, target); } catch { rejected = true; } check(rejected, 'Unsupported generation context must be rejected.');
    }
    worker.close();
    const wasm = await (await fetch('/public/core.wasm')).arrayBuffer();
    let uploads = 0;
    const makeWorld = async key => {
      const core = (await WebAssembly.instantiate(wasm, {})).instance.exports;
      const world = new BrowserWorld({ core, renderer: { removeChunk() {}, configureWorld() {}, uploadChunk() { uploads++; } }, onError: error => worldErrors.push(error.message) });
      await world.reset({ registry, minY: -64, height: 384, width: 4, depth: 4, originX: 0, originZ: 0, worldKey: key, mode: 'import' });
      return world;
    };
    let world = await makeWorld(worldKey), generated = new SourceGeneratedWorld({ world, context, registry: target, maximumRequests: 2 });
    try {
      const first = generated.ensureColumn(0, 0), duplicate = generated.ensureColumn(0, 0);
      check(first === duplicate, 'Duplicate column requests must share one native generation job.');
      const column = await first;
      check(column.sections.length === 24 && column.sections.every(section => section.blocks.length === 4096 && section.biomes.length === 64), 'Actual source WASM must populate all native sections and biomes.');
      check(world.core.block_get(8, -64, 8) === native.lookup('bedrock', {}), 'Generated blocks must reach the actual core WASM world.');
      const stone = native.lookup('stone', {});
      world.setBlock(8, 80, 8, stone);
      await world.store.put(world.columns.get('0,0'));
      const deadline = performance.now() + 15000;
      while (world.lightingStats().solvedColumns === 0 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      check(world.lightingStats().solvedColumns > 0, 'Generated columns must run through the actual local lighting worker.');
      const saved = await world.store.get(0, 0);
      check(saved.sections.find(section => section.sectionY === 5).blocks[8 * 16 + 8] === stone, 'Edited generated blocks must persist to IndexedDB.');
      await world.store.put(saved); generated.close(); world.stopLocalLighting(); await world.store.close(); world.destroy();
      world = await makeWorld(worldKey); generated = new SourceGeneratedWorld({ world, context, registry: target });
      const reopened = await generated.ensureColumn(0, 0);
      check(world.core.block_get(8, 80, 8) === stone && reopened.sections[0].biomes.length === 64, 'Saved edits and biomes must win when reopening generated terrain.');
      check(world.lightingStats().jobs === 0, 'Saved native lighting must be reused on reopen.');
      const put = world.store.put.bind(world.store); world.store.put = async () => { throw new Error('deliberate durability failure'); };
      const failure = await generated.ensureColumn(1, 1).then(() => 'unexpected', error => error.message);
      check(failure === 'deliberate durability failure' && !world.columns.has('1,1') && !world.core.world_column_loaded(1, 1), 'Failed durable save must not admit generated terrain to the renderer or core.');
      world.store.put = put;
      const staleTerrain = generated.ensureColumn(2, 2).then(() => 'unexpected', error => error.name);
      world.generation++;
      check(await staleTerrain === 'AbortError' && !world.columns.has('2,2'), 'Old world generation must not publish after a BrowserWorld epoch change.');
      check(worldErrors.length === 0, `BrowserWorld errors: ${worldErrors.join(', ')}`);
      return { validation: 'passed', sourceCommit: '70b31323967bb99fd4feefab8e96124be369cd6f', minecraftVersion: '1.21.11', stages: ['biomes', 'noise', 'surface'], runtime: 'Actual dedicated Worker + WASM + BrowserWorld + IndexedDB + lighting Worker', nativeProcesses: 0,
        guards: { boundedQueue: true, cancellation: true, worldIdentity: true, exactSeed: true, unsupportedVersion: true, duplicateCoalescing: true, staleWorldSuppressed: true, failedSaveSuppressesPublication: true },
        durable: { fullSections: column.sections.length, nativeBiomes: true, savedEditsWin: true, cachedLightingReused: true }, mainThreadHeartbeats: heartbeats, progressCount: progress.length, meshUploads: uploads };
    } finally { generated.close(); world.stopLocalLighting(); await world.store?.close(); world.destroy(); clearInterval(heartbeat); }
  });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/source-generation-browser.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
