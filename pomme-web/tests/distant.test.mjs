import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DistantTerrain, DISTANT_DATABASE, materialSignature, validCachedColumn, recordBytes, chooseCellSize } from '../src/distant.js';
import { reduceColumn, meshColumn, updateReducedBlock } from '../src/distant.worker.js';

const materials = new Map([
  [0, { name: 'minecraft:air', flags: 128 }],
  [1, { name: 'minecraft:stone', flags: 3, color: [.7, .7, .7], faces: { up: { tile: 7, uv: [.25, .25, .75, .75], tint: [1, 1, 1] } } }],
  [2, { name: 'minecraft:grass_block', flags: 3, color: [.4, .8, .3] }],
  [3, { name: 'minecraft:water', flags: 4 | 64, color: [.2, .4, .8] }],
]);
const index = (x, y, z, width) => (y * width + z) * width + x;
function column(x = 0, z = 0, voxels = [[0, 0, 0, 1]]) {
  const sections = new Map();
  for (const [vx, y, vz, id] of voxels) {
    const sectionY = Math.floor(y / 16);
    if (!sections.has(sectionY)) sections.set(sectionY, new Uint16Array(4096));
    sections.get(sectionY)[index(vx, ((y % 16) + 16) % 16, vz, 16)] = id;
  }
  return { x, z, sections: [...sections].map(([sectionY, blocks]) => ({ sectionY, blocks })) };
}
async function settle(terrain) {
  const deadline = Date.now() + 5000;
  do {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (!terrain.refreshing && !terrain.refreshTimer && !terrain.operations.size) return;
  } while (Date.now() < deadline);
  throw new Error('Distant terrain did not settle');
}
class CountedTerrain extends DistantTerrain {
  async readMetadata() {
    this.metadataReads = (this.metadataReads ?? 0) + 1;
    return super.readMetadata();
  }
  async countMetadata() {
    this.metadataCounts = (this.metadataCounts ?? 0) + 1;
    return super.countMetadata();
  }
}

test('reduction preserves isolated surfaces, caves and source top material at every level', () => {
  const source = column(-2, 3, [[0, -63, 0, 1], [0, -61, 0, 2], [3, -61, 3, 2], [0, 15, 0, 1], [15, 319, 15, 3]]);
  const record = reduceColumn(source, materials);
  assert.equal(record.levels[4][index(0, 0, 0, 4)], 2, 'upper grass remains visible over lower stone');
  assert.equal(record.topHeights[4][0], -61);
  for (const size of [4, 8, 16]) {
    const width = 16 / size;
    for (const [x, y, z] of [[0, -63, 0], [0, -61, 0], [0, 15, 0], [15, 319, 15]]) {
      assert.notEqual(record.levels[size][index(Math.floor(x / size), Math.floor((y + 64) / size), Math.floor(z / size), width)], 0, 'every actual occupied source cell survives coarsening');
    }
    assert.equal(record.levels[size][index(0, Math.floor((0 + 64) / size), 0, width)], size === 16 ? 1 : 0, 'empty cells remain empty unless their coarse extent includes actual terrain');
  }
  assert.equal(record.occupancy.length, 3072);
  assert.equal(reduceColumn({ x: 0, z: 0, sections: [] }, materials).levels[16].every(id => id === 0), true);
});

test('LOD mesh winding, native coordinates, UV rectangles and water stream are valid', () => {
  const record = reduceColumn(column(-1, 2, [[0, 0, 0, 1], [15, 4, 15, 3]]), materials);
  const mesh = meshColumn(record, 4, materials);
  assert.equal(mesh.stride, 14);
  assert.equal(mesh.opaque.length, 36 * 14);
  assert.equal(mesh.water.length, 36 * 14);
  assert.deepEqual(mesh.bounds, { min: [-16, -64, 32], max: [0, 320, 48] });
  for (const stream of [mesh.opaque, mesh.water]) {
    for (let offset = 0; offset < stream.length; offset += 42) {
      const a = stream.slice(offset, offset + 3), b = stream.slice(offset + 14, offset + 17), c = stream.slice(offset + 28, offset + 31);
      const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const normal = stream.slice(offset + 3, offset + 6);
      assert.ok(cross.reduce((sum, value, i) => sum + value * normal[i], 0) > 0, 'all triangle normals face outward');
    }
  }
  const up = [];
  for (let offset = 0; offset < mesh.opaque.length; offset += 14) if (mesh.opaque[offset + 4] === 1) up.push(mesh.opaque.slice(offset + 10, offset + 13));
  assert.equal(Math.min(...up.map(vertex => vertex[0])), .25);
  assert.equal(Math.max(...up.map(vertex => vertex[0])), 2.25, 'UV repeats retain the subrectangle origin');
  assert.ok(up.every(vertex => vertex[2] === 7));
});

test('exact occupancy edits clear the final voxel and regenerate all LOD levels', () => {
  const record = reduceColumn(column(0, 0, [[0, 0, 0, 1], [3, 3, 3, 2]]), materials);
  updateReducedBlock(record, 3, 3, 3, 0, materials);
  assert.notEqual(record.levels[4][index(0, 16, 0, 4)], 0);
  assert.equal(record.materialStale, true, 'coarse material approximation is explicit');
  updateReducedBlock(record, 0, 0, 0, 0, materials);
  assert.ok(Object.values(record.levels).every(level => level.every(id => id === 0)));
  assert.ok(record.occupancy.every(mask => mask === 0));
  updateReducedBlock(record, 2, 1, 2, 3, materials);
  assert.equal(record.levels[4][index(0, 16, 0, 4)], 3);
  assert.equal(updateReducedBlock(record, 16, 0, 0, 1, materials), null);
});

test('persistent terrain restores real columns, suppresses near geometry and changes resolution with distance', async () => {
  const indexedDB = new IDBFactory(), meshes = [], removed = [];
  const terrain = new DistantTerrain({ worldKey: 'server:25565/overworld', materials, indexedDB, onMesh: mesh => meshes.push(mesh), onRemove: key => removed.push(key) });
  await terrain.init();
  await settle(terrain);
  assert.equal(meshes.length, 0, 'an unknown world produces no invented terrain');
  terrain.setNearColumns(new Set(['0,0']));
  await terrain.ingest(column(0, 0)); await terrain.ingest(column(2, 0));
  await settle(terrain);
  assert.deepEqual([...terrain.visible.keys()], ['2,0']);
  assert.ok(meshes.every(mesh => mesh.key !== 'lod:0,0'));
  terrain.setNearColumns(new Set()); await settle(terrain);
  assert.equal(terrain.visible.size, 2);
  terrain.updateCamera([1100, 80, 0]); await settle(terrain);
  assert.equal(terrain.visible.get('0,0').level, 16);
  assert.equal(terrain.visible.get('2,0').level, 16);
  terrain.setNearColumns(new Set(['2,0']));
  assert.ok(removed.includes('lod:2,0'), 'full-detail near geometry immediately replaces distant geometry');
  const meshCount = meshes.length;
  await terrain.updateBlock(0, 0, 0, 0); await settle(terrain);
  assert.equal(meshes.length, meshCount, 'removing the final voxel removes geometry instead of uploading another mesh');
  assert.equal(terrain.visible.get('0,0').bytes, 0, 'deletion does not leave ghost distant terrain');
  await terrain.close();

  const restoredMeshes = [];
  const restored = new DistantTerrain({ worldKey: 'server:25565/overworld', materials, indexedDB, onMesh: mesh => restoredMeshes.push(mesh) });
  await restored.init(); await settle(restored);
  assert.equal(restored.catalog.size, 2);
  assert.equal(restoredMeshes.length, 1, 'only the genuinely occupied persisted column renders after reload');
  assert.equal(restoredMeshes[0].key, 'lod:2,0');
  await restored.close();
});

test('cache schema and material-registry changes invalidate stored IDs without affecting other worlds', async () => {
  const indexedDB = new IDBFactory();
  const terrain = new DistantTerrain({ worldKey: 'A', materials, indexedDB });
  await terrain.init(); await terrain.ingest(column()); await settle(terrain);
  const cached = terrain.columns.get('0,0');
  assert.ok(validCachedColumn(structuredClone(cached), materialSignature(materials)));
  assert.equal(validCachedColumn({ ...cached, schemaVersion: 99 }, materialSignature(materials)), false);
  await terrain.close();
  const altered = new Map(materials); altered.set(1, { ...materials.get(1), name: 'other:state_one' });
  const replacement = new DistantTerrain({ worldKey: 'A', materials: altered, indexedDB });
  await replacement.init(); await settle(replacement);
  assert.equal(replacement.catalog.size, 0, 'incompatible registry IDs are discarded');
  await replacement.close();
  const other = new DistantTerrain({ worldKey: 'B', materials, indexedDB });
  await other.init(); await other.ingest(column(4, -3)); await settle(other); await other.close();
  const isolated = new DistantTerrain({ worldKey: 'A', materials, indexedDB });
  await isolated.init(); await settle(isolated);
  assert.equal(isolated.catalog.size, 0, 'world identity never mixes server data');
  await isolated.close();
  assert.ok(DISTANT_DATABASE.length > 0);
});

test('disk and GPU residency budgets are bounded', async () => {
  const indexedDB = new IDBFactory(), bytes = recordBytes(reduceColumn(column(), materials));
  const terrain = new DistantTerrain({ worldKey: 'budget', materials, indexedDB, maxDiskBytes: bytes * 2, maxMemoryBytes: bytes * 2, maxGpuColumns: 1 });
  await terrain.init();
  for (let i = 0; i < 5; i++) { await terrain.ingest(column(i, 0)); await settle(terrain); }
  assert.ok(terrain.stats().visibleColumns <= 1);
  assert.ok(terrain.stats().memoryBytes <= bytes * 2);
  assert.ok((await terrain.readMetadata()).reduce((sum, record) => sum + record.bytes, 0) <= bytes * 2);
  await terrain.close();
  assert.equal(chooseCellSize(511), 4); assert.equal(chooseCellSize(512), 8); assert.equal(chooseCellSize(1024), 16);
});

test('repeated column imports use native counts without cloning the growing metadata catalog', async () => {
  const indexedDB = new IDBFactory(), bytes = recordBytes(reduceColumn(column(), materials));
  assert.equal(bytes, 19552);
  const terrain = new CountedTerrain({ worldKey: 'large-import', materials, indexedDB,
    maxDiskBytes: bytes * 128, maxMemoryBytes: bytes * 4, maxGpuColumns: 0 });
  await terrain.init();
  assert.equal(terrain.metadataReads, 1, 'initialization loads the catalog once');
  for (let x = 0; x < 96; x++) await terrain.ingest(column(x, 0));
  for (let x = 0; x < 20; x++) await terrain.ingest(column(x, 0));
  await settle(terrain);
  assert.equal(terrain.metadataReads, 1, 'under-budget imports and replacements never call getAll');
  assert.equal(terrain.metadataCounts, 117, 'each committed write checks the global count');
  assert.equal(await terrain.countMetadata(), 96, 'replacements do not inflate record estimates');
  assert.ok(terrain.memoryBytes <= bytes * 4);
  await terrain.close();
});

test('native-count disk checks include other worlds and concurrent writers before global eviction', async () => {
  const indexedDB = new IDBFactory(), bytes = recordBytes(reduceColumn(column(), materials));
  const options = { materials, indexedDB, maxDiskBytes: bytes * 3, maxGpuColumns: 0 };
  const first = new CountedTerrain({ ...options, worldKey: 'concurrent-A' });
  const second = new CountedTerrain({ ...options, worldKey: 'concurrent-B' });
  await Promise.all([first.init(), second.init()]);
  await first.ingest(column(0, 0));
  await first.ingest(column(1, 0));
  await second.ingest(column(2, 0));
  assert.equal(second.metadataReads, 1, 'the conservative bound fits exactly at the global limit');
  await Promise.all([
    first.ingest(column(3, 0)), second.ingest(column(4, 0)),
    first.ingest(column(5, 0)), second.ingest(column(6, 0)),
  ]);
  const values = await first.readMetadata();
  assert.ok(values.reduce((sum, record) => sum + record.bytes, 0) <= bytes * 3,
    'concurrent worlds share the same global disk budget');
  assert.ok(first.metadataReads + second.metadataReads > 3, 'possible overflow runs the full eviction path');
  await Promise.all([settle(first), settle(second)]);
  await Promise.all([first.close(), second.close()]);
});

test('oversized metadata from another cached world raises the conservative count bound', async () => {
  const indexedDB = new IDBFactory(), bytes = recordBytes(reduceColumn(column(), materials));
  const legacy = new DistantTerrain({ worldKey: 'legacy-world', materials, indexedDB, maxGpuColumns: 0 });
  await legacy.init(); await legacy.ingest(column());
  const transaction = legacy.database.transaction('metadata', 'readwrite');
  transaction.objectStore('metadata').put({ ...legacy.catalog.get('0,0'), bytes: bytes * 8 });
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  await settle(legacy); await legacy.close();

  const current = new CountedTerrain({ worldKey: 'current-world', materials, indexedDB,
    maxDiskBytes: bytes * 9, maxGpuColumns: 0 });
  await current.init();
  assert.equal(current.metadataByteBound, bytes * 8, 'all worlds contribute to the byte bound');
  await current.ingest(column(1, 0));
  assert.equal(current.metadataReads, 2, 'a count proof cannot ignore the oversized other-world record');
  await current.ingest(column(2, 0));
  const values = await current.readMetadata();
  assert.ok(values.reduce((sum, record) => sum + record.bytes, 0) <= bytes * 9);
  assert.ok(values.every(record => record.worldKey !== 'legacy-world'), 'global LRU eviction removes the older record');
  await settle(current); await current.close();
});

test('stored cache-format mismatch is deleted and concurrent edits preserve both occupancy changes', async () => {
  const indexedDB = new IDBFactory();
  const terrain = new DistantTerrain({ worldKey: 'format-check', materials, indexedDB });
  await terrain.init(); await terrain.ingest(column());
  await Promise.all([terrain.updateBlock(1, 1, 1, 2), terrain.updateBlock(2, 2, 2, 3)]);
  await Promise.all([terrain.updateBlock(0, 0, 0, 0), terrain.updateBlock(1, 1, 1, 0), terrain.updateBlock(2, 2, 2, 0)]);
  assert.ok(terrain.columns.get('0,0').occupancy.every(word => word === 0), 'queued edits do not overwrite each other');
  await settle(terrain);
  const transaction = terrain.database.transaction('metadata', 'readwrite');
  const metadata = { ...terrain.catalog.get('0,0'), schemaVersion: 99 };
  transaction.objectStore('metadata').put(metadata);
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
  await terrain.close();
  const restored = new DistantTerrain({ worldKey: 'format-check', materials, indexedDB });
  await restored.init(); await settle(restored);
  assert.equal(restored.catalog.size, 0);
  assert.equal((await restored.readMetadata()).length, 0);
  await restored.close();
});

test('regional batching reduces uploads, keeps unknown gaps empty and releases visible voxel records', async () => {
  const indexedDB = new IDBFactory(), meshes = [], removes = [], bytes = recordBytes(reduceColumn(column(), materials));
  const terrain = new DistantTerrain({ worldKey: 'regions', materials, indexedDB, regionBatchSize: 4,
    maxMemoryBytes: bytes * 2, onMesh: mesh => meshes.push(mesh), onRemove: key => removes.push(key) });
  assert.equal(terrain.maxGpuColumns, 2048);
  await terrain.init();
  for (const x of [0, 1, 3]) await terrain.ingest(column(x, 0));
  await settle(terrain);
  assert.equal(terrain.stats().visibleColumns, 3);
  assert.equal(terrain.stats().visibleRegions, 1);
  assert.ok(terrain.stats().memoryBytes <= bytes * 2, 'GPU-visible terrain does not pin all source records in RAM');
  const combined = meshes.at(-1);
  assert.equal(combined.key, 'lod:0,0');
  assert.deepEqual(combined.bounds, { min: [0, -64, 0], max: [64, 320, 64] });
  assert.equal(combined.opaque.length, 3 * 36 * 14);
  for (let offset = 0; offset < combined.opaque.length; offset += 14) {
    const x = combined.opaque[offset];
    assert.ok(x <= 20 || x >= 48, 'the unknown column between known columns has no invented vertices');
  }
  const count = meshes.length;
  let loads = 0;
  const load = terrain.load.bind(terrain); terrain.load = key => { loads++; return load(key); };
  terrain.updateCamera([32, 80, 0]); await settle(terrain);
  assert.equal(meshes.length, count); assert.equal(loads, 0, 'moving within the same LOD does not reload cached source records');
  terrain.setNearColumns(new Set(['1,0']));
  assert.equal(terrain.visible.size, 0, 'the region is removed before full near terrain can overlap it');
  await settle(terrain);
  assert.equal(terrain.stats().visibleColumns, 2);
  assert.ok(removes.includes('lod:0,0'));
  assert.equal(meshes.at(-1).opaque.length, 2 * 36 * 14);
  await terrain.close();
});
