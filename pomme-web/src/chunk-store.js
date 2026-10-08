import { gzipSync, gunzipSync } from '../vendor/fflate.js';

export const CHUNK_STORE_DATABASE = 'pomme-full-columns';
export const CHUNK_STORE_VERSION = 1;
const LIGHT_KEYS = ['skyLight', 'blockLight', 'SkyLight', 'BlockLight'];
const columnKey = (x, z) => `${x},${z}`;
const MAX_BLOCK_ENTITY_BYTES = 1024 * 1024;
const MAX_ENCODED_COLUMN_BYTES = 16 * 1024 * 1024;
const BUDGET_ID = 'global';

function blockEntityMetadata(entities, clone = true) {
  if (!Array.isArray(entities) || entities.length > 4096) throw new Error('Cached block entity metadata requires at most 4096 entries.');
  let bytes = 0, nodes = 0; const visited = new WeakSet();
  const read = (value, depth = 0) => {
    if (++nodes > 131072 || depth > 32) throw new Error('Cached block entity NBT exceeds its nesting limit.');
    const add = size => { bytes += size; if (bytes > MAX_BLOCK_ENTITY_BYTES) throw new Error('Cached block entity NBT exceeds its byte limit.'); };
    if (value === null || value === undefined || typeof value === 'boolean') { add(4); return value; }
    if (typeof value === 'string') { add(value.length * 2 + 8); return value; }
    if (typeof value === 'bigint') { add(8); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Invalid number in cached block entity NBT.'); add(8); return value; }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) { add(value.byteLength + 32); return clone ? value.slice() : value; }
    if (!value || typeof value !== 'object' || visited.has(value)) throw new Error('Invalid or cyclic cached block entity NBT.');
    visited.add(value); add(32);
    if (Array.isArray(value)) {
      if (value.length > 65536) throw new Error('Cached block entity NBT array exceeds its entry limit.');
      const result = clone ? [] : value; for (let i = 0; i < value.length; i++) { const child = read(value[i], depth + 1); if (clone) result.push(child); } visited.delete(value); return result;
    }
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error('Invalid cached block entity NBT object.');
    const entries = Object.entries(value); if (entries.length > 4096) throw new Error('Cached block entity NBT compound exceeds its entry limit.');
    const result = clone ? Object.create(null) : value;
    for (const [key, child] of entries) { add(key.length * 2 + 8); const decoded = read(child, depth + 1); if (clone) result[key] = decoded; }
    visited.delete(value); return result;
  };
  return { value: read(entities), bytes };
}

function requireCoordinates(column) {
  if (!column || !Number.isSafeInteger(column.x) || !Number.isSafeInteger(column.z)) throw new Error('Chunk cache columns require integer x/z coordinates.');
  if (!Array.isArray(column.sections) || column.sections.length > 256) throw new Error('Chunk cache columns require at most 256 sections.');
}
function encodeBytes(bytes, format) {
  const raw = bytes.slice(), compressed = gzipSync(raw, { level: 1 });
  return compressed.length < raw.length ? { format: `gzip-${format}`, bytes: compressed, length: raw.length } : { format, bytes: raw, length: raw.length };
}
function decodeBytes(value, expectedLength) {
  if (!(value?.bytes instanceof Uint8Array) || value.length !== expectedLength) throw new Error('Invalid cached byte-array size.');
  if (value.bytes.byteLength > expectedLength + 64) throw new Error('Cached compressed array exceeds its size limit.');
  const bytes = value.format.startsWith('gzip-') ? gunzipSync(value.bytes, { out: new Uint8Array(expectedLength + 1) }) : value.bytes;
  if (bytes.length !== expectedLength) throw new Error('Cached byte array has an invalid decoded length.');
  return bytes.slice();
}
function lightBytes(value) {
  if (!(value instanceof Uint8Array) || ![2048, 4096].includes(value.length)) throw new Error('Cached section lighting requires 2048 packed or 4096 unpacked bytes.');
  return encodeBytes(value, 'u8');
}
function decodeLight(value) {
  if (!['u8', 'gzip-u8'].includes(value?.format) || ![2048, 4096].includes(value?.length)) throw new Error('Invalid cached section-light encoding.');
  return decodeBytes(value, value.length);
}

/** Exact full sections: singleton palettes avoid storing 4096 duplicate states. */
export function encodeColumn(column) {
  requireCoordinates(column);
  const seen = new Set();
  const sections = column.sections.map(section => {
    if (!Number.isInteger(section.sectionY) || seen.has(section.sectionY) || !(section.blocks instanceof Uint16Array) || section.blocks.length !== 4096) throw new Error('Cached sections require distinct sectionY and 4096 Uint16 block states.');
    seen.add(section.sectionY);
    const stateId = section.blocks[0];
    let uniform = true;
    for (let i = 1; i < 4096 && uniform; i++) uniform = section.blocks[i] === stateId;
    let states;
    if (uniform) states = { format: 'uniform', stateId };
    else {
      const bytes = new Uint8Array(8192), view = new DataView(bytes.buffer);
      for (let i = 0; i < 4096; i++) view.setUint16(i * 2, section.blocks[i], true);
      states = encodeBytes(bytes, 'u16le');
    }
    const result = { sectionY: section.sectionY, states };
    for (const key of LIGHT_KEYS) if (section[key] !== undefined) result[key] = lightBytes(section[key]);
    if (section.biomes instanceof Uint32Array) {
      if (section.biomes.length !== 64) throw new Error('Cached biome arrays require 64 entries.');
      const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
      for (let i = 0; i < 64; i++) view.setUint32(i * 4, section.biomes[i], true);
      result.biomes = encodeBytes(bytes, 'u32le');
    }
    return result;
  });
  const result = { schemaVersion: CHUNK_STORE_VERSION, x: column.x, z: column.z, sections };
  if (column.blockEntities !== undefined) { const metadata = blockEntityMetadata(column.blockEntities); result.blockEntities = metadata.value; result.blockEntityBytes = metadata.bytes; }
  if (column.light) {
    result.light = {};
    for (const kind of ['sky', 'block']) {
      const entries = column.light[kind] instanceof Map ? [...column.light[kind]] : column.light[kind] ?? [];
      if (!Array.isArray(entries) || entries.length > 258) throw new Error('Invalid cached column light map.');
      result.light[kind] = entries.map(([sectionY, values]) => {
        if (!Number.isInteger(sectionY)) throw new Error('Light sections require integer coordinates.');
        return [sectionY, lightBytes(values)];
      });
    }
  }
  return result;
}

export function decodeColumn(record) {
  if (record?.schemaVersion !== CHUNK_STORE_VERSION) throw new Error('Cached chunk format is incompatible.');
  requireCoordinates(record);
  const seen = new Set();
  const sections = record.sections.map(section => {
    if (!Number.isInteger(section.sectionY) || seen.has(section.sectionY)) throw new Error('Invalid cached section coordinate.');
    seen.add(section.sectionY);
    const states = section.states;
    const blocks = new Uint16Array(4096);
    if (states?.format === 'uniform') {
      if (!Number.isInteger(states.stateId) || states.stateId < 0 || states.stateId > 65535) throw new Error('Invalid cached uniform state.');
      blocks.fill(states.stateId);
    } else if (['u16le', 'gzip-u16le'].includes(states?.format)) {
      const bytes = decodeBytes(states, 8192), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < 4096; i++) blocks[i] = view.getUint16(i * 2, true);
    } else throw new Error('Invalid cached block-state encoding.');
    const result = { sectionY: section.sectionY, blocks };
    for (const key of LIGHT_KEYS) if (section[key] !== undefined) result[key] = decodeLight(section[key]);
    if (section.biomes) {
      if (!['u32le', 'gzip-u32le'].includes(section.biomes.format)) throw new Error('Invalid cached biome encoding.');
      const bytes = decodeBytes(section.biomes, 256), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), biomes = new Uint32Array(64);
      for (let i = 0; i < 64; i++) biomes[i] = view.getUint32(i * 4, true);
      result.biomes = biomes;
    }
    return result;
  });
  const column = { x: record.x, z: record.z, sections };
  if (record.blockEntities !== undefined) column.blockEntities = blockEntityMetadata(record.blockEntities).value;
  if (record.light) {
    column.light = {};
    for (const kind of ['sky', 'block']) {
      if (!Array.isArray(record.light[kind]) || record.light[kind].length > 258) throw new Error('Invalid cached light map.');
      column.light[kind] = new Map(record.light[kind].map(([sectionY, values]) => {
        if (!Number.isInteger(sectionY)) throw new Error('Invalid cached light-map section.');
        return [sectionY, decodeLight(values)];
      }));
    }
  }
  return column;
}

export function encodedColumnBytes(record) {
  let bytes = 256 + record.sections.length * 64;
  if (record.blockEntities !== undefined) bytes += blockEntityMetadata(record.blockEntities, false).bytes;
  for (const section of record.sections) {
    bytes += section.states.bytes?.byteLength ?? 2;
    bytes += section.biomes?.bytes.byteLength ?? 0;
    for (const key of LIGHT_KEYS) bytes += section[key]?.bytes.byteLength ?? 0;
  }
  if (record.light) for (const kind of ['sky', 'block']) for (const [, values] of record.light[kind]) bytes += values.bytes.byteLength + 32;
  return bytes;
}
export function decodedColumnBytes(column) {
  let bytes = 256 + column.sections.length * 64;
  if (column.blockEntities !== undefined) bytes += blockEntityMetadata(column.blockEntities, false).bytes;
  for (const section of column.sections) {
    bytes += section.blocks.byteLength + (section.biomes?.byteLength ?? 0);
    for (const key of LIGHT_KEYS) bytes += section[key]?.byteLength ?? 0;
  }
  if (column.light) for (const kind of ['sky', 'block']) for (const values of column.light[kind]?.values() ?? []) bytes += values.byteLength + 32;
  return bytes;
}
function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Chunk-store transaction aborted'));
  });
}
function openDatabase(factory) {
  const request = factory.open(CHUNK_STORE_DATABASE, 2);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains('columns')) database.createObjectStore('columns', { keyPath: 'id' });
    const metadata = database.objectStoreNames.contains('metadata') ? request.transaction.objectStore('metadata') : database.createObjectStore('metadata', { keyPath: 'id' });
    if (!metadata.indexNames.contains('worldKey')) metadata.createIndex('worldKey', 'worldKey');
    if (!metadata.indexNames.contains('accessedAt')) metadata.createIndex('accessedAt', 'accessedAt');
    if (!database.objectStoreNames.contains('budget')) database.createObjectStore('budget', { keyPath: 'id' });
  };
  return requestResult(request);
}

function normalizedMetadata(value) {
  if (!value || typeof value.worldKey !== 'string' || !value.worldKey || value.worldKey.length > 4096
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.z)
    || value.key !== columnKey(value.x, value.z) || value.id !== `${value.worldKey}\0${value.key}`
    || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1
    || typeof value.registryVersion !== 'string' || value.registryVersion.length > 128
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ENCODED_COLUMN_BYTES
    || !Number.isSafeInteger(value.accessedAt) || value.accessedAt < 0) return null;
  return value;
}
function validBudget(value) {
  return value?.id === BUDGET_ID && Number.isSafeInteger(value.count) && value.count >= 0
    && Number.isSafeInteger(value.bytes) && value.bytes >= value.count && value.bytes <= value.count * MAX_ENCODED_COLUMN_BYTES
    && Number.isSafeInteger(value.clock) && value.clock >= 0;
}
async function repairBudget(transaction) {
  const metadata = transaction.objectStore('metadata'), columns = transaction.objectStore('columns');
  const values = await requestResult(metadata.getAll()), budget = { id: BUDGET_ID, count: 0, bytes: 0, clock: 0 };
  for (const value of values) {
    if (!normalizedMetadata(value)) { metadata.delete(value.id); columns.delete(value.id); continue; }
    budget.count++; budget.bytes += value.bytes; budget.clock = Math.max(budget.clock, value.accessedAt);
  }
  transaction.objectStore('budget').put(budget);
  return budget;
}
async function readBudget(transaction, verifyCount = false) {
  const budget = await requestResult(transaction.objectStore('budget').get(BUDGET_ID));
  if (validBudget(budget) && (!verifyCount || budget.count === await requestResult(transaction.objectStore('metadata').count()))) return budget;
  return repairBudget(transaction);
}
function trimTransaction(transaction, budget, maxBytes) {
  if (budget.bytes <= maxBytes) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const removed = [], request = transaction.objectStore('metadata').index('accessedAt').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || budget.bytes <= maxBytes) { resolve(removed); return; }
      const metadata = cursor.value;
      cursor.delete(); transaction.objectStore('columns').delete(metadata.id);
      budget.count--; budget.bytes -= metadata.bytes; removed.push(metadata); cursor.continue();
    };
  });
}

/** Bounded full-column persistence for imported worlds; coarse LOD is separate.
 * get() returns a detached copy. Call put() after editing it to persist changes.
 */
export class ChunkStore {
  constructor({ worldKey, maxMemoryBytes = 32 * 1024 * 1024, maxDiskBytes = 512 * 1024 * 1024,
    indexedDB = globalThis.indexedDB, registryVersion = '1.20.4', onStatus = () => {} } = {}) {
    if (typeof worldKey !== 'string' || !worldKey || worldKey.length > 4096) throw new Error('ChunkStore requires a stable world identity.');
    if (![maxMemoryBytes, maxDiskBytes].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Chunk-store budgets must be non-negative byte counts.');
    Object.assign(this, { worldKey, maxMemoryBytes, maxDiskBytes, registryVersion, onStatus });
    this.factory = indexedDB; this.cache = new Map(); this.catalog = new Map(); this.memoryBytes = 0; this.accessClock = 0;
    this.queue = Promise.resolve(); this.initializing = null; this.closed = false;
  }
  init() {
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }
  async initialize() {
    if (this.closed) throw new Error('ChunkStore has closed.');
    if (this.factory) {
      try {
        this.database = await openDatabase(this.factory);
        this.database.onversionchange = () => this.database.close();
        await this.trimDisk();
        const metadata = await requestResult(this.database.transaction('metadata', 'readonly').objectStore('metadata').index('worldKey').getAll(this.worldKey));
        for (const entry of metadata) {
          this.accessClock = Math.max(this.accessClock, entry.accessedAt ?? 0);
          if (!normalizedMetadata(entry) || entry.schemaVersion !== CHUNK_STORE_VERSION || entry.registryVersion !== this.registryVersion) await this.removePersisted(entry.id);
          else this.catalog.set(entry.key, entry);
        }
      } catch (error) { this.database?.close(); this.database = null; this.onStatus(`Full chunk cache is memory-only: ${error.message}`); }
    } else this.onStatus('Full chunk cache is memory-only; IndexedDB is unavailable.');
    return this;
  }
  enqueue(operation) {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async put(column) {
    if (this.closed) throw new Error('ChunkStore has closed.');
    // Snapshot synchronously so an importer's reusable section buffer cannot
    // mutate a pending write. Uniform states avoid full-size cache snapshots.
    const encoded = encodeColumn(column);
    await this.init();
    return this.enqueue(async () => {
      const key = columnKey(encoded.x, encoded.z), id = `${this.worldKey}\0${key}`;
      const metadata = { id, key, worldKey: this.worldKey, x: encoded.x, z: encoded.z,
        bytes: encodedColumnBytes(encoded), schemaVersion: CHUNK_STORE_VERSION, registryVersion: this.registryVersion,
        accessedAt: ++this.accessClock };
      this.remember(key, decodeColumn(encoded));
      if (this.database && metadata.bytes <= this.maxDiskBytes) {
        try {
          const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
          let budget = await readBudget(transaction);
          const store = transaction.objectStore('metadata'), rawOld = await requestResult(store.get(id)), old = normalizedMetadata(rawOld);
          if (rawOld && !old) budget = await repairBudget(transaction);
          metadata.accessedAt = ++budget.clock; this.accessClock = Math.max(this.accessClock, budget.clock);
          transaction.objectStore('columns').put({ ...encoded, id, registryVersion: this.registryVersion });
          store.put(metadata);
          budget.count += old ? 0 : 1; budget.bytes += metadata.bytes - (old?.bytes ?? 0);
          const removed = await trimTransaction(transaction, budget, this.maxDiskBytes);
          transaction.objectStore('budget').put(budget);
          await done;
          this.catalog.set(key, metadata); this.forgetRemoved(removed);
          return { key, persisted: this.catalog.has(key), bytes: metadata.bytes };
        } catch (error) { this.onStatus(`Full chunk cache write failed: ${error.message}`); }
      } else if (this.database && this.catalog.has(key)) {
        // A replacement must not leave an older persisted version available.
        await this.removePersisted(id); this.catalog.delete(key);
      }
      return { key, persisted: false, bytes: metadata.bytes };
    });
  }
  async get(x, z) {
    if (this.closed) throw new Error('ChunkStore has closed.');
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) throw new Error('Chunk coordinates must be integers.');
    await this.init();
    return this.enqueue(async () => {
      const key = columnKey(x, z);
      if (this.cache.has(key)) {
        const value = this.cache.get(key); this.cache.delete(key); this.cache.set(key, value);
        await this.touch(key);
        return structuredClone(value);
      }
      const metadata = this.catalog.get(key);
      if (!metadata || !this.database) return null;
      const encoded = await requestResult(this.database.transaction('columns', 'readonly').objectStore('columns').get(metadata.id));
      try {
        if (!encoded || encoded.registryVersion !== this.registryVersion) throw new Error('Cached block registry is incompatible.');
        const value = decodeColumn(encoded);
        this.remember(key, value); await this.touch(key); return structuredClone(value);
      } catch (error) {
        this.catalog.delete(key); await this.removePersisted(metadata.id);
        this.onStatus(`Discarded invalid cached chunk ${key}: ${error.message}`); return null;
      }
    });
  }
  keys() { return [...new Set([...this.catalog.keys(), ...this.cache.keys()])]; }
  remember(key, value) {
    if (this.cache.has(key)) { this.memoryBytes -= decodedColumnBytes(this.cache.get(key)); this.cache.delete(key); }
    const bytes = decodedColumnBytes(value);
    if (bytes > this.maxMemoryBytes) return;
    this.cache.set(key, value); this.memoryBytes += bytes;
    while (this.memoryBytes > this.maxMemoryBytes) {
      const oldest = this.cache.keys().next().value;
      this.memoryBytes -= decodedColumnBytes(this.cache.get(oldest)); this.cache.delete(oldest);
    }
  }
  async touch(key) {
    const known = this.catalog.get(key);
    if (!known || !this.database) return;
    const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
    const budget = await readBudget(transaction), store = transaction.objectStore('metadata');
    const metadata = normalizedMetadata(await requestResult(store.get(known.id)));
    if (metadata) {
      metadata.accessedAt = ++budget.clock; this.accessClock = Math.max(this.accessClock, budget.clock);
      store.put(metadata); transaction.objectStore('budget').put(budget);
    }
    await done;
    if (metadata) this.catalog.set(key, metadata); else this.catalog.delete(key);
  }
  async removePersisted(id) {
    const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
    let budget = await readBudget(transaction);
    const rawOld = await requestResult(transaction.objectStore('metadata').get(id)), old = normalizedMetadata(rawOld);
    if (rawOld && !old) budget = await repairBudget(transaction);
    transaction.objectStore('columns').delete(id); transaction.objectStore('metadata').delete(id);
    if (old) { budget.count--; budget.bytes -= old.bytes; transaction.objectStore('budget').put(budget); }
    await done;
  }
  forgetRemoved(removed) {
    for (const metadata of removed) if (metadata.worldKey === this.worldKey) this.catalog.delete(metadata.key);
  }
  async trimDisk() {
    if (!this.database) return;
    const transaction = this.database.transaction(['columns', 'metadata', 'budget'], 'readwrite'), done = transactionDone(transaction);
    const budget = await readBudget(transaction, true), removed = await trimTransaction(transaction, budget, this.maxDiskBytes);
    transaction.objectStore('budget').put(budget); await done;
    this.accessClock = Math.max(this.accessClock, budget.clock); this.forgetRemoved(removed);
  }
  stats() { return { memoryBytes: this.memoryBytes, residentColumns: this.cache.size, persistedColumns: this.catalog.size,
    diskBytes: [...this.catalog.values()].reduce((sum, entry) => sum + entry.bytes, 0), persistent: !!this.database }; }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.initializing?.catch(() => {}); await this.queue;
    this.database?.close(); this.database = null;
    this.cache.clear(); this.catalog.clear(); this.memoryBytes = 0;
  }
}
