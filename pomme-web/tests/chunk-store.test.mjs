import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { gzipSync } from '../vendor/fflate.js';
import { ChunkStore, encodeColumn, decodeColumn, encodedColumnBytes, decodedColumnBytes } from '../src/chunk-store.js';

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
