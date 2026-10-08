import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { sourceSeed, storeSourceWorld, restoreSourceWorld } from '../generation/source-world-state.js';
const settings = id => ({ schemaVersion: 1, kind: 'source-generated', version: '1.21.11', worldKey: `generated:1.21.11:${id}`, seed: '-9223372036854775808', dimension: 'minecraft:overworld', name: 'Native terrain', spawn: [8.5, 72, 8.5], dayTime: '9223372036854775807', cycle: true });
test('source world settings preserve exact long seeds and clocks while refusing changed generation context', async () => {
  const indexedDB = new IDBFactory(), saved = settings('exact');
  await storeSourceWorld(saved, { indexedDB });
  assert.deepEqual(await restoreSourceWorld(saved.worldKey, { indexedDB }), saved);
  await assert.rejects(storeSourceWorld({ ...saved, seed: '42' }, { indexedDB }), /cannot change/);
  assert.equal((await restoreSourceWorld(saved.worldKey, { indexedDB })).seed, saved.seed);
  await storeSourceWorld({ ...saved, spawn: [40, 90, -17], dayTime: '42' }, { indexedDB });
  assert.deepEqual((await restoreSourceWorld(saved.worldKey, { indexedDB })).spawn, [40, 90, -17]);
  assert.throws(() => sourceSeed(9007199254740992), /integer seed/);
  assert.throws(() => sourceSeed('9223372036854775808'), /signed 64-bit/);
});
test('source world settings bound retained worlds and suppress stale writes', async () => {
  const indexedDB = new IDBFactory();
  for (let index = 0; index < 9; index++) await storeSourceWorld(settings(`world-${index}`), { indexedDB });
  assert.equal(await restoreSourceWorld('generated:1.21.11:world-0', { indexedDB }), null);
  assert.ok(await restoreSourceWorld('generated:1.21.11:world-8', { indexedDB }));
  assert.equal(await storeSourceWorld(settings('stale'), { indexedDB, isCurrent: () => false }), false);
  assert.equal(await restoreSourceWorld('generated:1.21.11:stale', { indexedDB }), null);
});
