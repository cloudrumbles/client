import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { gzipSync } from '../vendor/fflate.js';
import { CHUNK_STORE_DATABASE, ChunkStore, encodeColumn, decodeColumn, encodedColumnBytes, decodedColumnBytes } from '../src/chunk-store.js';

function column(x = 0, z = 0, id = 1) {
  const blocks = new Uint16Array(4096); blocks.fill(id);
  return { x, z, sections: [{ sectionY: -4, blocks }] };
}

test('full-column codec stores uniform sections compactly and preserves mixed high state IDs', () => {
  const source = column(-123, 456, 55000);
  source.sections.push({ sectionY: 19, blocks: new Uint16Array(4096) });
  source.sections[1].blocks[0] = 1;
  source.sections[1].blocks[77] = 65535;
  const packed = encodeColumn(source);
  assert.deepEqual(packed.sections[0].states, { format: 'uniform', stateId: 55000 });
  assert.equal(packed.sections[1].states.format, 'gzip-u16le');
  assert.ok(encodedColumnBytes(packed) < 1000, 'mostly-uniform sections should not retain full raw arrays');
  const restored = decodeColumn(packed);
  assert.equal(restored.x, -123); assert.equal(restored.z, 456);
  assert.deepEqual(restored.sections.map(section => section.blocks), source.sections.map(section => section.blocks));
  source.sections[0].blocks.fill(0);
  assert.equal(restored.sections[0].blocks[0], 55000, 'codec does not retain the caller buffer');
});

test('section and column light maps and biome IDs survive compression exactly', () => {
  const source = column();
  const sky = new Uint8Array(2048); sky.fill(255);
  const block = Uint8Array.from({ length: 2048 }, (_, i) => i & 255);
  source.sections[0].skyLight = sky;
  source.sections[0].blockLight = block;
  source.sections[0].biomes = Uint32Array.from({ length: 64 }, (_, i) => i + 16777216);
  source.light = { sky: new Map([[-4, sky]]), block: new Map([[-3, block]]) };
  const restored = decodeColumn(encodeColumn(source));
  assert.deepEqual(restored.sections[0].skyLight, sky);
  assert.deepEqual(restored.sections[0].blockLight, block);
  assert.deepEqual(restored.sections[0].biomes, source.sections[0].biomes);
  assert.deepEqual(restored.light.sky.get(-4), sky);
  assert.deepEqual(restored.light.block.get(-3), block);
});

test('block entity NBT survives full-column persistence with lossless bigint/typed arrays and bounded budgets', async () => {
  const source = column(-2, 3), indexedDB = new IDBFactory();
  source.blockEntities = [{ x: -31, y: -60, z: 48, id: 'minecraft:sign', front_text: { messages: ['{"text":"Original sign"}', '"世界"'] }, lastUpdate: 9223372036854775807n, raw: new Uint8Array([255, 0, 16]) }];
  const encoded = encodeColumn(source), restored = decodeColumn(encoded); assert.equal(restored.blockEntities[0].lastUpdate, 9223372036854775807n); assert.deepEqual(restored.blockEntities[0].raw, source.blockEntities[0].raw);
  const plainBytes = encodedColumnBytes(encodeColumn(column(-2, 3))); assert.ok(encodedColumnBytes(encoded) > plainBytes + 100); assert.ok(decodedColumnBytes(restored) > decodedColumnBytes(column(-2, 3)) + 100);
  const store = new ChunkStore({ worldKey: 'block-entities', indexedDB }); const pending = store.put(source); source.blockEntities[0].front_text.messages[0] = 'changed'; source.blockEntities[0].raw.fill(0); await pending; await store.close();
  const reopened = new ChunkStore({ worldKey: 'block-entities', indexedDB }); await reopened.init(); const cached = await reopened.get(-2, 3); assert.equal(cached.blockEntities[0].front_text.messages[0], '{"text":"Original sign"}'); assert.deepEqual(cached.blockEntities[0].raw, new Uint8Array([255, 0, 16])); await reopened.close();
  assert.throws(() => encodeColumn({ ...column(), blockEntities: [{ oversized: 'x'.repeat(1024 * 1024) }] }), /byte limit/);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => encodeColumn({ ...column(), blockEntities: [cyclic] }), /cyclic/);
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep }; assert.throws(() => encodeColumn({ ...column(), blockEntities: [deep] }), /nesting/);
});

test('codec rejects malformed formats, duplicate sections and oversized gzip output', () => {
  const source = column();
  assert.throws(() => encodeColumn({ ...source, sections: [source.sections[0], source.sections[0]] }), /distinct/);
  const encoded = encodeColumn(source);
  assert.throws(() => decodeColumn({ ...encoded, schemaVersion: 99 }), /incompatible/);
  encoded.sections[0].states = { format: 'uniform', stateId: 65536 };
  assert.throws(() => decodeColumn(encoded), /uniform/);
  encoded.sections[0].states = { format: 'gzip-u16le', length: 8192, bytes: gzipSync(new Uint8Array(8193)) };
  assert.throws(() => decodeColumn(encoded), /decoded length/);
});

test('IndexedDB stores full columns across close/reopen and keeps world identities separate', async () => {
  const indexedDB = new IDBFactory(), source = column(17, -22, 500);
  const store = new ChunkStore({ worldKey: 'import:region-file-A', indexedDB });
  await store.init();
  const pending = store.put(source);
  source.sections[0].blocks.fill(1234);
  assert.equal((await pending).persisted, true);
  assert.equal((await store.get(17, -22)).sections[0].blocks[0], 500, 'pending write snapshots the imported data');
  await store.close();
  const reopened = new ChunkStore({ worldKey: 'import:region-file-A', indexedDB });
  await reopened.init();
  assert.deepEqual(reopened.keys(), ['17,-22']);
  assert.equal(reopened.stats().residentColumns, 0, 'init loads metadata rather than all decoded blocks');
  const restored = await reopened.get(17, -22);
  assert.equal(restored.sections[0].blocks[0], 500);
  restored.sections[0].blocks.fill(42);
  assert.equal((await reopened.get(17, -22)).sections[0].blocks[0], 500, 'get returns a detached copy');
  await reopened.put(restored);
  assert.equal((await reopened.get(17, -22)).sections[0].blocks[0], 42);
  const other = new ChunkStore({ worldKey: 'import:region-file-B', indexedDB });
  await other.init(); assert.deepEqual(other.keys(), []); assert.equal(await other.get(17, -22), null);
  await reopened.close(); await other.close();
});

test('decoded memory and encoded disk LRU budgets remain bounded', async () => {
  const indexedDB = new IDBFactory(), bytes = decodedColumnBytes(column()), packedBytes = encodedColumnBytes(encodeColumn(column()));
  const store = new ChunkStore({ worldKey: 'LRU', indexedDB, maxMemoryBytes: bytes * 2, maxDiskBytes: packedBytes * 3 });
  await store.init();
  for (let i = 0; i < 3; i++) await store.put(column(i, 0));
  assert.deepEqual([...store.cache.keys()], ['1,0', '2,0']);
  await store.get(0, 0);
  assert.deepEqual([...store.cache.keys()], ['2,0', '0,0'], 'access promotes a decoded entry');
  await store.put(column(3, 0));
  assert.equal(store.catalog.has('1,0'), false, 'disk eviction respects accesses rather than insertion alone');
  assert.ok(store.stats().memoryBytes <= bytes * 2);
  assert.ok(store.stats().diskBytes <= packedBytes * 3);
  await store.close();
  const restored = new ChunkStore({ worldKey: 'LRU', indexedDB, maxMemoryBytes: 0, maxDiskBytes: packedBytes * 3 });
  await restored.init();
  assert.equal(await restored.get(1, 0), null);
  assert.ok(await restored.get(0, 0));
  assert.equal(restored.stats().residentColumns, 0);
  await restored.close();
});

test('version changes invalidate full block IDs and close flushes queued writes', async () => {
  const indexedDB = new IDBFactory();
  const store = new ChunkStore({ worldKey: 'versioned', indexedDB });
  await store.init();
  const writes = [store.put(column(0, 0)), store.put(column(1, 0))];
  await store.close(); await Promise.all(writes);
  const restored = new ChunkStore({ worldKey: 'versioned', indexedDB });
  await restored.init(); assert.equal(restored.keys().length, 2); await restored.close();
  const incompatible = new ChunkStore({ worldKey: 'versioned', indexedDB, registryVersion: 'next-registry' });
  await incompatible.init(); assert.deepEqual(incompatible.keys(), []); await incompatible.close();
});

const requestResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const transactionDone = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error); });
async function accounting(store) {
  const transaction = store.database.transaction(['metadata', 'budget'], 'readonly'), done = transactionDone(transaction);
  const [metadata, budget] = await Promise.all([requestResult(transaction.objectStore('metadata').getAll()), requestResult(transaction.objectStore('budget').get('global'))]);
  await done;
  return { metadata, budget, bytes: metadata.reduce((sum, value) => sum + value.bytes, 0) };
}

test('large imports never scan or sort the growing global catalog after initialization', async () => {
  const indexedDB = new IDBFactory(), store = new ChunkStore({ worldKey: 'large-import', indexedDB });
  await store.init();
  const originalGetAll = IDBObjectStore.prototype.getAll, originalCount = IDBObjectStore.prototype.count;
  let catalogScans = 0;
  IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'metadata') catalogScans++; return originalGetAll.apply(this, args); };
  IDBObjectStore.prototype.count = function (...args) { if (this.name === 'metadata') catalogScans++; return originalCount.apply(this, args); };
  try {
    for (let x = 0; x < 512; x++) await store.put(column(x, 0));
    assert.equal(catalogScans, 0, 'one metadata row and the aggregate are sufficient for a below-budget write');
  } finally { IDBObjectStore.prototype.getAll = originalGetAll; IDBObjectStore.prototype.count = originalCount; }
  const state = await accounting(store);
  assert.equal(state.metadata.length, 512); assert.equal(state.budget.count, 512); assert.equal(state.budget.bytes, state.bytes);
  await store.close();
});

test('concurrent worlds update global byte accounting and LRU eviction in the same transaction', async () => {
  const indexedDB = new IDBFactory(), bytes = encodedColumnBytes(encodeColumn(column()));
  const a = new ChunkStore({ worldKey: 'concurrent-a', indexedDB, maxDiskBytes: bytes * 6 });
  const b = new ChunkStore({ worldKey: 'concurrent-b', indexedDB, maxDiskBytes: bytes * 6 });
  await Promise.all([a.init(), b.init()]);
  await Promise.all(Array.from({ length: 12 }, (_, x) => (x % 2 ? a : b).put(column(x, 0))));
  let state = await accounting(a);
  assert.equal(state.metadata.length, 6); assert.equal(state.budget.count, 6); assert.equal(state.budget.bytes, state.bytes); assert.ok(state.bytes <= bytes * 6);
  const retained = state.metadata.filter(entry => entry.worldKey === a.worldKey).at(-1);
  assert.ok(retained); await a.get(retained.x, retained.z);
  await b.put(column(100, 0));
  state = await accounting(a);
  assert.ok(state.metadata.some(entry => entry.id === retained.id), 'a touch is ordered globally across world instances');
  assert.equal(state.budget.count, state.metadata.length); assert.equal(state.budget.bytes, state.bytes);
  const overwritten = state.metadata.find(entry => entry.worldKey === b.worldKey);
  const replacement = column(overwritten.x, overwritten.z); replacement.sections.push({sectionY: 0, blocks: new Uint16Array(4096)});
  await b.put(replacement); state = await accounting(a);
  assert.equal(state.budget.count, state.metadata.length); assert.equal(state.budget.bytes, state.bytes); assert.ok(state.bytes <= bytes * 6);
  await Promise.all([a.close(), b.close()]);
});

test('opening a legacy database repairs aggregate accounting once and retains original columns', async () => {
  const indexedDB = new IDBFactory(), request = indexedDB.open(CHUNK_STORE_DATABASE, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('columns', { keyPath: 'id' });
    request.result.createObjectStore('metadata', { keyPath: 'id' }).createIndex('worldKey', 'worldKey');
  };
  const database = await requestResult(request), transaction = database.transaction(['columns', 'metadata'], 'readwrite'), done = transactionDone(transaction);
  const encoded = encodeColumn(column(9, -2, 500)), id = 'legacy\0' + '9,-2';
  transaction.objectStore('columns').put({ ...encoded, id, registryVersion: '1.20.4' });
  transaction.objectStore('metadata').put({ id, key: '9,-2', worldKey: 'legacy', x: 9, z: -2, schemaVersion: 1, registryVersion: '1.20.4', bytes: encodedColumnBytes(encoded), accessedAt: 25 });
  await done; database.close();
  const store = new ChunkStore({ worldKey: 'legacy', indexedDB }); await store.init();
  assert.equal((await store.get(9, -2)).sections[0].blocks[0], 500);
  let state = await accounting(store); assert.equal(state.budget.count, 1); assert.equal(state.budget.bytes, state.bytes);
  const damage = store.database.transaction('budget', 'readwrite'), damaged = transactionDone(damage); damage.objectStore('budget').put({ id: 'global', count: 0, bytes: 0, clock: 0 }); await damaged;
  await store.close();
  const reopened = new ChunkStore({worldKey: 'legacy', indexedDB}); await reopened.init();
  state = await accounting(reopened); assert.equal(state.budget.count, 1); assert.equal(state.budget.bytes, state.bytes);
  await reopened.close();
});

test('reading a resident column cannot resurrect metadata evicted by another store', async () => {
  const indexedDB = new IDBFactory(), bytes = encodedColumnBytes(encodeColumn(column()));
  const a = new ChunkStore({worldKey: 'old-world', indexedDB, maxDiskBytes: bytes});
  await a.put(column(0,0));
  const b = new ChunkStore({worldKey: 'new-world', indexedDB, maxDiskBytes: bytes});
  await b.put(column(0,0));
  assert.ok(await a.get(0,0), 'the decoded resident copy remains usable after disk eviction');
  const state = await accounting(a);
  assert.deepEqual(state.metadata.map(entry => entry.worldKey), ['new-world']); assert.equal(state.budget.count, 1); assert.equal(state.budget.bytes, bytes);
  assert.equal(a.catalog.size, 0);
  await Promise.all([a.close(), b.close()]);
});
