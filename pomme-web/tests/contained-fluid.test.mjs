import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nativeContainedFluid, MATERIAL_FLAGS as F } from '../src/assets.js';
import { fallbackMaterials, applyMaterials, serializableMaterials } from '../src/registry.js';
import { fluidState } from '../src/movement.js';

test('native fluid states retain render flags while plants, waterlogged solids and falling fluid carry water', () => {
  for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']) {
    const contained = nativeContainedFluid(`minecraft:${name}`, { age: '25', half: 'upper' });
    assert.deepEqual(contained, { kind: 1, level: 0 });
    assert.deepEqual(fluidState({ name, properties: {}, fluid: contained }), { kind: 'water', height: 8 / 9, falling: false });
    assert.deepEqual(fluidState({ name, properties: {} }), { kind: 'water', height: 8 / 9, falling: false });
  }
  const solid = { name: 'minecraft:oak_slab', flags: F.SOLID | F.CUSTOM_MODEL,
    collisionBoxes: [[0, 0, 0, 1, .5, 1]], properties: { type: 'bottom', waterlogged: 'true' } };
  solid.fluid = nativeContainedFluid(solid.name, solid.properties);
  assert.equal(solid.flags & F.FLUID, 0);
  assert.deepEqual(fluidState(solid), { kind: 'water', height: 8 / 9, falling: false });
  assert.deepEqual(solid.collisionBoxes, [[0, 0, 0, 1, .5, 1]]);
  assert.equal(nativeContainedFluid('oak_slab', { waterlogged: 'false' }), null);
  assert.equal(nativeContainedFluid('water_cauldron'), null, 'cauldron water has no block FluidState');
  for (const name of ['water', 'lava']) for (let level = 0; level < 16; level++) {
    const contained = nativeContainedFluid(name, { level: String(level) });
    const fluid = fluidState({ name, flags: F.FLUID, fluid: contained });
    assert.equal(fluid.kind, name);
    assert.equal(fluid.height, (level === 0 || level >= 8 ? 8 : 8 - level) / 9);
    assert.equal(fluid.falling, level >= 8);
  }
});

test('native registries serialize contained fluid separately from original collision and render metadata', async () => {
  const registry = JSON.parse(await readFile(new URL('../data/1.21.11-registry.json', import.meta.url)));
  const materials = fallbackMaterials(registry), serialized = serializableMaterials(materials);
  for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']) {
    const states = [...materials.values()].filter(material => material.name === `minecraft:${name}`);
    assert.ok(states.length);
    for (const material of states) {
      assert.equal(material.flags & F.FLUID, 0);
      assert.deepEqual(material.fluid, { kind: 1, level: 0, stillTile: -1, flowTile: -1 });
      assert.deepEqual(material.collisionBoxes, []);
      assert.deepEqual(serialized.get(material.id).fluid, material.fluid);
      assert.notEqual(serialized.get(material.id).fluid, material.fluid);
    }
  }
  const calls = [], core = { block_register: () => 1,
    block_fluid_register: (...args) => { calls.push(args); return 1; } };
  applyMaterials(core, new Map([[20, { id: 20, flags: F.CUSTOM_MODEL | F.CUTOUT, fluid: { kind: 1, level: 0, stillTile: 4, flowTile: 5 } }],
    [21, { id: 21, flags: F.SOLID, fluid: null }]]));
  assert.deepEqual(calls, [[20, 1, 0, 4, 5], [21, 0, 0, -1, -1]]);
  core.block_fluid_register = () => 0;
  assert.throws(() => applyMaterials(core, [{ id: 20, flags: F.SOLID }]), /WASM rejected contained fluid/);
});
