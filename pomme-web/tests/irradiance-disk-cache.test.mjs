import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { IrradianceDiskCache, IRRADIANCE_DISK_DATABASE, IRRADIANCE_DISK_LIMITS } from '../src/irradiance-disk-cache.js';
import { IrradianceSunCache } from '../src/irradiance-sun-cache.js';

const source = ordinal => ordinal.toString(16).padStart(64, '0');
function value(cells = 64, angle = 0, runs = false) {
  const localData = new Uint16Array(cells * 4), alpha = new Uint16Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    localData.set([cell & 1 ? 0x3000 : 0, 0x3400, 0x3800, 0x3800], cell * 4);
    alpha[cell] = cell & 1 ? 0 : 0x3c00;
  }
  const entry = runs ? { rgb: Uint16Array.of(angle, 0x3000, 0x3400), lengths: Uint32Array.of(cells) }
    : { rgb: Uint16Array.from({ length: cells * 3 }, (_, index) => (index + angle) % 0x3801) };
  entry.bytes = entry.rgb.byteLength + (entry.lengths?.byteLength ?? 0);
  return { localData, alpha, entry, stats: { cells, algorithm: 'exact test transport', localCacheHit: false } };
}
const req = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const done = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error); });
async function inspect(cache) {
  const database = await cache.open(), transaction = database.transaction(['sources', 'sourceMetadata', 'angles', 'angleMetadata', 'budget']), completed = done(transaction);
  const [sources, metadata, angles, angleMetadata, budget] = await Promise.all(['sources', 'sourceMetadata', 'angles', 'angleMetadata', 'budget'].map(name => req(transaction.objectStore(name).getAll())));
  await completed;
  return { sources, metadata, angles, angleMetadata, budget: budget[0] };
}
function checkAccounting(state) {
  assert.equal(state.budget.contexts, state.sources.length); assert.equal(state.budget.contexts, state.metadata.length);
  assert.equal(state.budget.entries, state.angles.length); assert.equal(state.budget.entries, state.angleMetadata.length);
  assert.equal(state.budget.bytes, state.metadata.reduce((sum, entry) => sum + entry.bytes, 0) + state.angleMetadata.reduce((sum, entry) => sum + entry.bytes, 0));
  for (const context of state.metadata) {
    const angles = state.angleMetadata.filter(angle => angle.sourceKey === context.sourceKey);
    assert.equal(context.entries, angles.length); assert.equal(context.entryBytes, angles.reduce((sum, entry) => sum + entry.bytes, 0));
  }
}

test('disk cache preserves exact dense/run half bits and shared local light across reopen', async () => {
  const indexedDB = new IDBFactory(), cache = new IrradianceDiskCache({ indexedDB }), dense = value(), compressed = value(64, 7, true);
  const expected = structuredClone(dense), pending = cache.put(source(1), 0, dense);
  dense.localData.fill(0); dense.alpha.fill(0); dense.entry.rgb.fill(0); dense.stats.cells = 1;
  assert.equal((await pending).persisted, true, 'admission snapshots buffers and metadata before yielding');
  const compressedWrite = await cache.put(source(1), 1, compressed);
  assert.equal(compressedWrite.bytes, compressed.entry.bytes, 'later angles do not write shared lighting again');
  const stored = await cache.get(source(1), 0);
  assert.deepEqual(stored.localData, expected.localData); assert.deepEqual(stored.alpha, expected.alpha); assert.deepEqual(stored.entry, expected.entry); assert.deepEqual(stored.stats, expected.stats);
  stored.localData.fill(0); stored.alpha.fill(0); stored.entry.rgb.fill(0);
  assert.deepEqual((await cache.get(source(1), 0)).localData, expected.localData, 'reads are detached');
  const state = await inspect(cache); checkAccounting(state); assert.equal(state.sources.length, 1); assert.equal(state.angles.length, 2);
  await cache.close();
  const reopened = new IrradianceDiskCache({ indexedDB }), restored = await reopened.get(source(1), 1), ram = new IrradianceSunCache();
  assert.deepEqual(restored.entry, compressed.entry); ram.import(1, restored);
  const data = ram.get(1);
  for (let cell = 0; cell < 64; cell++) assert.deepEqual([...data.subarray(cell * 4, cell * 4 + 4)], [7, 0x3000, 0x3400, compressed.alpha[cell]]);
  assert.ok(restored.readMs >= 0); assert.equal(restored.bytes, compressed.localData.byteLength + compressed.alpha.byteLength + compressed.entry.bytes);
  await reopened.close();
});

test('source hashes isolate worlds/material algorithms and reject conflicting shared data atomically', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() }), first = value(), other = value(); other.localData[0] = 1;
  await cache.put(source(1), 0, first); await cache.put(source(2), 0, other);
  assert.equal(await cache.put(source(1), 1, other), null);
  assert.equal(await cache.get(source(1), 1), null);
  assert.deepEqual((await cache.get(source(1), 0)).localData, first.localData);
  assert.deepEqual((await cache.get(source(2), 0)).localData, other.localData);
  checkAccounting(await inspect(cache)); await cache.close();
});

test('below-budget angle writes never read shared payloads or scan the growing catalog', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() }); await cache.put(source(1), 0, value(4096, 0, true));
  const get = IDBObjectStore.prototype.get, getAll = IDBObjectStore.prototype.getAll; let payloadReads = 0, catalogScans = 0;
  IDBObjectStore.prototype.get = function(...args) { if (this.name === 'sources') payloadReads++; return get.apply(this, args); };
  IDBObjectStore.prototype.getAll = function(...args) { if (this.name.endsWith('Metadata')) catalogScans++; return getAll.apply(this, args); };
  try { for (let angle = 1; angle < 240; angle++) assert.equal((await cache.put(source(1), angle, value(4096, angle, true))).persisted, true); }
  finally { IDBObjectStore.prototype.get = get; IDBObjectStore.prototype.getAll = getAll; }
  assert.equal(payloadReads, 0); assert.equal(catalogScans, 0);
  const state = await inspect(cache); checkAccounting(state); assert.equal(state.sources.length, 1); assert.equal(state.angles.length, 240);
  await cache.close();
});

test('an uncached angle checks metadata without loading shared or RGB payloads', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() }); await cache.put(source(1), 0, value(4096));
  const get = IDBObjectStore.prototype.get; let payloadReads = 0;
  IDBObjectStore.prototype.get = function(...args) { if (this.name === 'sources' || this.name === 'angles') payloadReads++; return get.apply(this, args); };
  try { assert.equal(await cache.get(source(1), 1), null); assert.equal(await cache.get(source(2), 0), null); }
  finally { IDBObjectStore.prototype.get = get; }
  assert.equal(payloadReads, 0); assert.ok(await cache.get(source(1), 0)); await cache.close();
});

test('per-source angles and global contexts use access order, including cross-instance touches', async () => {
  const indexedDB = new IDBFactory(), a = new IrradianceDiskCache({ indexedDB, maxAngles: 2, maxContexts: 2 }), b = new IrradianceDiskCache({ indexedDB, maxAngles: 2, maxContexts: 2 });
  await a.put(source(1), 0, value()); await a.put(source(1), 1, value(64, 1)); await b.get(source(1), 0);
  await a.put(source(1), 2, value(64, 2)); assert.equal(await a.get(source(1), 1), null); assert.ok(await a.get(source(1), 0));
  await a.put(source(2), 0, value()); await b.get(source(1), 0); await b.put(source(3), 0, value());
  assert.equal(await a.get(source(2), 0), null); assert.ok(await a.get(source(1), 0)); assert.ok(await a.get(source(3), 0));
  const state = await inspect(a); checkAccounting(state); assert.equal(state.sources.length, 2);
  await Promise.all([a.close(), b.close()]);
});

test('concurrent instances account replacement and global byte/entry eviction atomically', async () => {
  const indexedDB = new IDBFactory(), a = new IrradianceDiskCache({ indexedDB, maxBytes: 6000, maxEntries: 3 }), b = new IrradianceDiskCache({ indexedDB, maxBytes: 6000, maxEntries: 3 });
  await Promise.all([a.put(source(1), 0, value()), b.put(source(2), 0, value()), a.put(source(1), 1, value(64, 1)), b.put(source(3), 0, value())]);
  let state = await inspect(a); checkAccounting(state); assert.ok(state.budget.bytes <= 6000); assert.ok(state.budget.entries <= 3);
  const retained = state.angleMetadata.at(-1); assert.ok(retained);
  await a.get(retained.sourceKey, retained.bucket); await b.put(source(4), 0, value());
  assert.ok(await a.get(retained.sourceKey, retained.bucket), 'a cross-instance touch protects the recent angle');
  state = await inspect(a); checkAccounting(state); assert.ok(state.budget.bytes <= 6000);
  await b.put(source(4), 0, value(64, 0, true)); state = await inspect(a); checkAccounting(state);
  assert.ok(state.budget.bytes <= 6000); await Promise.all([a.close(), b.close()]);
});

test('all hard bounds retain at most eight contexts and 1920 exact angles', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() });
  for (let context = 1; context <= 8; context++) for (let bucket = 0; bucket < 240; bucket++) await cache.put(source(context), bucket, value(1, bucket, true));
  let state = await inspect(cache); checkAccounting(state); assert.equal(state.sources.length, 8); assert.equal(state.angles.length, 1920);
  await cache.get(source(1), 0); await cache.put(source(9), 0, value(1, 0, true));
  state = await inspect(cache); checkAccounting(state); assert.equal(state.sources.length, 8); assert.equal(state.angles.length, 1681);
  assert.equal(await cache.get(source(2), 0), null); assert.ok(await cache.get(source(1), 0));
  assert.ok(state.budget.bytes <= IRRADIANCE_DISK_LIMITS.maxBytes); await cache.close();
});

test('64MiB accounting includes shared buffers and evicts before a write commits', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() }), cells = 48 * 32 * 48;
  for (let context = 1; context <= 8; context++) for (let bucket = 0; bucket < 24; bucket++) {
    const result = await cache.put(source(context), bucket, value(cells, bucket)); assert.equal(result.persisted, true);
    assert.ok(cache.stats().diskCacheBytes <= 64 * 1024 * 1024);
  }
  const state = await inspect(cache); checkAccounting(state); assert.ok(state.budget.bytes <= 64 * 1024 * 1024);
  assert.ok(state.angles.length < 192, 'uncompressed full-volume angles cannot exceed the total disk budget');
  assert.ok(cache.stats().diskEvictions > 0); await cache.close();
});

test('pending snapshots and I/O stay bounded; close gates admission and drains accepted writes', async () => {
  const crypto = globalThis.crypto; let release;
  const gate = new Promise(resolve => { release = resolve; }), cache = new IrradianceDiskCache({ indexedDB: new IDBFactory(), crypto: { subtle: { digest: async (...args) => { await gate; return crypto.subtle.digest(...args); } } } });
  const writes = Array.from({ length: 8 }, (_, bucket) => cache.put(source(1), bucket, value(64, bucket)));
  assert.equal(cache.stats().diskPending, 8); assert.equal(await cache.put(source(1), 8, value()), null); assert.equal(await cache.get(source(1), 0), null);
  const closing = cache.close(); assert.equal(cache.close(), closing); assert.equal(await cache.put(source(2), 0, value()), null);
  let closed = false; void closing.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  release(); assert.ok((await Promise.all(writes)).every(result => result.persisted)); await closing; assert.equal(cache.stats().diskPending, 0);
  const reopened = new IrradianceDiskCache({ indexedDB: cache.factory }); const state = await inspect(reopened); checkAccounting(state); assert.equal(state.angles.length, 8); await reopened.close();
});

test('quota failures roll back shared records, replacements, eviction and accounting', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory(), maxEntries: 1 }); await cache.put(source(1), 0, value());
  const before = await inspect(cache), metrics = cache.stats(), put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) { if (this.name === 'angles') throw new DOMException('Injected quota failure', 'QuotaExceededError'); return put.apply(this, args); };
  try { assert.equal(await cache.put(source(2), 0, value()), null); }
  finally { IDBObjectStore.prototype.put = put; }
  const after = await inspect(cache); assert.deepEqual(after, before); assert.equal(cache.stats().diskCacheBytes, metrics.diskCacheBytes); assert.equal(cache.stats().diskEvictions, metrics.diskEvictions);
  assert.ok(await cache.get(source(1), 0)); assert.equal((await cache.put(source(2), 0, value())).persisted, true); checkAccounting(await inspect(cache)); await cache.close();
});

test('explicit clear drains already accepted hashed writes before deleting cache contents', async () => {
  const crypto = globalThis.crypto; let release;
  const gate = new Promise(resolve => { release = resolve; }), cache = new IrradianceDiskCache({ indexedDB: new IDBFactory(),
    crypto: { subtle: { digest: async (...args) => { await gate; return crypto.subtle.digest(...args); } } } });
  const writing = cache.put(source(1), 0, value()), clearing = cache.clear();
  release(); assert.equal((await writing).persisted, true); assert.equal(await clearing, true);
  const state = await inspect(cache); checkAccounting(state); assert.equal(state.budget.bytes, 0); assert.equal(state.angles.length, 0);
  await cache.close();
});

test('corrupted RGB/shared payloads and invalid accounting safely become misses', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() });
  for (const field of ['angle', 'shared', 'budget']) {
    await cache.put(source(1), 0, value()); const database = await cache.open();
    const transaction = database.transaction(field === 'angle' ? 'angles' : field === 'shared' ? 'sources' : 'budget', 'readwrite'), completed = done(transaction);
    const store = transaction.objectStore(field === 'angle' ? 'angles' : field === 'shared' ? 'sources' : 'budget'), record = await req(store.get(field === 'angle' ? [source(1), 0] : field === 'shared' ? source(1) : 'global'));
    if (field === 'angle') record.entry.rgb[0] ^= 1; else if (field === 'shared') record.localData[0] ^= 1; else record.bytes = Infinity;
    store.put(record); await completed; assert.equal(await cache.get(source(1), 0), null); checkAccounting(await inspect(cache));
  }
  assert.equal((await cache.put(source(1), 0, value())).persisted, true); assert.ok(await cache.get(source(1), 0)); await cache.close();
});

test('malformed cache inputs, unavailable IndexedDB and disabled budgets never escape into rendering', async () => {
  const cache = new IrradianceDiskCache({ indexedDB: new IDBFactory() });
  const invalid = [value(64), value(64), value(64), value(64, 0, true), value(64)];
  invalid[0].alpha[0] = 1; invalid[1].entry.rgb[0] = 0x3801; invalid[2].localData = new Uint16Array(3); invalid[3].entry.lengths[0] = 65; invalid[4].stats = { unbounded: {} };
  for (const record of invalid) assert.equal(await cache.put(source(1), 0, record), null);
  for (const [key, bucket] of [['unhashed-source', 0], [source(1), -1], [source(1), 240]]) assert.equal(await cache.put(key, bucket, value()), null);
  assert.equal((await inspect(cache)).angles.length, 0); await cache.close();
  const missing = new IrradianceDiskCache({ indexedDB: null }); assert.equal(await missing.get(source(1), 0), null); assert.equal(await missing.put(source(1), 0, value()), null); await missing.close();
  const failed = new IrradianceDiskCache({ indexedDB: { open() { throw new Error('Denied'); } } }); assert.equal(await failed.get(source(1), 0), null); await failed.close();
  const disabled = new IrradianceDiskCache({ indexedDB: new IDBFactory(), maxBytes: 0 }); assert.equal(await disabled.put(source(1), 0, value()), null); assert.equal(await disabled.clear(), true); await disabled.close();
  assert.throws(() => new IrradianceDiskCache({ maxBytes: 64 * 1024 * 1024 + 1 })); assert.throws(() => new IrradianceDiskCache({ maxPending: 9 }));
});

test('clear deletes only the disposable irradiance database stores', async () => {
  const indexedDB = new IDBFactory(), saveRequest = indexedDB.open('native-authority-test-save', 1);
  saveRequest.onupgradeneeded = () => saveRequest.result.createObjectStore('worlds');
  const saves = await req(saveRequest), write = saves.transaction('worlds', 'readwrite'), written = done(write); write.objectStore('worlds').put({ blocks: 'keep', items: 'keep' }, 'world'); await written;
  const cache = new IrradianceDiskCache({ indexedDB }); await cache.put(source(1), 0, value()); assert.equal(await cache.clear(), true);
  const state = await inspect(cache); checkAccounting(state); assert.equal(state.sources.length, 0); assert.equal(state.angles.length, 0); assert.equal(state.budget.bytes, 0);
  assert.deepEqual(await req(saves.transaction('worlds').objectStore('worlds').get('world')), { blocks: 'keep', items: 'keep' });
  assert.equal(await cache.get(source(1), 0), null); await cache.close(); saves.close();
});
