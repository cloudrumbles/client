import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fallbackMaterials, applyMaterials, activateMaterials, serializableMaterials, loadMinecraftRegistry, MaterialRegistry } from '../src/registry.js';
import { registryStates } from '../src/anvil.js';
const registry = { blocks: [
  { name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty', transparent: true },
  { name: 'stone', minStateId: 1, maxStateId: 1, boundingBox: 'block', transparent: false, filterLight: 15 },
  { name: 'oak_slab', minStateId: 2, maxStateId: 3, boundingBox: 'block', transparent: true, states: [{ name: 'type', values: ['bottom', 'top'] }] },
], blockCollisionShapes: { blocks: { air: 0, stone: 1, oak_slab: [2, 3] }, shapes: { 0: [], 1: [[0, 0, 0, 1, 1, 1]], 2: [[0, 0, 0, 1, .5, 1]], 3: [[0, .5, 0, 1, 1, 1]] } } };
function mockCore() {
  const calls = [], memory = new WebAssembly.Memory({ initial: 1 });
  const core = { memory, calls, block_registry_begin: () => { calls.push(['begin']); return 1; }, block_registry_end: () => { calls.push(['end']); return 1; },
    block_register: (...args) => { calls.push(['register', ...args]); return 1; }, block_face_tile: (...args) => { calls.push(['tile', ...args]); return 1; }, block_face_uv: (...args) => { calls.push(['uv', ...args]); return 1; },
    world_float_stage_ptr: () => 0, world_float_stage_capacity: () => 8192,
    block_model_register: (id, ptr, count) => { calls.push(['model', id, Array.from(new Float32Array(memory.buffer, ptr, count))]); return 1; },
    block_collision_register: (id, ptr, count) => { calls.push(['collision', id, Array.from(new Float32Array(memory.buffer, ptr, count * 6))]); return 1; },
  }; return core;
}
test('fallback registry preserves actual native IDs, passable air and precise slab collision boxes', () => {
  const materials = fallbackMaterials(registry);
  assert.equal(materials.size, 4); assert.equal(materials.get(0).flags, 128); assert.equal(materials.get(1).flags, 3);
  assert.deepEqual(materials.get(2).collisionBoxes, [[0, 0, 0, 1, .5, 1]]);
  assert.deepEqual(materials.get(3).collisionBoxes, [[0, .5, 0, 1, 1, 1]]);
});
test('metadata batches avoid model upload and lazy activation copies each actual template only once', () => {
  const core = mockCore(), materials = fallbackMaterials(registry), slab = materials.get(2);
  slab.flags |= 16; slab.templateVertices = new Float32Array(42).fill(.25); slab.faces = { up: { tile: 3, uv: [0, .25, 1, .75], rotation: 90 } };
  applyMaterials(core, materials);
  assert.equal(core.calls.filter(c => c[0] === 'model').length, 0);
  assert.equal(core.calls.find(c => c[0] === 'register' && c[1] === 2).at(-1) & 16, 0);
  const activated = new Set(); activateMaterials(core, materials, [2, 2], activated); activateMaterials(core, materials, [2], activated);
  assert.equal(core.calls.filter(c => c[0] === 'model').length, 1); assert.equal(core.calls.filter(c => c[0] === 'collision').length, 1);
  assert.deepEqual(core.calls.find(c => c[0] === 'collision')[2], [0, 0, 0, 1, .5, 1]);
  assert.ok(core.calls.filter(c => c[0] === 'register' && c[1] === 2).at(-1).at(-1) & 16);
  assert.equal(core.calls.filter(c => c[0] === 'begin').length, core.calls.filter(c => c[0] === 'end').length);
  const serialized = serializableMaterials(materials);
  assert.equal(serialized.get(2).templateVertices, undefined); assert.equal(serialized.get(2).collisionBoxes, undefined);
  assert.deepEqual(serialized.get(2).faces.up, slab.faces.up);
  const manager = new MaterialRegistry(registry, materials); manager.register(core); manager.activate(core, [2]);
  assert.ok(manager.definitionsFor([2])[0].templateVertices);
});
test('WASM staging failures are surfaced and never mark a model activated', () => {
  const core = mockCore(), materials = fallbackMaterials(registry), activated = new Set();
  core.block_collision_register = () => 0;
  assert.throws(() => activateMaterials(core, materials, [2], activated), /WASM rejected/); assert.equal(activated.size, 0);
  assert.equal(core.calls.at(-1)[0], 'end');
  assert.throws(() => activateMaterials(core, materials, [999]), /Unknown native/);
});
test('native registry loader validates the air ID and reports fetch failures', async () => {
  assert.equal(await loadMinecraftRegistry({ fetcher: async () => ({ ok: true, json: async () => registry }) }), registry);
  await assert.rejects(loadMinecraftRegistry({ fetcher: async () => ({ ok: false, status: 404 }) }), /404/);
  await assert.rejects(loadMinecraftRegistry({ fetcher: async () => ({ ok: true, json: async () => ({ blocks: [{ name: 'stone', minStateId: 0 }] }) }) }), /Invalid/);
});

test('generated 1.20.4 registry resolves known vanilla defaults and real collision geometry', async () => {
  const native = JSON.parse(await readFile(new URL('../data/1.20.4-registry.json', import.meta.url), 'utf8'));
  const states = registryStates(native), materials = fallbackMaterials(native);
  const block = name => native.blocks.find(b => b.name === name);
  assert.equal(states.byId.size, 26644);
  assert.equal(states.byId.get(block('grass_block').defaultState).properties.snowy, 'false');
  assert.equal(states.byId.get(block('oak_log').defaultState).properties.axis, 'y');
  assert.equal(states.byId.get(block('oak_slab').defaultState).properties.type, 'bottom');
  assert.equal(states.byId.get(block('oak_slab').defaultState).properties.waterlogged, 'false');
  assert.deepEqual(materials.get(block('oak_slab').defaultState).collisionBoxes, [[0, 0, 0, 1, .5, 1]]);
  assert.ok(materials.get(block('oak_fence').defaultState).collisionBoxes.some(box => box[4] === 1.5), 'vanilla fence collision extends above its visual block');
  assert.equal(materials.get(block('cave_air').defaultState).flags, 128);
});
