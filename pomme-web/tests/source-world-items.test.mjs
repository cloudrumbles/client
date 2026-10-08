import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { classifySourceRegionFiles, readSourceWorldItems, readSourceWorldItemChunk, unavailableSourceWorldItems, storeSourceWorldItems, restoreSourceWorldItems } from '../src/source-world-items.js';
import { sourceItemRecord, sourceItemsRegion, encodeSourceItemNbt } from './fixtures/source-world-items-nbt.js';
import { planSourceWorldItems } from '../src/local-world-items.js';
for (const version of ['1.20.4', '1.21.11']) test(`source ${version} typed terrain/entity-region records preserve native source codecs and owner identity`, async () => {
  const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url))), region = sourceItemsRegion(version, [sourceItemRecord(version, { item: version === '1.20.4' ? { tag: [10, { seed: [4, 7n] }] } : { components: [10, { max_stack_size: [3, 16] }] } })]);
  const before = region.slice(), source = await readSourceWorldItems([region], { version }); assert.deepEqual(region.slice(), before); assert.equal(source.records.length, 1);
  const plan = planSourceWorldItems(source.records, { registry, version, dataVersion: source.dataVersion }); assert.equal(plan.snapshot.items[0].stack.itemCount, 7); assert.equal(plan.snapshot.items[0].target, '12345678-1234-5678-1234-567812345678');
  if (version === '1.20.4') assert.equal(plan.snapshot.items[0].stack.nbtData.value.seed.value, 7n); else assert.equal(plan.snapshot.items[0].stack.components[0].data, 16);
  const terrain = await readSourceWorldItems([sourceItemsRegion(version, [sourceItemRecord(version)], { compressed: false, terrain: true })], { version }); assert.equal(terrain.records.length, 1);
  assert.equal(await readSourceWorldItems([region], { version, isCurrent: () => false }), null);
});
test('source item region classification and bounded corruption never turn unread entities into empty source', async () => {
  const terrain = { name: 'r.0.0.mca' }, entity = { name: 'r.0.0.mca', webkitRelativePath: 'world/entities/r.0.0.mca' }, explicit = { name: 'r.1.0.mca' };
  assert.deepEqual(classifySourceRegionFiles([terrain, entity], { entityRegions: [explicit] }), { terrainRegions: [terrain], entityRegions: [entity, explicit] });
  const otherDimension = { name: 'r.0.0.mca', webkitRelativePath: 'world/DIM-1/region/r.0.0.mca' }, nestedEntities = { name: 'r.0.0.mca', webkitRelativePath: 'world/DIM-1/entities/r.0.0.mca' };
  assert.deepEqual(classifySourceRegionFiles([terrain, entity, otherDimension, nestedEntities]), { terrainRegions: [terrain], entityRegions: [entity] });
  assert.deepEqual(classifySourceRegionFiles([{ name: 'r.0.0.mca', webkitRelativePath: 'DIM-1/region/r.0.0.mca' }]), { terrainRegions: [{ name: 'r.0.0.mca', webkitRelativePath: 'DIM-1/region/r.0.0.mca' }], entityRegions: [] });
  await assert.rejects(readSourceWorldItems([sourceItemsRegion('1.20.4', [], { position: [1, 0] })]), /coordinates/);
  const external = sourceItemsRegion('1.20.4'); external[8196] |= 128; await assert.rejects(readSourceWorldItems([external]), /external/);
  const wrong = sourceItemsRegion('1.20.4'); wrong[8196] = 4; await assert.rejects(readSourceWorldItems([wrong]), /compression/);
  assert.throws(() => readSourceWorldItemChunk(encodeSourceItemNbt({ Entities: [3, 0] })), /compound list/);
  const overflow = Array.from({ length: 1025 }, (_, ordinal) => sourceItemRecord('1.20.4', { ordinal })); await assert.rejects(readSourceWorldItems([sourceItemsRegion('1.20.4', overflow)]), /actor limit/);
});
test('typed ground source cache preserves original records, stale guards, unavailable markers and bounded worlds', async () => {
  const indexedDB = new IDBFactory(), source = await readSourceWorldItems([sourceItemsRegion('1.20.4')], { version: '1.20.4' }), worldKey = 'items:'.padEnd(4096, 'x');
  assert.equal(await storeSourceWorldItems(worldKey, source, { indexedDB }), true); assert.deepEqual(await restoreSourceWorldItems(worldKey, { indexedDB }), structuredClone(source));
  assert.equal(await storeSourceWorldItems(worldKey, unavailableSourceWorldItems('bad input'), { indexedDB, isCurrent: () => false }), false); assert.deepEqual(await restoreSourceWorldItems(worldKey, { indexedDB }), structuredClone(source));
  const marker = unavailableSourceWorldItems('x'.repeat(1024)); assert.equal(marker.unavailable.reason.length, 512); await storeSourceWorldItems('unread', marker, { indexedDB }); assert.deepEqual(await restoreSourceWorldItems('unread', { indexedDB }), marker);
  for (let index = 0; index < 9; index++) await storeSourceWorldItems(`world-${index}`, source, { indexedDB }); assert.equal(await restoreSourceWorldItems('world-0', { indexedDB }), null);
  assert.equal(await restoreSourceWorldItems('world-8', { indexedDB, isCurrent: () => false }), null); assert.throws(() => storeSourceWorldItems('x'.repeat(4097), source, { indexedDB }), /world key/);
});
