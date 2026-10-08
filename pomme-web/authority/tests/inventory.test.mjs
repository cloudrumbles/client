import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InventoryRuntime } from '../inventory.js';
import { loadNativeCraftingData } from '../native-crafting-data.js';
const wasmBytes = await readFile(new URL('../authority.wasm', import.meta.url));
import { nativeFixtures } from './inventory-fixtures.js';
for (const version of ['1.20.4', '1.21.11']) {
  const registry = JSON.parse(await readFile(new URL(`../../data/${version}-registry.json`, import.meta.url))), id = name => registry.items.find(item => item.name === name).id;
  const make = () => InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
  const stack = (name, itemCount, fields = {}) => ({ present: true, itemId: id(name), itemCount, ...fields });
  test(`WASM ${version} crafting input consumption, native output and right click`, async () => {
    const inventory = await make(); inventory.setSlot('grid', 3, stack('oak_log', 2));
    assert.equal(inventory.state().recipeId, 'minecraft:oak_planks'); assert.equal(inventory.craft().batches, 1);
    assert.deepEqual(inventory.state().cursor, stack('oak_planks', 4)); assert.equal(inventory.state().grid[3].itemCount, 1);
    inventory.click('grid', 0, 1); inventory.click('grid', 2, 1); inventory.setSlot('grid', 3, null);
    assert.equal(inventory.state().recipeId, 'minecraft:stick'); assert.equal(inventory.craft().batches, 0, 'Different cursor item blocks taking result without consuming inputs.');
    inventory.setSlot('cursor', 0, null); assert.equal(inventory.craft().batches, 1);
    assert.deepEqual(inventory.state().cursor, stack('stick', 4)); assert.ok(inventory.state().grid.every(slot => slot.present === false));
  });
  test(`WASM ${version} native AIR and component bounds cannot mutate authoritative slots`, async () => {
    const inventory = await make(); inventory.setSlot('grid', 0, stack('air', 99));
    assert.deepEqual(inventory.state().grid[0], { present: false }); assert.equal(inventory.state().recipeId, null);
    inventory.setSlot('player', 0, stack('oak_log', 2)); const before = inventory.snapshot();
    assert.throws(() => inventory.setSlot('player', 0, stack('oak_log', 2, { components: [{ type: 'minecraft:custom_name', data: 'x'.repeat(1024 * 1024) }] })), /memory limit/);
    assert.deepEqual(inventory.snapshot(), before);
    const badLimit = structuredClone(before); badLimit.words[7 + 9 * 4 + 3] = 99;
    assert.throws(() => inventory.restore(badLimit), /native stack limits/); assert.deepEqual(inventory.snapshot(), before);
  });
  test(`WASM ${version} component aliases and accepted boundary saves retain native identity`, async () => {
    const inventory = await make();
    inventory.setSlot('player', 0, stack('oak_planks', 10, { components: [{ type: 'minecraft:max_stack_size', data: 64 }] }));
    inventory.setSlot('cursor', 0, stack('oak_planks', 5, { components: [{ type: 'max_stack_size', data: 64 }] }));
    inventory.click('player', 0); assert.equal(inventory.state().player[0].itemCount, 15); assert.deepEqual(inventory.state().cursor, { present: false });
    const boundary = await make();
    boundary.setSlot('player', 0, stack('oak_planks', 1, { nbtData: { custom: 'x'.repeat(1048530) } }));
    assert.equal(boundary.componentBytes, 4194302); const saved = boundary.snapshot(), reopened = await make();
    reopened.restore(saved); assert.deepEqual(reopened.snapshot(), saved);
  });
  test(`WASM ${version} components, bounded crafting and atomic persisted restore`, async () => {
    const inventory = await make(), components = [{ type: 'minecraft:custom_name', data: { text: 'Private stack', color: 'red' } }];
    inventory.setSlot('player', 8, stack('oak_planks', 3, { components, nbtData: { custom: { type: 'long', value: 7n } } }));
    inventory.setSlot('grid', 0, stack('oak_log', 17));
    assert.equal(inventory.craft({ destination: 'inventory', batches: 16 }).batches, 16);
    assert.deepEqual(inventory.state().player[8].components, components); assert.equal(inventory.state().player[8].itemCount, 3);
    assert.equal(inventory.state().player[7].itemCount, 64, 'Quick move searches the reversed native hotbar first and preserves distinct components.');
    const saved = inventory.snapshot(), restored = await make(); restored.restore(saved); assert.deepEqual(restored.state(), inventory.state());
    const corrupt = structuredClone(saved); corrupt.words[8] = 100; assert.throws(() => restored.restore(corrupt), /rejected/); assert.deepEqual(restored.snapshot(), saved);
    const unknown = structuredClone(saved); unknown.words[9] = 4000; assert.throws(() => restored.restore(unknown), /unknown component/);
    assert.throws(() => restored.restore({ ...saved, fingerprint: 'wrong' }), /different native/);
    assert.throws(() => inventory.craft({ batches: 65 }), /batch/); assert.throws(() => inventory.setSlot('player', 0, stack('oak_log', 100)), /count/);
  });
}
test('real original-JAR recipe extraction, native tags and cake bucket remainders', { skip: !process.env.POMME_MINECRAFT_JAR }, async () => {
  const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', registry = JSON.parse(await readFile(new URL(`../../data/${version}-registry.json`, import.meta.url))), id = name => registry.items.find(item => item.name === name).id;
  const data = await loadNativeCraftingData(await readFile(process.env.POMME_MINECRAFT_JAR), { registry });
  assert.ok(data.recipes.length > 800); assert.ok(data.unsupported.length > 10);
  const inventory = await InventoryRuntime.create({ registry, data, wasmBytes, width: 3 });
  const names = ['milk_bucket', 'milk_bucket', 'milk_bucket', 'sugar', 'egg', 'sugar', 'wheat', 'wheat', 'wheat'];
  names.forEach((name, index) => inventory.setSlot('grid', index, { present: true, itemId: id(name), itemCount: 1 }));
  assert.equal(inventory.state().recipeId, 'minecraft:cake'); assert.equal(inventory.craft().batches, 1); assert.equal(inventory.state().cursor.itemId, id('cake'));
  assert.deepEqual(inventory.state().grid.slice(0, 3).map(slot => slot.itemId), [id('bucket'), id('bucket'), id('bucket')]);
  assert.ok(inventory.state().grid.slice(3).every(slot => slot.present === false));
});

test('modern removed stack-size component uses native fallback one and survives restore', async () => {
  const registry = JSON.parse(await readFile(new URL('../../data/1.21.11-registry.json', import.meta.url))), id = registry.items.find(item => item.name === 'oak_planks').id;
  const inventory = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
  const removed = { present: true, itemId: id, itemCount: 1, removeComponents: ['max_stack_size'] };
  inventory.setSlot('player', 0, removed); inventory.setSlot('cursor', 0, { ...removed, removeComponents: ['minecraft:max_stack_size'], components: [{ type: 'max_stack_size', data: 64 }] });
  inventory.click('player', 0); assert.equal(inventory.state().player[0].itemCount, 1); assert.equal(inventory.state().cursor.itemCount, 1);
  assert.deepEqual(inventory.state().cursor.removeComponents, ['minecraft:max_stack_size']); assert.equal(inventory.state().cursor.components, undefined);
  const saved = inventory.snapshot(), reopened = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes });
  reopened.restore(saved); assert.deepEqual(reopened.state(), inventory.state());
});
