import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DistantTerrain, DISTANT_DATABASE, DISTANT_CACHE_VERSION, dimensionRecordBytes, materialSignature, validCachedColumn, recordBytes, chooseCellSize } from '../src/distant.js';
import { reduceColumn, meshColumn, meshRegion, updateReducedBlock } from '../src/distant.worker.js';

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
  async readMetadata(...args) {
    this.metadataReads = (this.metadataReads ?? 0) + 1;
    return super.readMetadata(...args);
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
  assert.equal(bytes, 29200);
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

test('malformed metadata from another cached world is discarded before disk accounting', async () => {
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
  assert.equal(current.metadataByteBound, bytes, 'invalid claimed byte counts do not poison the global budget');
  await current.ingest(column(1, 0));
  assert.equal(current.metadataReads, 1, 'the repaired global total does not require repeated catalog scans');
  await current.ingest(column(2, 0));
  const values = await current.readMetadata();
  assert.ok(values.reduce((sum, record) => sum + record.bytes, 0) <= bytes * 9);
  assert.ok(values.every(record => record.worldKey !== 'legacy-world'), 'malformed records are deleted along with their metadata');
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

test('native dimension bounds preserve bottom/top occupancy, biome slots and exact signed mesh origins', () => {
  for (const bounds of [
    { minY: 0, height: 256 }, { minY: -320, height: 512 },
    { minY: 40000, height: 32 }, { minY: -40000, height: 32 },
    { minY: -2147483632, height: 1024 }, { minY: 2147482608, height: 1024 },
  ]) {
    const { minY, height } = bounds, maxY = minY + height;
    const source = column(-3, -2, [[0, minY, 0, 1], [15, maxY - 1, 15, 2], [8, minY - 1, 8, 3], [8, maxY, 8, 3]]);
    for (const section of source.sections) section.biomes = new Uint32Array(64).fill(section.sectionY - minY / 16 + 100);
    const record = reduceColumn(source, materials, bounds);
    assert.equal(recordBytes(record), dimensionRecordBytes(height));
    assert.equal(record.occupancy.length, height * 8);
    assert.equal(record.biomes.length, height * 4);
    assert.equal(record.biomes[0], 100); assert.equal(record.biomes.at(-1), height / 16 + 99);
    assert.deepEqual([record.minY, record.height], [minY, height]);
    record.schemaVersion = DISTANT_CACHE_VERSION; record.signature = materialSignature(materials);
    assert.ok(validCachedColumn(record, record.signature, bounds));
    for (const size of [4, 8, 16]) {
      const n = 16 / size, last = index(n - 1, height / size - 1, n - 1, n);
      assert.ok(record.topHeights[size] instanceof Int32Array);
      assert.equal(record.topHeights[size][0], minY); assert.equal(record.topHeights[size][last], maxY - 1);
      assert.equal(record.levels[size].filter(Boolean).length, 2, 'outside-dimension source sections cannot create geometry');
      const mesh = meshColumn(record, size, materials);
      assert.deepEqual(mesh.origin, [-48, minY, -32]);
      assert.deepEqual(mesh.bounds, { min: [-48, minY, -32], max: [-32, maxY, -16] });
      const ys = [...mesh.opaque].filter((_value, i) => i % 14 === 1);
      assert.equal(Math.min(...ys), 0); assert.equal(Math.max(...ys), height);
      assert.ok(ys.includes(size) && ys.includes(height - size), 'local Float32 preserves small cells even near i32 extremes');
    }
    assert.equal(updateReducedBlock(record, -48, minY - 1, -32, 1, materials), null);
    assert.equal(updateReducedBlock(record, -48, maxY, -32, 1, materials), null);
    updateReducedBlock(record, -48, minY, -32, 0, materials);
    updateReducedBlock(record, -33, maxY - 1, -17, 0, materials);
    assert.ok(record.occupancy.every(value => value === 0));
    for (const size of [4, 8, 16]) assert.ok(record.topHeights[size].every(value => value === minY - 1));
    updateReducedBlock(record, -47, maxY - 1, -31, 3, materials);
    assert.equal(meshColumn(record, 4, materials).water.length, 36 * 14, 'boundary edits restore real fluid geometry');
  }
  for (const bounds of [{ minY: -65, height: 384 }, { minY: 0, height: 0 }, { minY: 0, height: 1025 }, { minY: 2147483632, height: 16 }, { minY: -2147483648, height: 16 }]) {
    assert.throws(() => reduceColumn(column(), materials, bounds), /dimension bounds/);
    assert.throws(() => new DistantTerrain({ worldKey: 'bad', materials, indexedDB: null, ...bounds }), /dimension bounds/);
  }
});

test('negative-coordinate regional meshes retain dimension bounds, source offsets and unknown gaps', () => {
  const bounds = { minY: -40000, height: 256 };
  const records = [-4, -1].map(x => ({ record: reduceColumn(column(x, -2, [[0, bounds.minY, 0, 1]]), materials, bounds), cellSize: 4 }));
  const mesh = meshRegion(records, -1, -1, 4, materials);
  assert.deepEqual(mesh.origin, [-64, -40000, -64]);
  assert.deepEqual(mesh.bounds, { min: [-64, -40000, -64], max: [0, -39744, 0] });
  for (let vertex = 0; vertex < mesh.opaque.length; vertex += 14) {
    const x = mesh.opaque[vertex], z = mesh.opaque[vertex + 2];
    assert.ok(x <= 4 || x >= 48, 'unknown columns inside a known region have no vertices');
    assert.ok(z >= 32 && z <= 36);
  }
  assert.equal(meshRegion([], -1, -1, 4, materials, null, bounds).opaque.length, 0);
  const mismatched = { record: reduceColumn(column(-3, -2), materials), cellSize: 4 };
  assert.throws(() => meshRegion([...records, mismatched], -1, -1, 4, materials), /incompatible dimension/);
});

test('dimension-aware caches reject changed bounds and truncated or old-width typed arrays', async () => {
  const indexedDB = new IDBFactory(), bounds = { minY: -40000, height: 32 }, options = { worldKey: 'custom-dimension', materials, indexedDB, ...bounds };
  const first = new DistantTerrain(options);
  await first.init(); await first.ingest(column(-1, 2, [[0, -40000, 0, 1], [15, -39969, 15, 2]])); await settle(first);
  const record = first.columns.get('-1,2'), signature = materialSignature(materials);
  assert.ok(validCachedColumn(structuredClone(record), signature, bounds));
  assert.equal(validCachedColumn(record, signature), false, 'default Overworld validation cannot accept a custom dimension');
  assert.equal(validCachedColumn({ ...record, biomes: new Uint32Array(64) }, signature, bounds), false);
  assert.equal(validCachedColumn({ ...record, occupancy: new Uint32Array(2) }, signature, bounds), false);
  assert.equal(validCachedColumn({ ...record, topHeights: { ...record.topHeights, 4: new Int16Array(record.topHeights[4]) } }, signature, bounds), false);
  const badTop = structuredClone(record); badTop.topHeights[4][0] = 0;
  assert.equal(validCachedColumn(badTop, signature, bounds), false, 'corrupt representative heights cannot enter biome sampling');
  await first.close();
  const restored = new DistantTerrain(options); await restored.init(); await settle(restored);
  assert.equal(restored.catalog.size, 1); assert.equal(restored.stats().minY, -40000); assert.equal(restored.stats().height, 32);
  const metadata = (await restored.readMetadata())[0]; assert.equal(metadata.minY, -40000); assert.equal(metadata.height, 32);
  assert.equal(metadata.bytes, dimensionRecordBytes(32)); await restored.close();
  const changed = new DistantTerrain({ ...options, minY: -40016 }); await changed.init(); await settle(changed);
  assert.equal(changed.catalog.size, 0, 'changing bounds for the same world identity cannot reuse old source cells');
  assert.equal((await changed.readMetadata()).length, 0); await changed.close();
});

test('concurrent dimensions account for exact persistent bytes without per-import catalog scans', async () => {
  const indexedDB = new IDBFactory(), smallBytes = dimensionRecordBytes(256), tallBytes = dimensionRecordBytes(1024);
  const options = { materials, indexedDB, maxDiskBytes: smallBytes + tallBytes, maxGpuColumns: 0, maxMemoryBytes: tallBytes };
  const small = new CountedTerrain({ ...options, worldKey: 'nether', minY: 0, height: 256 });
  const tall = new CountedTerrain({ ...options, worldKey: 'tall-custom', minY: -512, height: 1024 });
  await Promise.all([small.init(), tall.init()]);
  await small.ingest(column(0, 0)); await tall.ingest(column(0, 0));
  assert.equal(small.metadataReads, 1); assert.equal(tall.metadataReads, 1, 'mixed heights at the exact limit use the atomic total');
  await Promise.all([small.ingest(column(1, 0)), tall.ingest(column(1, 0)), small.ingest(column(2, 0)), tall.ingest(column(2, 0))]);
  const values = await small.readMetadata(), total = values.reduce((sum, value) => sum + value.bytes, 0);
  assert.ok(total <= options.maxDiskBytes);
  const budget = await new Promise((resolve, reject) => {
    const request = small.database.transaction('budget', 'readonly').objectStore('budget').get('global');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  assert.equal(budget.bytes, total); assert.equal(budget.count, values.length);
  assert.ok(values.every(value => value.bytes === dimensionRecordBytes(value.height)));
  await Promise.all([settle(small), settle(tall)]);
  assert.ok(small.memoryBytes <= options.maxMemoryBytes); assert.ok(tall.memoryBytes <= options.maxMemoryBytes);
  await Promise.all([small.close(), tall.close()]);
});

test('IndexedDB v1 migration rebuilds totals and rejects malformed metadata safely', async () => {
  const indexedDB = new IDBFactory();
  const old = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DISTANT_DATABASE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('columns', { keyPath: 'id' }); request.result.createObjectStore('metadata', { keyPath: 'id' }).createIndex('worldKey', 'worldKey'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const oldRecord = { ...reduceColumn(column(), materials), id: 'migrate\0' + '0,0', schemaVersion: 2, signature: materialSignature(materials) };
  const transaction = old.transaction(['metadata', 'columns'], 'readwrite');
  transaction.objectStore('columns').put(oldRecord);
  transaction.objectStore('metadata').put({ id: oldRecord.id, worldKey: 'migrate', key: '0,0', x: 0, z: 0, schemaVersion: 2, signature: oldRecord.signature, bytes: 25696, accessedAt: 1 });
  for (const [suffix, bytes] of [['nan', NaN], ['negative', -1], ['infinite', Infinity], ['huge', Number.MAX_SAFE_INTEGER]]) {
    transaction.objectStore('metadata').put({ id: `bad\0${suffix}`, worldKey: 'bad', key: suffix, x: 0, z: 0, schemaVersion: 3, signature: oldRecord.signature, bytes, accessedAt: NaN });
  }
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); }); old.close();
  const terrain = new CountedTerrain({ worldKey: 'migrate', materials, indexedDB }); await terrain.init(); await settle(terrain);
  assert.equal(terrain.database.version, 2); assert.equal(terrain.catalog.size, 0);
  assert.equal((await terrain.readMetadata()).length, 0, 'old format and corrupt metadata are removed during migration');
  await terrain.ingest(column(1, -1)); await settle(terrain);
  assert.equal((await terrain.readMetadata())[0].bytes, dimensionRecordBytes(384)); await terrain.close();
});
