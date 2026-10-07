import { gzipSync, gunzipSync } from '../vendor/fflate.js';

export const CHUNK_STORE_DATABASE = 'pomme-full-columns';
export const CHUNK_STORE_VERSION = 1;
const LIGHT_KEYS = ['skyLight', 'blockLight', 'SkyLight', 'BlockLight'];
const columnKey = (x, z) => `${x},${z}`;

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
  const request = factory.open(CHUNK_STORE_DATABASE, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore('columns', { keyPath: 'id' });
    const metadata = database.createObjectStore('metadata', { keyPath: 'id' });
    metadata.createIndex('worldKey', 'worldKey');
  };
  return requestResult(request);
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
        const metadata = await this.allMetadata();
        for (const entry of metadata) {
          this.accessClock = Math.max(this.accessClock, entry.accessedAt ?? 0);
          if (entry.worldKey === this.worldKey) {
            if (entry.schemaVersion !== CHUNK_STORE_VERSION || entry.registryVersion !== this.registryVersion) await this.removePersisted(entry.id);
            else this.catalog.set(entry.key, entry);
          }
        }
        await this.trimDisk();
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
          const transaction = this.database.transaction(['columns', 'metadata'], 'readwrite');
          transaction.objectStore('columns').put({ ...encoded, id, registryVersion: this.registryVersion });
          transaction.objectStore('metadata').put(metadata);
          await transactionDone(transaction); this.catalog.set(key, metadata); await this.trimDisk();
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
    const metadata = this.catalog.get(key);
    if (!metadata || !this.database) return;
    metadata.accessedAt = ++this.accessClock;
    const transaction = this.database.transaction('metadata', 'readwrite');
    transaction.objectStore('metadata').put(metadata);
    await transactionDone(transaction);
  }
  async allMetadata() { return requestResult(this.database.transaction('metadata', 'readonly').objectStore('metadata').getAll()); }
  async removePersisted(id) {
    const transaction = this.database.transaction(['columns', 'metadata'], 'readwrite');
    transaction.objectStore('columns').delete(id); transaction.objectStore('metadata').delete(id);
    await transactionDone(transaction);
  }
  async trimDisk() {
    if (!this.database) return;
    const metadata = await this.allMetadata();
    let bytes = metadata.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of metadata.sort((a, b) => a.accessedAt - b.accessedAt)) {
      if (bytes <= this.maxDiskBytes) break;
      await this.removePersisted(entry.id); bytes -= entry.bytes;
      if (entry.worldKey === this.worldKey) this.catalog.delete(entry.key);
    }
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
