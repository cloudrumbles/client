import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserWorld } from '../src/world.js';
import { MaterialRegistry } from '../src/registry.js';
import { copyMesh } from '../src/wasm.js';
import { createLightingProcessor } from '../src/lighting.worker.js';

const module = await WebAssembly.compile(await readFile(new URL('../public/core.wasm', import.meta.url)));
const registry = { blocks: [
  { name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty', transparent: true },
  { name: 'stone', minStateId: 1, maxStateId: 1, boundingBox: 'block', filterLight: 15 },
  { name: 'oak_slab', minStateId: 2, maxStateId: 2, boundingBox: 'block', transparent: true },
  { name: 'torch', minStateId: 3, maxStateId: 3, boundingBox: 'empty', transparent: true, filterLight: 0, emitLight: 14 },
], collisionShapes: { blocks: { air: 0, stone: 1, oak_slab: 2 }, shapes: {
  0: [], 1: [[0, 0, 0, 1, 1, 1]], 2: [[0, 0, 0, 1, .5, 1]],
} } };

class RecordingWorker {
  constructor() { this.messages = []; }
  postMessage(data) { this.messages.push(structuredClone(data)); }
  emit(data) { this.onmessage({ data }); }
  terminate() { this.terminated = true; }
}
globalThis.Worker = RecordingWorker;

async function createWorld(t) {
  const { exports: core } = await WebAssembly.instantiate(module, {});
  core.world_init(1650);
  assert.equal(core.world_reset(-64, 384, -8, -8, 16, 16), 1);
  const renderer = { uploads: [], removed: [],
    uploadChunk(...args) { this.uploads.push(args); },
    removeChunk(key) { this.removed.push(key); }, configureWorld() {},
  };
  const errors = [], world = new BrowserWorld({ core, renderer, onError: error => errors.push(error) });
  world.mode = 'server'; world.hasSkylight = true;
  world.registry = registry;
  world.materialRegistry = new MaterialRegistry(registry);
  world.materialRegistry.register(core);
  t.after(() => world.destroy());
  return { world, core, renderer, errors };
}
function column(x, z, sy = -4, id = 1) {
  const blocks = new Uint16Array(4096);
  blocks[8 * 256 + 8 * 16 + 8] = id;
  return { x, z, sections: [{ sectionY: sy, blocks }] };
}
function memoryStore() {
  const columns = new Map();
  return { async put(value) { columns.set(`${value.x},${value.z}`, structuredClone(value)); },
    async get(x, z) { return structuredClone(columns.get(`${x},${z}`)); },
    keys() { return [...columns.keys()]; }, async close() {},
  };
}

test('near-world bridge activates exact native collisions before posting section data', async t => {
  const { world, core } = await createWorld(t);
  world.ingestColumn(column(-2, -3, -4, 2));
  assert.equal(core.block_get(-24, -56, -40), 2);
  assert.equal(core.collides_aabb(-23.9, -55.9, -39.9, -23.1, -55.6, -39.1), 1);
  assert.equal(core.collides_aabb(-23.9, -55.4, -39.9, -23.1, -55.1, -39.1), 0);
  assert.deepEqual(world.worker.messages.map(message => message.type), ['definitions', 'section']);
  assert.equal(world.worker.messages[0].materials[0].id, 0);
  assert.ok(world.worker.messages[0].materials.some(material => material.id === 2));
  assert.equal(world.worker.messages[1].blocks[8 * 256 + 8 * 16 + 8], 2);
});

test('editing an omitted air section updates both the WASM world and full-column cache', async t => {
  const { world, core } = await createWorld(t);
  world.store = memoryStore();
  world.ingestColumn(column(-2, -3));
  assert.equal(world.setBlock(-24, -20, -40, 2), true);
  const section = world.columns.get('-2,-3').sections.find(section => section.sectionY === -2);
  assert.equal(section.blocks[12 * 256 + 8 * 16 + 8], 2);
  assert.equal(core.block_get(-24, -20, -40), 2);
  assert.equal((await world.store.get(-2, -3)).sections.find(section => section.sectionY === -2).blocks[12 * 256 + 8 * 16 + 8], 2);
  assert.equal(world.worker.messages.at(-1).type, 'edit');
});

test('invalid placements never create rejected sections in the persistent cache', async t => {
  const { world, core } = await createWorld(t);
  world.store = memoryStore();
  world.ingestColumn(column(-2, -3));
  const revision = core.world_revision(), count = world.columns.get('-2,-3').sections.length;
  for (const block of [[-24, 320, -40, 1], [-24, -65, -40, 1], [-24, -20, -40, 999], [-24.5, -20, -40, 1]]) {
    assert.equal(world.setBlock(...block), false);
  }
  assert.equal(core.world_revision(), revision);
  assert.equal(world.columns.get('-2,-3').sections.length, count);
  assert.equal(world.store.keys().length, 0);
});

test('rebasing retains valid columns without replaying their section buffers', async t => {
  const { world, core } = await createWorld(t);
  world.ingestColumn(column(-2, -3));
  world.worker.messages.length = 0;
  world.updateCamera([88, -50, 8]);
  assert.equal(core.world_column_loaded(-2, -3), 1);
  assert.equal(core.block_get(-24, -56, -40), 1);
  assert.deepEqual(world.worker.messages.map(message => message.type), ['rebase']);
});

test('unloading and revisiting a signed column replays its complete native lighting', async t => {
  const { world, core } = await createWorld(t);
  const source = column(-2, -3);
  source.light = { sky: new Map([[-4, new Uint8Array(2048).fill(0x22)]]), block: new Map([[-4, new Uint8Array(2048).fill(0x77)]]) };
  world.ingestColumn(source);
  world.updateCamera([136, -50, 136]);
  assert.equal(core.world_column_loaded(-2, -3), 0);
  world.updateCamera([-24, -50, -40]);
  assert.equal(core.world_column_loaded(-2, -3), 1);
  const width = core.world_width() / 16;
  const index = (-3 - core.world_origin_z() / 16) * width + (-2 - core.world_origin_x() / 16);
  const mesh = copyMesh(core, index, false);
  assert.ok(mesh.length > 0);
  for (let vertex = 13; vertex < mesh.length; vertex += 14) {
    const flags = Math.round(mesh[vertex]);
    assert.equal(flags >>> 10 & 15, 2);
    assert.equal(flags >>> 14 & 15, 7);
  }
});

test('worker results from an older world or outside the current window never upload', async t => {
  const { world, renderer } = await createWorld(t);
  const mesh = { type: 'mesh', generation: world.generation, index: '-2,-3', opaque: new Float32Array(42), water: new Float32Array(), stride: 14,
    origin: [-128, 0, -128], bounds: { min: [-32, -64, -48], max: [-16, 320, -32] } };
  world.worker.emit({ ...mesh, generation: world.generation - 1 });
  world.worker.emit({ ...mesh, index: '30,30' });
  assert.equal(renderer.uploads.length, 0);
  world.worker.emit(mesh);
  assert.equal(renderer.uploads.length, 1);
  assert.deepEqual(renderer.uploads[0][4], { stride: 14, origin: [-128, 0, -128] });
});

test('an obsolete asynchronous cache restore cannot insert columns into a newer window', async t => {
  const { world, core } = await createWorld(t);
  let release;
  world.store = { keys: () => ['-2,-3'], get: () => new Promise(resolve => { release = resolve; }), async close() {} };
  const restoring = world.restoreNearColumns();
  core.world_rebase(0, 0);
  release(column(-2, -3));
  await restoring;
  assert.equal(world.columns.size, 0);
  assert.equal(world.worker.messages.length, 0);
});

test('an imported occupied column beyond the initial region window restores at its native position', async t => {
  const { world, core } = await createWorld(t);
  world.mode = 'import'; world.store = memoryStore();
  const source = column(30, 30);
  await world.ingestSection({ cx: 30, sy: -4, cz: 30, states: source.sections[0].blocks, skyLight: new Uint8Array(2048).fill(255), blockLight: new Uint8Array(2048) });
  await world.finishImport();
  assert.equal(world.columns.size, 0);
  assert.deepEqual(world.store.keys(), ['30,30']);
  world.updateCamera([488, -50, 488]);
  await world.restoreNearColumns();
  assert.equal(core.world_column_loaded(30, 30), 1);
  assert.equal(core.block_get(488, -56, 488), 1);
  assert.equal(core.terrain_height(488, 488), -55);
  assert.ok(core.world_light_section_count() > 0);
});

test('persistent edit overlays apply to distant imports before full-column persistence', async t => {
  const { world, core } = await createWorld(t);
  world.mode = 'import'; world.store = memoryStore();
  world.setOverlay([[488, -20, 488, 2], [488, -56, 488, 0]]);
  const source = column(30, 30);
  await world.ingestSection({ cx: 30, sy: -4, cz: 30, states: source.sections[0].blocks });
  await world.finishImport();
  const cached = await world.store.get(30, 30);
  assert.equal(cached.sections.find(section => section.sectionY === -4).blocks[8 * 256 + 8 * 16 + 8], 0);
  assert.equal(cached.sections.find(section => section.sectionY === -2).blocks[12 * 256 + 8 * 16 + 8], 2);
  world.updateCamera([488, -20, 488]);
  await world.restoreNearColumns();
  assert.equal(core.block_get(488, -56, 488), 0);
  assert.equal(core.block_get(488, -20, 488), 2);
});

function packedLight(map, x, y, z) {
  const index = ((y % 16 + 16) % 16) * 256 + z * 16 + x;
  return map.get(Math.floor(y / 16))[index >>> 1] >>> ((index & 1) * 4) & 15;
}
async function launchLighting(world) {
  clearTimeout(world.lightingTimer); world.lightingTimer = null;
  await world.runLighting();
  return world.lightingWorker.messages.filter(message => message.type === 'solve').at(-1);
}

test('local torch edits compute light once in the background and persist exact packed arrays', async t => {
  const { world, core } = await createWorld(t);
  world.mode = 'import'; world.hasSkylight = false; world.store = memoryStore();
  world.ingestColumn(column(-2, -3)); world.startLocalLighting();
  const processor = createLightingProcessor();
  await processor(world.lightingWorker.messages[0]);
  assert.equal(world.setBlock(-23, -56, -40, 3), true);
  const request = await launchLighting(world);
  assert.equal(request.targets.length, 1, 'unknown target columns never become invented empty space');
  assert.equal(request.columns.length, 1);
  world.lightingWorker.emit(await processor(request));
  const light = world.columns.get('-2,-3').light;
  assert.equal(packedLight(light.block, 9, -56, 8), 14);
  assert.equal(packedLight(light.block, 10, -56, 8), 13);
  assert.equal(packedLight(light.sky, 10, -56, 8), 0);
  assert.equal(world.lightingStats().jobs, 1);
  assert.equal(core.world_light_section_count(), 24);
  assert.equal(world.worker.messages.filter(message => message.type === 'light').length, 24);
  assert.equal(packedLight((await world.store.get(-2, -3)).light.block, 10, -56, 8), 13);
  assert.equal(world.setBlock(-23, -56, -40, 0), true);
  world.lightingWorker.emit(await processor(await launchLighting(world)));
  assert.ok([...world.columns.get('-2,-3').light.block.values()].every(bytes => bytes.every(value => value === 0)));
  assert.equal(world.lightingStats().jobs, 2);
});

test('new edits invalidate an in-flight light result without creating a worker backlog', async t => {
  const { world, core } = await createWorld(t);
  world.mode = 'import'; world.hasSkylight = false; world.store = memoryStore();
  world.ingestColumn(column(-2, -3)); world.startLocalLighting();
  const processor = createLightingProcessor();
  await processor(world.lightingWorker.messages[0]);
  world.setBlock(-23, -56, -40, 3);
  const obsolete = await launchLighting(world);
  world.setBlock(-23, -56, -40, 0);
  await world.runLighting();
  assert.equal(world.lightingWorker.messages.filter(message => message.type === 'solve').length, 1);
  world.lightingWorker.emit(await processor(obsolete));
  assert.equal(world.lightingStats().discardedJobs, 1);
  assert.equal(core.world_light_section_count(), 0, 'obsolete torch light never reaches the render mesh');
  world.lightingWorker.emit(await processor(await launchLighting(world)));
  assert.ok([...world.columns.get('-2,-3').light.block.values()].every(bytes => bytes.every(value => value === 0)));
  assert.equal(world.lightingStats().pendingColumns, 0);
});

test('native light remains authoritative until an edit and sparse imports send only relevant halos', async t => {
  const { world } = await createWorld(t);
  world.mode = 'import'; world.store = memoryStore();
  const source = column(-2, -3);
  source.sections[0].skyLight = new Uint8Array(2048).fill(255);
  source.sections[0].blockLight = new Uint8Array(2048);
  world.ingestColumn(source); await world.store.put(column(0, -3));
  world.startLocalLighting(); world.queueMissingLighting();
  assert.equal(world.lightingStats().pendingColumns, 0, 'provided Anvil lighting does not trigger replacement calculations');
  world.setBlock(-23, -56, -40, 3);
  const request = await launchLighting(world);
  assert.deepEqual(request.targets, ['-2,-3']);
  assert.deepEqual(request.columns.map(column => `${column.x},${column.z}`), ['-2,-3'], 'a distant source behind an unknown target is outside the relevant halo');
  const processor = createLightingProcessor(); await processor(world.lightingWorker.messages[0]);
  world.lightingWorker.emit(await processor(request));
  assert.equal(world.lightingStats().jobs, 1);
});
