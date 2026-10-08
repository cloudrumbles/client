import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InventoryRuntime, nativeInventoryStackIdentity } from '../inventory.js';
import { nativeFixtures } from './inventory-fixtures.js';
const registry = JSON.parse(await readFile(new URL('../../data/1.21.11-registry.json', import.meta.url))), wasmBytes = await readFile(new URL('../authority.wasm', import.meta.url)), version = registry.version.minecraftVersion;
const item = name => registry.items.find(item => item.name === name), stack = (name, count, fields = {}) => ({ present: true, itemId: item(name).id, itemCount: count, ...fields });
test('native effective identity removes known unchanged defaults and retains actual component differences', async () => {
  for (const [name, patch] of [['oak_planks', [{ type: 'max_stack_size', data: 64 }]], ['diamond_sword', [{ type: 'minecraft:damage', data: 0 }, { type: 'max_damage', data: item('diamond_sword').maxDurability }]]]) {
    const ordinary = stack(name, 1), explicit = stack(name, 1, { components: patch });
    assert.equal(nativeInventoryStackIdentity(explicit, item(name), version), nativeInventoryStackIdentity(ordinary, item(name), version));
  }
  assert.notEqual(nativeInventoryStackIdentity(stack('oak_planks', 1, { components: [{ type: 'damage', data: 0 }] }), item('oak_planks'), version), nativeInventoryStackIdentity(stack('oak_planks', 1), item('oak_planks'), version));
  const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
  runtime.setSlot('player', 0, stack('oak_planks', 10, { components: [{ type: 'max_stack_size', data: 64 }] })); runtime.setSlot('cursor', 0, stack('oak_planks', 5)); runtime.menuClick(36);
  assert.equal(runtime.state().player[0].itemCount, 15); assert.equal(runtime.state().cursor.present, false);
  assert.notEqual(nativeInventoryStackIdentity(stack('oak_planks', 1, { components: [{ type: 'max_stack_size', data: 1 }] }), item('oak_planks'), version), nativeInventoryStackIdentity(stack('oak_planks', 1, { removeComponents: ['max_stack_size'] }), item('oak_planks'), version));
});
test('accepted old explicit-default component saves migrate atomically without changing counts or unknown identity', async () => {
  const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); runtime.setSlot('player', 0, stack('oak_planks', 10)); runtime.setSlot('cursor', 0, stack('oak_planks', 5));
  const saved = runtime.snapshot(), id = saved.components.length; saved.components.push({ components: [{ type: 'minecraft:max_stack_size', data: 64 }] }); saved.words[7 + 9 * 4 + 2] = id;
  const restored = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); restored.restore(saved); restored.menuClick(36); assert.equal(restored.state().player[0].itemCount, 15); assert.equal(restored.state().cursor.present, false);
  const opaque = stack('oak_planks', 3, { nbtData: { untouched: 7n }, components: [{ type: 'max_stack_size', data: 16 }] }); restored.setSlot('player', 9, opaque);
  const again = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); again.restore(restored.snapshot()); assert.deepEqual(again.state().player[9], { ...opaque, components: [{ type: 'minecraft:max_stack_size', data: 16 }] });
  const malformed = again.snapshot(); malformed.words[7 + 9 * 4 + 2] = 4096; const before = again.snapshot(); assert.throws(() => again.restore(malformed), /component reference/); assert.deepEqual(again.snapshot(), before);
});
test('legacy empty native compound tags equal absence without discarding typed nonempty tags', async () => {
  const registry = JSON.parse(await readFile(new URL('../../data/1.20.4-registry.json', import.meta.url))), definition = registry.items.find(item => item.name === 'oak_planks'), bare = { present: true, itemId: definition.id, itemCount: 10 }, tagged = { ...bare, nbtData: { type: 'compound', value: {} } };
  assert.equal(nativeInventoryStackIdentity(bare, definition, '1.20.4'), nativeInventoryStackIdentity(tagged, definition, '1.20.4'));
  assert.notEqual(nativeInventoryStackIdentity(bare, definition, '1.20.4'), nativeInventoryStackIdentity({ ...bare, nbtData: { type: 'compound', value: { exact: { type: 'byte', value: 0 } } } }, definition, '1.20.4'));
  const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); runtime.setSlot('player', 0, tagged); runtime.setSlot('cursor', 0, { ...bare, itemCount: 5 }); runtime.menuClick(36); assert.equal(runtime.state().player[0].itemCount, 15); assert.equal(runtime.state().cursor.present, false);
});
