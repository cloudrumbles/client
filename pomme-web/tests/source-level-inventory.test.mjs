import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from '../vendor/fflate.js';
import { readSourceLevelInventory, planSourceInventoryBootstrap, unavailableSourceLevelInventory } from '../src/source-level-inventory.js';
import { InventoryRuntime } from '../authority/inventory.js';
import { nativeFixtures } from '../authority/tests/inventory-fixtures.js';
import { IDBFactory } from 'fake-indexeddb';
import { storeSourceLevelInventory, restoreSourceLevelInventory } from '../src/source-level-inventory.js';
import { sourceInventoryNumericVectors } from './fixtures/source-inventory-numeric.js';
const encode = new TextEncoder(), concat = parts => { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };
function number(bytes, value) { const result = new Uint8Array(bytes), view = new DataView(result.buffer); if (bytes === 1) view.setInt8(0, value); else if (bytes === 2) view.setInt16(0, value); else if (bytes === 4) view.setInt32(0, value); else view.setBigInt64(0, value); return result; }
const text = value => { const data = encode.encode(value); return concat([number(2, data.length), data]); };
function payload(type, value) {
  if (type >= 1 && type <= 4) return number([0, 1, 2, 4, 8][type], value);
  if (type === 5 || type === 6) { const result = new Uint8Array(type === 5 ? 4 : 8), view = new DataView(result.buffer); if (type === 5) view.setFloat32(0, value); else view.setFloat64(0, value); return result; }
  if (type === 8) return text(value);
  if (type === 7) return concat([number(4, value.length), new Uint8Array(value)]);
  if (type === 10) return concat([...Object.entries(value).map(([name, [kind, child]]) => concat([number(1, kind), text(name), payload(kind, child)])), number(1, 0)]);
  if (type === 9) return concat([number(1, value.type), number(4, value.entries.length), ...value.entries.map(entry => payload(value.type, entry))]);
  if ([11, 12].includes(type)) return concat([number(4, value.length), ...value.map(entry => number(type === 11 ? 4 : 8, entry))]);
  throw new Error(`Unsupported mechanical fixture tag ${type}.`);
}
const fixture = (registry, player) => concat([number(1, 10), text(''), payload(10, { Data: [10, { DataVersion: [3, registry.version.dataVersion], Version: [10, { Name: [8, registry.version.minecraftVersion] }], ...(player ? { Player: [10, player] } : {}) }] })]);
const registry = {};
for (const version of ['1.20.4', '1.21.11']) registry[version] = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url)));
const list = entries => [9, { type: 10, entries }];
const legacy = (slot, name, count, extra = {}) => ({ Slot: [1, slot], id: [8, `minecraft:${name}`], Count: [1, count], ...extra });
const modern = (slot, name, count, extra = {}) => ({ Slot: [1, slot], id: [8, `minecraft:${name}`], ...(count === undefined ? {} : { count: [3, count] }), ...extra });
const id = (r, name) => r.items.find(item => item.name === name).id;

test('source legacy inventory maps native signed-slot main, armor and offhand without losing tag types', async () => {
  const r = registry['1.20.4'], source = await readSourceLevelInventory(gzipSync(fixture(r, { SelectedItemSlot: [3, 2], Inventory: list([
    legacy(0, 'oak_planks', 10), legacy(9, 'stone', 3), legacy(100, 'diamond_boots', 1), legacy(103, 'diamond_helmet', 1), legacy(-106, 'shield', 1),
    legacy(2, 'oak_planks', 1, { tag: [10, { byte: [1, 1], integer: [3, 1], seed: [4, -9223372036854775808n], bytes: [7, [255, 128]], ints: [11, [1, -1]], longs: [12, [-1n, 2n]], nested: list([{ field: [2, 12] }]) }] }),
  ]) })));
  const plan = planSourceInventoryBootstrap(source, { registry: r }); assert.equal(plan.ready, true); assert.equal(plan.selected, 2);
  assert.equal(plan.player[0].itemCount, 10); assert.equal(plan.player[9].itemId, id(r, 'stone'));
  assert.equal(plan.player[36].itemId, id(r, 'diamond_boots')); assert.equal(plan.player[39].itemId, id(r, 'diamond_helmet')); assert.equal(plan.player[40].itemId, id(r, 'shield'));
  assert.equal(plan.player[2].nbtData.value.byte.type, 'byte'); assert.equal(plan.player[2].nbtData.value.integer.type, 'int');
  assert.equal(plan.player[2].nbtData.value.seed.value, -9223372036854775808n); assert.deepEqual(plan.player[2].nbtData.value.bytes.value, new Uint8Array([255, 128]));
  assert.equal(plan.player[2].nbtData.value.nested.value.type, 'compound'); assert.equal(plan.player[2].nbtData.value.nested.value.value[0].field.type, 'short');
  assert.equal(plan.player[36].nbtData.value.Damage.type, 'int'); assert.equal(plan.player[36].nbtData.value.Damage.value, 0, 'Native depleted-item load materializes a nonnegative integer damage tag.');
});

test('source native duplicate/empty/count rules differ by version and source records stay untouched', async () => {
  const old = registry['1.20.4'], oldSource = await readSourceLevelInventory(fixture(old, { Inventory: list([legacy(0, 'oak_planks', 10), legacy(0, 'oak_planks', 0), legacy(0, 'air', 1), legacy(1, 'stone', -1)]) }), { raw: true });
  const before = structuredClone(oldSource), oldPlan = planSourceInventoryBootstrap(oldSource, { registry: old });
  assert.equal(oldPlan.player[0].itemCount, 10); assert.equal(oldPlan.player[1].present, false); assert.deepEqual(structuredClone(oldSource), before);
  const r = registry['1.21.11'], source = await readSourceLevelInventory(fixture(r, { Inventory: list([modern(0, 'oak_planks', 10), modern(0, 'air', 1), modern(1, 'stone'), modern(2, 'stone', 0), modern(3, 'stone', 100), modern(100, 'diamond_boots', 1)]) }), { raw: true });
  const plan = planSourceInventoryBootstrap(source, { registry: r }); assert.equal(plan.ready, true); assert.equal(plan.player[0].present, false);
  for (const index of [1, 2, 3]) assert.equal(plan.player[index].itemCount, 1, 'Modern count field has native default/fallback one.');
  assert.equal(plan.player[36].present, false, 'Modern Inventory.load ignores legacy equipment slot records.');
});
test('original-Java-checked legacy floating getters floor and narrow bytes while modern codecs truncate', async () => {
  for (const version of ['1.20.4', '1.21.11']) {
    const r = registry[version], old = version === '1.20.4';
    for (const vector of sourceInventoryNumericVectors) {
      const countKey = old ? 'Count' : 'count', nativeSlot = old ? vector.legacyByte : vector.modernByte;
      const source = await readSourceLevelInventory(fixture(r, { Inventory: list([{ Slot: [vector.type, vector.value], id: [8, 'minecraft:oak_planks'], [countKey]: [1, 3] }]) }), { raw: true });
      const before = structuredClone(source), plan = planSourceInventoryBootstrap(source, { registry: r });
      const index = nativeSlot < 36 ? nativeSlot : old && nativeSlot === 150 ? 40 : -1;
      assert.deepEqual(plan.player.filter(stack => stack.present).map(stack => stack.itemCount), index === -1 ? [] : [3], `${version} numeric Slot ${vector.type}:${vector.value}`);
      if (index !== -1) assert.equal(plan.player[index].itemCount, 3); assert.deepEqual(structuredClone(source), before);
      const countSource = await readSourceLevelInventory(fixture(r, { Inventory: list([{ Slot: [1, 0], id: [8, 'minecraft:oak_planks'], [countKey]: [vector.type, vector.value] }]) }), { raw: true });
      const countPlan = planSourceInventoryBootstrap(countSource, { registry: r });
      const signed = vector.legacyByte > 127 ? vector.legacyByte - 256 : vector.legacyByte;
      const expectedCount = old ? Math.max(0, signed) : vector.modernInt >= 1 && vector.modernInt <= 99 ? vector.modernInt : 1;
      assert.equal(countPlan.player[0].itemCount ?? 0, expectedCount, `${version} numeric Count ${vector.type}:${vector.value}`);
    }
  }
  const r = registry['1.20.4'], damage = await readSourceLevelInventory(fixture(r, { Inventory: list([legacy(0, 'diamond_sword', 1, { tag: [10, { Damage: [6, -Infinity] }] })]) }), { raw: true });
  assert.equal(planSourceInventoryBootstrap(damage, { registry: r }).player[0].nbtData.value.Damage.value, 2147483647, 'Legacy Mth.floor underflow wraps before native nonnegative Damage materialization.');
});

test('source modern equipment uses its own native save map and primitive patches convert explicitly', async () => {
  const r = registry['1.21.11'], source = await readSourceLevelInventory(fixture(r, { SelectedItemSlot: [3, 1], Inventory: list([
    modern(1, 'oak_planks', 1, { components: [10, { max_stack_size: [3, 16] }] }),
    modern(2, 'oak_planks', 1, { components: [10, { '!minecraft:max_stack_size': [10, {}] }] }),
  ]), equipment: [10, { feet: [10, modern(0, 'diamond_boots', 1)], head: [10, modern(0, 'diamond_helmet', 1)], offhand: [10, modern(0, 'shield', 1)], mainhand: [10, modern(0, 'stone', 4)] }] }), { raw: true });
  const plan = planSourceInventoryBootstrap(source, { registry: r }); assert.equal(plan.ready, true); assert.equal(plan.player[36].itemId, id(r, 'diamond_boots')); assert.equal(plan.player[39].itemId, id(r, 'diamond_helmet')); assert.equal(plan.player[40].itemId, id(r, 'shield'));
  assert.deepEqual(plan.player[1].components, [{ type: 'minecraft:max_stack_size', data: 16 }]); assert.deepEqual(plan.player[2].removeComponents, ['minecraft:max_stack_size']); assert.equal(plan.player[1].itemId, id(r, 'oak_planks'), 'PlayerEquipment mainhand is redirected to selected inventory.');
  const runtime = await InventoryRuntime.create({ registry: r, data: nativeFixtures(r), wasmBytes: await readFile(new URL('../authority/authority.wasm', import.meta.url)) });
  runtime.bootstrapPlayer(plan.player, plan.selected);
  const reopened = await InventoryRuntime.create({ registry: r, data: nativeFixtures(r), wasmBytes: await readFile(new URL('../authority/authority.wasm', import.meta.url)) }); reopened.restore(runtime.snapshot());
  assert.deepEqual(reopened.state().player, runtime.state().player); assert.equal(reopened.state().selected, 1);
  reopened.setSlot('cursor', 0, plan.player[2]); reopened.click('player', 2); assert.equal(reopened.state().player[2].itemCount, 1); assert.equal(reopened.state().cursor.itemCount, 1, 'Removed native maximum stack size stays nonstackable after reopen.');
});
test('native source bootstrap is atomic, component-table-safe and cannot replace accepted state', async () => {
  const r = registry['1.21.11'], wasmBytes = await readFile(new URL('../authority/authority.wasm', import.meta.url));
  const runtime = await InventoryRuntime.create({ registry: r, data: nativeFixtures(r), wasmBytes }), player = Array.from({ length: 41 }, () => ({ present: false }));
  player[0] = { present: true, itemId: id(r, 'oak_planks'), itemCount: 3, components: [{ type: 'custom_name', data: 'Source identity' }] };
  player[40] = { present: true, itemId: id(r, 'stone'), itemCount: 100 };
  const before = runtime.snapshot(); assert.throws(() => runtime.bootstrapPlayer(player, 0), /count/); assert.deepEqual(runtime.snapshot(), before, 'Rejected source slot restores even the staged component table.');
  player[40].itemCount = 1; runtime.bootstrapPlayer(player, 2); const accepted = runtime.snapshot();
  assert.equal(runtime.state().player[0].itemCount, 3); assert.equal(runtime.state().player[40].itemCount, 1); assert.equal(runtime.state().selected, 2);
  assert.throws(() => runtime.bootstrapPlayer(Array.from({ length: 41 }, () => ({ present: false }))), /empty unsaved/); assert.deepEqual(runtime.snapshot(), accepted);
});

test('source bootstrap cache preserves typed source, matching world identity and guarded queued writes', async () => {
  const indexedDB = new IDBFactory(), r = registry['1.20.4'], source = await readSourceLevelInventory(fixture(r, { Inventory: list([legacy(-106, 'shield', 1, { tag: [10, { id: [4, 7n], raw: [7, [255, 128]] }] })]) }), { raw: true });
  const worldKey = 'import:'.padEnd(4096, 'x'); assert.equal(await storeSourceLevelInventory(worldKey, source, { indexedDB }), true);
  assert.deepEqual(await restoreSourceLevelInventory(worldKey, { indexedDB }), structuredClone(source));
  assert.equal(await restoreSourceLevelInventory('different-world', { indexedDB }), null);
  const changed = structuredClone(source); changed.player.value.Inventory.value.entries[0].value.Count.value = 2;
  assert.equal(await storeSourceLevelInventory(worldKey, changed, { indexedDB, isCurrent: () => false }), false);
  assert.deepEqual(await restoreSourceLevelInventory(worldKey, { indexedDB }), structuredClone(source));
  await storeSourceLevelInventory(worldKey, changed, { indexedDB }); assert.equal((await restoreSourceLevelInventory(worldKey, { indexedDB })).player.value.Inventory.value.entries[0].value.Count.value, 2);
  assert.equal(await restoreSourceLevelInventory(worldKey, { indexedDB, isCurrent: () => false }), null);
  assert.throws(() => storeSourceLevelInventory('x'.repeat(4097), source, { indexedDB }), /world key/);
});

test('source bootstrap cache evicts bounded old worlds and rejects excess outstanding source writes', async () => {
  const indexedDB = new IDBFactory(), r = registry['1.20.4'], source = await readSourceLevelInventory(fixture(r, { Inventory: list([]) }), { raw: true });
  for (let i = 0; i < 9; i++) await storeSourceLevelInventory(`world-${i}`, source, { indexedDB });
  assert.equal(await restoreSourceLevelInventory('world-0', { indexedDB }), null); assert.ok(await restoreSourceLevelInventory('world-8', { indexedDB }));
  const queued = Array.from({ length: 8 }, (_, i) => storeSourceLevelInventory(`queued-${i}`, source, { indexedDB }));
  await assert.rejects(storeSourceLevelInventory('overflow', source, { indexedDB }), /queue/); await Promise.all(queued);
});

test('source component save payloads need explicit codecs and unsupported records are preserved', async () => {
  const r = registry['1.21.11'], source = await readSourceLevelInventory(fixture(r, { Inventory: list([modern(0, 'oak_planks', 1, { components: [10, { 'minecraft:custom_data': [10, { byte: [1, 1], integer: [3, 1], long: [4, 7n] }] }] })]) }), { raw: true }), before = structuredClone(source);
  const plan = planSourceInventoryBootstrap(source, { registry: r }); assert.equal(plan.ready, false); assert.match(plan.deferred[0].reason, /explicit source codec/);
  assert.equal(plan.player[0].components, undefined, 'Raw save NBT is never silently used as decoded protocol component data.'); assert.deepEqual(plan.source, structuredClone(source)); assert.deepEqual(structuredClone(source), before);
  assert.equal(plan.deferred[0].component.value.value.byte.type, 1); assert.equal(plan.deferred[0].component.value.value.integer.type, 3);
  const exactCodec = tag => ({ encodedNativeNbt: tag });
  const converted = planSourceInventoryBootstrap(source, { registry: r, componentDecoders: new Map([['minecraft:custom_data', exactCodec]]) });
  assert.equal(converted.ready, true); assert.equal(converted.player[0].components[0].data.encodedNativeNbt.value.long.value, 7n);
});

test('source bootstrap defers data fixing, invalid selected slots, overflow and native tag hooks', async () => {
  const r = registry['1.20.4'];
  for (const [player, reason] of [
    [{ SelectedItemSlot: [3, 9], Inventory: list([]) }, /selected hotbar/],
    [{ Inventory: list([legacy(0, 'oak_planks', 127)]) }, /authority bound/],
    [{ Inventory: list([legacy(0, 'player_head', 1, { tag: [10, { SkullOwner: [8, 'Native player'] }] })]) }, /verifyTagAfterLoad/],
  ]) {
    const source = await readSourceLevelInventory(fixture(r, player), { raw: true }), plan = planSourceInventoryBootstrap(source, { registry: r }); assert.equal(plan.ready, false); assert.ok(plan.deferred.some(entry => reason.test(entry.reason)));
  }
  const source = await readSourceLevelInventory(fixture(r, { Inventory: list([]) }), { raw: true }); assert.equal(planSourceInventoryBootstrap(source, { registry: registry['1.21.11'] }).ready, false);
  assert.equal((await readSourceLevelInventory(fixture(r), { raw: true })).present, false);
  await assert.rejects(readSourceLevelInventory(new Uint8Array(16 * 1024 * 1024 + 1), { raw: true }), /file limit/);
  await assert.rejects(readSourceLevelInventory(fixture(r, { Inventory: list([]) }).subarray(0, 8), { raw: true }), /Truncated/);
});

test('unread source markers remain deferred through cache reopen without seeding empty source', async () => {
  const r = registry['1.21.11'], indexedDB = new IDBFactory();
  let error; try { await readSourceLevelInventory(new Uint8Array([10, 0, 0]), { raw: true }); } catch (failure) { error = failure; }
  assert.ok(error);
  const marker = unavailableSourceLevelInventory(error, { version: r.version.minecraftVersion, dataVersion: r.version.dataVersion });
  assert.equal(marker.present, true); assert.equal(marker.player, null);
  const plan = planSourceInventoryBootstrap(marker, { registry: r }); assert.equal(plan.ready, false); assert.equal(plan.present, true); assert.match(plan.deferred[0].reason, /Truncated/);
  await storeSourceLevelInventory('unread-source', marker, { indexedDB }); assert.deepEqual(await restoreSourceLevelInventory('unread-source', { indexedDB }), marker);
  assert.equal(unavailableSourceLevelInventory('x'.repeat(1024)).unavailable.reason.length, 512);
  assert.throws(() => planSourceInventoryBootstrap({ ...marker, player: { type: 10, value: {} } }, { registry: r }), /marker/);
});
