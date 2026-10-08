import { reduceColumn, meshColumn, meshRegion, updateReducedBlock, dimensionBounds, validColumnCoordinates } from './distant.worker.js';
import { createBiomeSampler } from './biome-tints.js';

export const DISTANT_CACHE_VERSION = 3;
export const DISTANT_DATABASE = 'pomme-distant-terrain';
const SIZES = [4, 8, 16];
export function dimensionRecordBytes(height) {
  ({ height } = dimensionBounds({ minY: 0, height }));
  return 4 * 4 * height / 4 * 2 * Uint32Array.BYTES_PER_ELEMENT
    + height / 16 * 64 * Uint32Array.BYTES_PER_ELEMENT
    + SIZES.reduce((sum, size) => sum + (16 / size) ** 2 * height / size
      * (Uint16Array.BYTES_PER_ELEMENT + Int32Array.BYTES_PER_ELEMENT), 0) + 256;
}
const MAX_RECORD_BYTES = dimensionRecordBytes(1024);
const BUDGET_ID = 'global';
const columnKey = (x, z) => `${x},${z}`;
const lodKey = key => `lod:${key}`;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

export function materialSignature(materials) {
  // Cache IDs only have meaning for this exact registry and visibility policy.
  // Texture-pack changes can reuse IDs, while differing registries invalidate.
  let hash = 2166136261;
  for (const [id, material] of [...materials].sort((a, b) => a[0] - b[0])) {
    const description = `${id}:${material.name ?? ''}:${material.flags ?? 3};`;
    for (let i = 0; i < description.length; i++) { hash ^= description.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  }
  return (hash >>> 0).toString(16);
}

export function validCachedColumn(record, signature, bounds = {}) {
  let minY, height;
  try { ({ minY, height } = dimensionBounds(bounds)); } catch { return false; }
  if (record?.schemaVersion !== DISTANT_CACHE_VERSION || record.signature !== signature
    || !validColumnCoordinates(record.x, record.z) || record.minY !== minY || record.height !== height
    || record.revision !== undefined && (!Number.isSafeInteger(record.revision) || record.revision < 0)
    || !(record.biomes instanceof Uint32Array) || record.biomes.length !== height / 16 * 64
    || !(record.occupancy instanceof Uint32Array) || record.occupancy.length !== 4 * 4 * height / 4 * 2) return false;
  return SIZES.every(size => {
    const n = 16 / size, level = record.levels?.[size], tops = record.topHeights?.[size];
    if (!(level instanceof Uint16Array) || level.length !== n * n * height / size
      || !(tops instanceof Int32Array) || tops.length !== level.length) return false;
    return tops.every((top, cell) => level[cell] ? top >= minY + Math.floor(cell / (n * n)) * size
      && top < minY + (Math.floor(cell / (n * n)) + 1) * size : top === minY - 1);
  });
}

export function recordBytes(record) {
  return record.occupancy.byteLength + (record.biomes?.byteLength ?? 0) + SIZES.reduce((sum, size) => sum + record.levels[size].byteLength + record.topHeights[size].byteLength, 0) + 256;
}

export function chooseCellSize(distance) { return distance >= 1024 ? 16 : distance >= 512 ? 8 : 4; }

function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Distant cache transaction aborted'));
  });
}
function openDatabase(factory) {
  const request = factory.open(DISTANT_DATABASE, 2);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('columns')) database.createObjectStore('columns', { keyPath: 'id' });
    if (!database.objectStoreNames.contains('metadata')) {
      const metadata = database.createObjectStore('metadata', { keyPath: 'id' }); metadata.createIndex('worldKey', 'worldKey');
    }
    if (!database.objectStoreNames.contains('budget')) database.createObjectStore('budget', { keyPath: 'id' });
  };
  return requestResult(request);
}
function normalizedMetadata(value) {
  if (!value || typeof value.worldKey !== 'string' || !value.worldKey || value.worldKey.length > 4096
    || !validColumnCoordinates(value.x, value.z)
    || value.key !== columnKey(value.x, value.z) || value.id !== `${value.worldKey}\0${value.key}`
    || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || typeof value.signature !== 'string' || value.signature.length > 128
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_RECORD_BYTES) return null;
  if (value.schemaVersion === DISTANT_CACHE_VERSION) {
    if (!Number.isInteger(value.minY) || !Number.isInteger(value.height)) return null;
    try { dimensionBounds(value); if (value.bytes !== dimensionRecordBytes(value.height)) return null; } catch { return null; }
  }
  return { ...value, accessedAt: Number.isSafeInteger(value.accessedAt) && value.accessedAt >= 0 ? Math.min(Date.now(), value.accessedAt) : 0 };
}
function validBudget(value) {
  return value?.id === BUDGET_ID && Number.isSafeInteger(value.count) && value.count >= 0
    && Number.isSafeInteger(value.bytes) && value.bytes >= value.count && value.bytes <= value.count * MAX_RECORD_BYTES;
}
/** Repair older or tampered accounting within the same serialized transaction. */
async function scanBudget(transaction) {
  const store = transaction.objectStore('metadata'), values = await requestResult(store.getAll()), valid = [];
  for (const value of values) {
    const metadata = normalizedMetadata(value);
    if (metadata) valid.push(metadata);
    else { store.delete(value.id); transaction.objectStore('columns').delete(value.id); }
  }
  const budget = { id: BUDGET_ID, count: valid.length, bytes: valid.reduce((sum, value) => sum + value.bytes, 0) };
  transaction.objectStore('budget').put(budget);
  return { values: valid, budget };
}
function slimMaterials(materials) {
  return [...materials].map(([id, value]) => [id, { name: value.name, flags: value.flags, color: value.color,
    faces: Object.fromEntries(Object.entries(value.faces ?? {}).map(([face, properties]) => [face, {
      tile: properties.tile, uv: properties.uv, rotation: properties.rotation, tint: properties.tint, tintKind: properties.tintKind ?? 0,
    }])) }]);
}

/** Persistent, bounded LOD of actual received/imported Minecraft columns.
 * Unknown terrain stays empty. Conservative cells and closed column boundaries
 * prevent open cracks, but transitions can show 4/8/16m steps. Partial removals
 * preserve occupancy exactly and may approximate material until re-ingestion.
 */
export class DistantTerrain {
  constructor({ worldKey, materials = new Map(), onMesh = () => {}, onRemove = () => {}, onStatus = () => {},
    minY = -64, height = 384,
    biomeConfiguration = null, biomeSeed = 0n, biomeBlendRadius = 2, indexedDB = globalThis.indexedDB, workerFactory, maxDiskBytes = 128 * 1024 * 1024,
    maxMemoryBytes = 32 * 1024 * 1024, maxMeshBytes = 64 * 1024 * 1024, maxGpuColumns = 2048, regionBatchSize = 1 } = {}) {
    if (typeof worldKey !== 'string' || !worldKey || worldKey.length > 4096) throw new Error('Distant terrain requires a stable server/world identity.');
    this.worldKey = worldKey; this.materials = materials instanceof Map ? materials : new Map(materials);
    ({ minY: this.minY, height: this.height } = dimensionBounds({ minY, height }));
    this.signature = materialSignature(this.materials);
    this.biomeConfiguration = biomeConfiguration; this.biomeSeed = BigInt(biomeSeed); this.biomeBlendRadius = biomeBlendRadius;
    this.biomeSampler = biomeConfiguration ? 'javascript' : 'none';
    if (![1, 2, 4, 8].includes(regionBatchSize)) throw new Error('Distant region batching must use 1, 2, 4 or 8 columns.');
    this.onMesh = onMesh; this.onRemove = onRemove; this.onStatus = onStatus;
    this.factory = indexedDB; this.workerFactory = workerFactory;
    this.maxDiskBytes = maxDiskBytes; this.maxMemoryBytes = maxMemoryBytes; this.maxMeshBytes = maxMeshBytes; this.maxGpuColumns = maxGpuColumns;
    this.regionBatchSize = regionBatchSize;
    this.columns = new Map(); this.catalog = new Map(); this.visible = new Map(); this.near = new Set(); this.desired = new Map();
    this.eye = [0, 80, 0]; this.lastCameraCell = ''; this.clock = 0; this.closed = false;
    this.jobs = new Map(); this.operations = new Map(); this.nextJob = 1;
    this.memoryBytes = 0; this.meshBytes = 0; this.initializing = null; this.refreshing = false; this.refreshAgain = false;
    this.metadataByteBound = dimensionRecordBytes(this.height);
  }

  async init() {
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize();
    return this.initializing;
  }
  async initialize() {
    if (this.closed) throw new Error('Distant terrain has been closed.');
    if (this.workerFactory || typeof Worker !== 'undefined') {
      try {
        this.worker = this.workerFactory ? this.workerFactory() : new Worker(new URL('./distant.worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }) => {
          const pending = this.jobs.get(data.id); if (!pending) return;
          this.jobs.delete(data.id);
          if (data.error) pending.reject(new Error(data.error)); else pending.resolve('record' in data ? data.record : data.mesh ?? data);
        };
        this.worker.onerror = event => {
          const error = new Error(event.message || 'Distant terrain worker failed');
          for (const pending of this.jobs.values()) pending.reject(error);
          this.jobs.clear(); this.worker?.terminate(); this.worker = null;
          this.biomeSampler = this.biomeConfiguration ? 'javascript' : 'none';
          this.onStatus(`Distant worker stopped: ${error.message}`);
        };
        const ready = await this.run('materials', { minY: this.minY, height: this.height, materials: slimMaterials(this.materials), biomeConfiguration: this.biomeConfiguration, biomeSeed: this.biomeSeed, biomeBlendRadius: this.biomeBlendRadius });
        this.biomeSampler = ready.biomeSampler ?? this.biomeSampler;
      } catch (error) { this.worker?.terminate(); this.worker = null; this.onStatus(`Distant worker unavailable: ${error.message}`); }
    }
    if (this.factory) {
      try {
        this.database = await openDatabase(this.factory);
        this.database.onversionchange = () => this.database.close();
        const metadata = await this.readMetadata();
        for (const value of metadata) {
          if (value.worldKey !== this.worldKey) continue;
          if (value.schemaVersion !== DISTANT_CACHE_VERSION || value.signature !== this.signature
            || value.minY !== this.minY || value.height !== this.height) await this.deletePersisted(value.id);
          else this.catalog.set(value.key, value);
        }
        await this.trimDisk();
      } catch (error) { this.database?.close(); this.database = null; this.onStatus(`Distant cache is memory-only: ${error.message}`); }
    } else this.onStatus('Distant cache is memory-only; IndexedDB is unavailable.');
    this.scheduleRefresh();
    return this;
  }

  async run(type, data) {
    if (this.worker) {
      const id = this.nextJob++;
      return new Promise((resolve, reject) => {
        this.jobs.set(id, { resolve, reject });
        try { this.worker.postMessage({ id, type, ...data }); }
        catch (error) { this.jobs.delete(id); reject(error); }
      });
    }
    await tick();
    if (type === 'materials') return { ready: true };
    if (type === 'reduce') return reduceColumn(data.column, this.materials, this);
    if (type === 'mesh') return meshColumn(data.record, data.cellSize, this.materials, this.tintSampler([data.record]));
    if (type === 'region-mesh') return meshRegion(data.records, data.regionX, data.regionZ, data.regionBatchSize, this.materials, this.tintSampler(data.records.map(value => value.record)), this);
    if (type === 'update') return updateReducedBlock(data.record, data.x, data.y, data.z, data.stateId, this.materials);
    throw new Error('Unknown distant terrain task');
  }

  tintSampler(columns) {
    return this.biomeConfiguration ? createBiomeSampler(this.biomeConfiguration, { seed: this.biomeSeed, blendRadius: this.biomeBlendRadius, columns }) : null;
  }
  async setBiomeSeed(seed) {
    this.biomeSeed = BigInt(seed);
    if (this.worker) await this.run('biome-seed', { seed: this.biomeSeed });
    for (const key of [...this.visible.keys()]) this.removeVisible(key);
    this.scheduleRefresh();
  }
  enqueue(key, operation) {
    const next = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(key, next);
    next.finally(() => { if (this.operations.get(key) === next) this.operations.delete(key); }).catch(() => {});
    return next;
  }
  async ingest(column) {
    await this.init();
    if (this.closed) return;
    const key = columnKey(column.x, column.z);
    return this.enqueue(key, async () => {
      if (this.closed) return;
      const record = await this.run('reduce', { column });
      await this.remember(key, record);
      this.scheduleRefresh();
    });
  }
  async updateBlock(x, y, z, stateId) {
    await this.init();
    if (this.closed) return;
    const key = columnKey(Math.floor(x / 16), Math.floor(z / 16));
    return this.enqueue(key, async () => {
      const record = await this.load(key);
      if (!record || this.closed) return;
      const updated = await this.run('update', { record, x, y, z, stateId });
      if (!updated) return;
      await this.remember(key, updated);
      this.scheduleRefresh();
    });
  }
  setNearColumns(columns) {
    const near = new Set(columns);
    if (near.size === this.near.size && [...near].every(key => this.near.has(key))) return;
    this.near = near;
    for (const key of near) this.removeVisible(this.regionKey(key));
    this.scheduleRefresh();
  }
  updateCamera(eye) {
    if (!Array.isArray(eye) && !ArrayBuffer.isView(eye)) return;
    if (eye.length < 3 || ![eye[0], eye[1], eye[2]].every(Number.isFinite)) return;
    this.eye = [...eye];
    const cell = `${Math.floor(eye[0] / 16)},${Math.floor(eye[2] / 16)}`;
    if (cell !== this.lastCameraCell) { this.lastCameraCell = cell; this.scheduleRefresh(); }
  }

  async remember(key, record) {
    if (this.closed) return;
    record.schemaVersion = DISTANT_CACHE_VERSION; record.signature = this.signature; record.revision = ++this.clock;
    const id = `${this.worldKey}\0${key}`, bytes = recordBytes(record), accessedAt = Date.now();
    this.metadataByteBound = Math.max(this.metadataByteBound, bytes);
    const metadata = { id, key, worldKey: this.worldKey, x: record.x, z: record.z, minY: this.minY, height: this.height,
      schemaVersion: DISTANT_CACHE_VERSION, signature: this.signature, bytes, accessedAt, revision: record.revision };
    const previous = this.columns.get(key);
    if (previous) this.memoryBytes -= recordBytes(previous);
    this.columns.set(key, record); this.memoryBytes += bytes; this.catalog.set(key, metadata);
    if (this.database) {
      try {
        const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
        let [old, budget] = await Promise.all([requestResult(transaction.objectStore('metadata').get(id)), requestResult(transaction.objectStore('budget').get(BUDGET_ID))]);
        if (!validBudget(budget)) { budget = (await scanBudget(transaction)).budget; old = normalizedMetadata(old); }
        transaction.objectStore('columns').put({ ...record, id });
        transaction.objectStore('metadata').put(metadata);
        transaction.objectStore('budget').put({ id: BUDGET_ID, count: budget.count + (old ? 0 : 1), bytes: Math.max(0, budget.bytes - (normalizedMetadata(old)?.bytes ?? 0)) + bytes });
        await done;
        await this.trimDisk();
      } catch (error) { this.onStatus(`Distant cache write failed: ${error.message}`); }
    }
    this.trimMemory();
  }
  async load(key) {
    if (this.columns.has(key)) return this.columns.get(key);
    const metadata = this.catalog.get(key);
    if (!metadata || !this.database) return null;
    const request = this.database.transaction('columns', 'readonly').objectStore('columns').get(metadata.id);
    const record = await requestResult(request);
    if (!validCachedColumn(record, this.signature, this) || record.x !== metadata.x || record.z !== metadata.z) {
      this.catalog.delete(key); await this.deletePersisted(metadata.id); return null;
    }
    this.clock = Math.max(this.clock, record.revision ?? 0);
    if (!this.columns.has(key)) { this.columns.set(key, record); this.memoryBytes += recordBytes(record); }
    this.trimMemory(new Set([key]));
    return record;
  }
  async readMetadata({ trimBytes = null } = {}) {
    const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
    const { values, budget } = await scanBudget(transaction), removed = new Set();
    if (trimBytes !== null) for (const value of [...values].sort((a, b) => a.accessedAt - b.accessedAt || a.id.localeCompare(b.id))) {
      if (budget.bytes <= trimBytes) break;
      transaction.objectStore('columns').delete(value.id); transaction.objectStore('metadata').delete(value.id);
      budget.bytes -= value.bytes; budget.count--; removed.add(value.id);
      if (value.worldKey === this.worldKey && !this.columns.has(value.key)) { this.catalog.delete(value.key); this.removeVisible(this.regionKey(value.key)); }
    }
    if (removed.size) transaction.objectStore('budget').put(budget);
    await done;
    for (const value of values) this.metadataByteBound = Math.max(this.metadataByteBound, value.bytes);
    return values.filter(value => !removed.has(value.id));
  }
  async countMetadata() {
    return requestResult(this.database.transaction('metadata', 'readonly').objectStore('metadata').count());
  }
  async deletePersisted(id) {
    const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
    let [old, budget] = await Promise.all([requestResult(transaction.objectStore('metadata').get(id)), requestResult(transaction.objectStore('budget').get(BUDGET_ID))]);
    if (!validBudget(budget)) { budget = (await scanBudget(transaction)).budget; old = normalizedMetadata(old); }
    transaction.objectStore('columns').delete(id); transaction.objectStore('metadata').delete(id);
    if (old) transaction.objectStore('budget').put({ id: BUDGET_ID, count: Math.max(0, budget.count - 1), bytes: Math.max(0, budget.bytes - (normalizedMetadata(old)?.bytes ?? 0)) });
    await done;
  }
  async trimDisk() {
    if (!this.database) return;
    // Both stores are committed with each column write/delete. The aggregate
    // accounts for concurrent worlds of different heights without copying the
    // growing catalog on every import; a native count detects stale accounting.
    const count = await this.countMetadata(), budget = await requestResult(this.database.transaction('budget', 'readonly').objectStore('budget').get(BUDGET_ID));
    if (validBudget(budget) && budget.count === count && budget.bytes <= this.maxDiskBytes) return;
    await this.readMetadata({ trimBytes: this.maxDiskBytes });
  }
  distance(metadata) { return Math.hypot(metadata.x * 16 + 8 - this.eye[0], metadata.z * 16 + 8 - this.eye[2]); }
  regionKey(key) {
    const [x, z] = key.split(',').map(Number);
    return columnKey(Math.floor(x / this.regionBatchSize), Math.floor(z / this.regionBatchSize));
  }
  groupStamp(members) { return members.map(([key, level]) => `${key}:${this.catalog.get(key)?.revision ?? 'missing'}:${level}`).join('|'); }
  trimMemory(protectedKeys = new Set()) {
    // GPU meshes remain resident even when their JavaScript voxel records are
    // evicted. Reload source data only after a region's revision or LOD changes.
    const candidates = [...this.columns.keys()].filter(key => !protectedKeys.has(key) && !this.operations.has(key))
      .sort((a, b) => this.distance(this.catalog.get(b)) - this.distance(this.catalog.get(a)));
    for (const key of candidates) {
      if (this.memoryBytes <= this.maxMemoryBytes) break;
      this.memoryBytes -= recordBytes(this.columns.get(key)); this.columns.delete(key);
      if (!this.database) this.catalog.delete(key);
    }
  }
  removeVisible(key) {
    const previous = this.visible.get(key);
    if (!previous) return;
    this.visible.delete(key); this.meshBytes -= previous.bytes;
    this.onRemove(lodKey(key));
  }

  scheduleRefresh() {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refresh().catch(error => { if (!this.closed) this.onStatus(`Distant terrain: ${error.message}`); });
    }, 0);
  }
  async refresh() {
    if (this.closed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const candidates = [...this.catalog.entries()].filter(([key]) => !this.near.has(key))
          .sort((a, b) => this.distance(a[1]) - this.distance(b[1])).slice(0, this.maxGpuColumns);
        this.desired = new Map(candidates.map(([key, metadata]) => [key, chooseCellSize(this.distance(metadata))]));
        const groups = new Map();
        for (const member of this.desired) {
          const region = this.regionKey(member[0]);
          if (!groups.has(region)) groups.set(region, []);
          groups.get(region).push(member);
        }
        for (const members of groups.values()) members.sort((a, b) => a[0].localeCompare(b[0]));
        for (const key of [...this.visible.keys()]) if (!groups.has(key)) this.removeVisible(key);
        for (const [key, members] of groups) {
          if (this.closed) break;
          const stamp = this.groupStamp(members), current = this.visible.get(key);
          if (current?.stamp === stamp) continue;
          const records = [];
          for (const [column, cellSize] of members) {
            const record = await this.load(column);
            if (record) records.push({ record, cellSize });
          }
          if (!records.length) { this.removeVisible(key); continue; }
          const [regionX, regionZ] = key.split(',').map(Number);
          const mesh = await this.run('region-mesh', { records, regionX, regionZ, regionBatchSize: this.regionBatchSize });
          if (this.closed || stamp !== this.groupStamp(members) || members.some(([column, level]) => this.near.has(column) || this.desired.get(column) !== level)) { this.refreshAgain = true; continue; }
          const bytes = mesh.opaque.byteLength + mesh.water.byteLength;
          this.removeVisible(key);
          if (bytes > this.maxMeshBytes || this.meshBytes + bytes > this.maxMeshBytes) continue;
          this.visible.set(key, { stamp, level: records.length === 1 ? records[0].cellSize : 0,
            revision: records.length === 1 ? records[0].record.revision : 0, members: members.map(([column]) => column), bytes });
          this.meshBytes += bytes;
          if (bytes) this.onMesh(mesh);
          this.trimMemory();
        }
        this.trimMemory();
      } while (this.refreshAgain && !this.closed);
    } finally { this.refreshing = false; }
  }
  stats() { return { rememberedColumns: this.catalog.size, residentColumns: this.columns.size,
    visibleColumns: [...this.visible.values()].reduce((sum, region) => sum + region.members.length, 0), visibleRegions: this.visible.size,
    minY: this.minY, height: this.height, biomeSampler: this.biomeSampler,
    regionBatchSize: this.regionBatchSize, memoryBytes: this.memoryBytes, meshBytes: this.meshBytes, persistent: !!this.database }; }
  async close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.refreshTimer);
    for (const key of [...this.visible.keys()]) this.removeVisible(key);
    await Promise.allSettled([...this.operations.values()]);
    this.worker?.terminate(); this.worker = null;
    for (const pending of this.jobs.values()) pending.reject(new Error('Distant terrain closed'));
    this.jobs.clear(); this.database?.close(); this.database = null;
    this.columns.clear(); this.catalog.clear(); this.memoryBytes = 0;
  }
}
