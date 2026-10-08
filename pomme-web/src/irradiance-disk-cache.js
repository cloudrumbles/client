import { IRRADIANCE_LIMITS } from './irradiance.js';

export const IRRADIANCE_DISK_DATABASE = 'pomme-irradiance-cache-v1';
export const IRRADIANCE_DISK_LIMITS = Object.freeze({ maxBytes: 64 * 1024 * 1024, maxContexts: 8,
  maxAngles: 240, maxEntries: 1920, maxPending: 8 });
const STORES = ['sources', 'sourceMetadata', 'angles', 'angleMetadata', 'budget'];
const now = () => globalThis.performance?.now() ?? Date.now();
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const complete = transaction => {
  const promise = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('Irradiance cache transaction aborted.'));
  });
  // A request may reject before the caller reaches the transaction completion.
  void promise.catch(() => {}); return promise;
};
const emptyBudget = () => ({ id: 'global', schema: 1, bytes: 0, contexts: 0, entries: 0, clock: 0 });
const keyValid = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const bucketValid = bucket => Number.isInteger(bucket) && bucket >= 0 && bucket < IRRADIANCE_DISK_LIMITS.maxAngles;
const positive = value => Number.isSafeInteger(value) && value >= 0;
const budgetValid = budget => budget?.id === 'global' && budget.schema === 1 && positive(budget.bytes)
  && budget.bytes <= IRRADIANCE_DISK_LIMITS.maxBytes && positive(budget.contexts) && budget.contexts <= 8
  && positive(budget.entries) && budget.entries <= 1920 && positive(budget.clock) && budget.clock < Number.MAX_SAFE_INTEGER;
const sourceMetadataValid = value => keyValid(value?.sourceKey) && positive(value.bytes) && value.bytes > 0
  && positive(value.entries) && value.entries > 0 && value.entries <= 240 && positive(value.entryBytes)
  && positive(value.accessedAt) && keyValid(value.sharedHash) && positive(value.cells) && value.cells > 0 && value.cells <= IRRADIANCE_LIMITS.maxCells;
const angleMetadataValid = value => keyValid(value?.sourceKey) && bucketValid(value.bucket)
  && Array.isArray(value.id) && value.id[0] === value.sourceKey && value.id[1] === value.bucket
  && value.id.length === 2 && positive(value.bytes) && value.bytes > 0 && positive(value.accessedAt) && keyValid(value.entryHash);

function sharedValid(localData, alpha) {
  return localData instanceof Uint16Array && alpha instanceof Uint16Array && alpha.length > 0 && alpha.length <= IRRADIANCE_LIMITS.maxCells
    && localData.length === alpha.length * 4 && localData.every(value => value <= 0x3c00)
    && alpha.every(value => value === 0 || value === 0x3c00);
}
function entryValid(entry, cells) {
  if (!(entry?.rgb instanceof Uint16Array) || !entry.rgb.length || entry.rgb.length > cells * 3 || entry.rgb.some(value => value > 0x3800)) return false;
  if (entry.lengths === undefined) return entry.rgb.length === cells * 3;
  return entry.lengths instanceof Uint32Array && entry.lengths.length > 0 && entry.lengths.length <= cells
    && entry.rgb.length === entry.lengths.length * 3 && entry.lengths.every(value => value > 0 && value <= cells)
    && entry.lengths.reduce((sum, value) => sum + value, 0) === cells;
}
function statsCopy(stats = {}) {
  if (!stats || Object.getPrototypeOf(stats) !== Object.prototype || Object.keys(stats).length > 32) throw new Error('Invalid irradiance cache statistics.');
  for (const [key, value] of Object.entries(stats)) if (key.length > 64 || !(value === null || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 256)) throw new Error('Invalid irradiance cache statistics.');
  const copy = { ...stats }, bytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength;
  if (bytes > 8192) throw new Error('Irradiance cache statistics exceed their byte limit.');
  return { copy, bytes };
}
function entryCopy(entry) {
  const copy = { rgb: entry.rgb.slice(), ...(entry.lengths ? { lengths: entry.lengths.slice() } : {}) };
  copy.bytes = copy.rgb.byteLength + (copy.lengths?.byteLength ?? 0); return copy;
}
async function sharedHash(crypto, localData, alpha) {
  if (typeof crypto?.subtle?.digest !== 'function') throw new Error('Irradiance cache requires SHA-256.');
  const bytes = new Uint8Array(localData.byteLength + alpha.byteLength);
  bytes.set(new Uint8Array(localData.buffer, localData.byteOffset, localData.byteLength));
  bytes.set(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.byteLength), localData.byteLength);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
const angleHash = (crypto, entry) => sharedHash(crypto, entry.rgb, entry.lengths ?? new Uint32Array());

/** Optional, disposable lighting cache. It never reads or writes world saves.
 * Source SHA-256 keys must include source/material tables and algorithm version.
 * Shared local light and visibility are immutable for that key; angles preserve
 * every half-float RGB bit, including compressed run lengths. Budget accounting
 * includes buffers plus conservative metadata/string allowances, not browser
 * implementation overhead. Accepted I/O and caller snapshots are bounded. */
export class IrradianceDiskCache {
  constructor({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, maxBytes = IRRADIANCE_DISK_LIMITS.maxBytes,
    maxContexts = 8, maxAngles = 240, maxEntries = 1920, maxPending = 8 } = {}) {
    for (const [name, value] of Object.entries({ maxBytes, maxContexts, maxAngles, maxEntries, maxPending }))
      if (!Number.isInteger(value) || value < (name === 'maxBytes' ? 0 : 1) || value > IRRADIANCE_DISK_LIMITS[name]) throw new Error(`Invalid irradiance disk-cache ${name}.`);
    this.factory = indexedDB; this.crypto = crypto; this.maxBytes = maxBytes; this.maxContexts = maxContexts; this.maxAngles = maxAngles; this.maxEntries = maxEntries; this.maxPending = maxPending;
    this.database = null; this.opening = null; this.closed = false; this.jobs = new Set(); this.closePromise = null;
    this.metrics = { diskCacheBytes: 0, diskCacheContexts: 0, diskCacheEntries: 0, diskHits: 0, diskMisses: 0,
      diskWrites: 0, diskErrors: 0, diskRejected: 0, diskEvictions: 0, diskReadMs: 0, diskWriteMs: 0, diskReadBytes: 0, diskWriteBytes: 0 };
  }
  stats() { return { ...this.metrics, diskPending: this.jobs.size, diskMaxPending: this.maxPending, diskMaxBytes: this.maxBytes }; }
  admit(operation, requireEnabled = true) {
    if (this.closed || !this.factory || requireEnabled && !this.maxBytes || this.jobs.size >= this.maxPending) {
      this.metrics.diskRejected++; return Promise.resolve(null);
    }
    let promise;
    // Calling immediately snapshots inputs before a caller can mutate buffers.
    try { promise = Promise.resolve(operation()); } catch (error) { promise = Promise.reject(error); }
    const job = promise.catch(() => { this.metrics.diskErrors++; return null; }).finally(() => this.jobs.delete(job));
    this.jobs.add(job); return job;
  }
  async open() {
    if (this.database) return this.database;
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      const value = this.factory.open(IRRADIANCE_DISK_DATABASE, 1); let blocked = false;
      value.onupgradeneeded = () => {
        const database = value.result;
        database.createObjectStore('sources', { keyPath: 'sourceKey' });
        database.createObjectStore('sourceMetadata', { keyPath: 'sourceKey' }).createIndex('accessedAt', 'accessedAt');
        database.createObjectStore('angles', { keyPath: 'id' });
        const metadata = database.createObjectStore('angleMetadata', { keyPath: 'id' });
        metadata.createIndex('sourceKey', 'sourceKey'); metadata.createIndex('accessedAt', 'accessedAt');
        database.createObjectStore('budget', { keyPath: 'id' });
      };
      value.onsuccess = () => {
        if (blocked) { value.result.close(); return; }
        this.database = value.result;
        this.database.onversionchange = () => { this.database?.close(); this.database = null; this.closed = true; };
        resolve(this.database);
      };
      value.onerror = () => reject(value.error);
      value.onblocked = () => { blocked = true; reject(new Error('Irradiance cache opening was blocked.')); };
    }).catch(error => { this.opening = null; throw error; });
    return this.opening;
  }
  reset(transaction) {
    for (const name of STORES) transaction.objectStore(name).clear();
    const budget = emptyBudget(); transaction.objectStore('budget').put(budget); transaction.cacheBudget = budget; return budget;
  }
  async budget(transaction) {
    const value = await request(transaction.objectStore('budget').get('global'));
    transaction.cacheBudget = budgetValid(value) ? value : this.reset(transaction); return transaction.cacheBudget;
  }
  account(budget) {
    this.metrics.diskCacheBytes = budget.bytes; this.metrics.diskCacheContexts = budget.contexts; this.metrics.diskCacheEntries = budget.entries;
  }
  async removeSource(transaction, budget, metadata) {
    if (!sourceMetadataValid(metadata)) throw new Error('Invalid irradiance source metadata.');
    const angles = await request(transaction.objectStore('angleMetadata').index('sourceKey').getAll(metadata.sourceKey));
    if (angles.length !== metadata.entries || angles.some(value => !angleMetadataValid(value))
      || angles.reduce((sum, value) => sum + value.bytes, 0) !== metadata.entryBytes) throw new Error('Invalid irradiance source accounting.');
    for (const angle of angles) { transaction.objectStore('angles').delete(angle.id); transaction.objectStore('angleMetadata').delete(angle.id); }
    transaction.objectStore('sources').delete(metadata.sourceKey); transaction.objectStore('sourceMetadata').delete(metadata.sourceKey);
    budget.bytes -= metadata.bytes + metadata.entryBytes; budget.contexts--; budget.entries -= metadata.entries;
    transaction.cacheEvictions = (transaction.cacheEvictions ?? 0) + metadata.entries;
  }
  async removeAngle(transaction, budget, metadata) {
    if (!angleMetadataValid(metadata)) throw new Error('Invalid irradiance angle metadata.');
    const source = await request(transaction.objectStore('sourceMetadata').get(metadata.sourceKey));
    if (!sourceMetadataValid(source)) throw new Error('Invalid irradiance source metadata.');
    transaction.objectStore('angles').delete(metadata.id); transaction.objectStore('angleMetadata').delete(metadata.id);
    budget.bytes -= metadata.bytes; budget.entries--; source.entries--; source.entryBytes -= metadata.bytes;
    if (!source.entries) {
      transaction.objectStore('sources').delete(source.sourceKey); transaction.objectStore('sourceMetadata').delete(source.sourceKey);
      budget.bytes -= source.bytes; budget.contexts--;
    } else transaction.objectStore('sourceMetadata').put(source);
    transaction.cacheEvictions = (transaction.cacheEvictions ?? 0) + 1;
  }
  async trim(transaction, budget, sourceKey = null) {
    if (sourceKey) {
      const source = await request(transaction.objectStore('sourceMetadata').get(sourceKey));
      if (source && source.entries > this.maxAngles) {
        const angles = await request(transaction.objectStore('angleMetadata').index('sourceKey').getAll(sourceKey));
        angles.sort((a, b) => a.accessedAt - b.accessedAt);
        for (let count = source.entries; count > this.maxAngles; count--) await this.removeAngle(transaction, budget, angles.shift());
      }
    }
    while (budget.contexts > this.maxContexts) {
      const cursor = await request(transaction.objectStore('sourceMetadata').index('accessedAt').openCursor());
      if (!cursor) throw new Error('Missing irradiance source accounting.'); await this.removeSource(transaction, budget, cursor.value);
    }
    while (budget.bytes > this.maxBytes || budget.entries > this.maxEntries) {
      const cursor = await request(transaction.objectStore('angleMetadata').index('accessedAt').openCursor());
      if (!cursor) throw new Error('Missing irradiance angle accounting.'); await this.removeAngle(transaction, budget, cursor.value);
    }
    transaction.objectStore('budget').put(budget);
  }
  async transaction(operation) {
    const database = await this.open(), transaction = database.transaction(STORES, 'readwrite'), done = complete(transaction);
    try { const result = await operation(transaction); await done;
      if (transaction.cacheBudget) this.account(transaction.cacheBudget);
      this.metrics.diskEvictions += transaction.cacheEvictions ?? 0; return result; }
    catch (error) { try { transaction.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  get(sourceKey, bucket) {
    return this.admit(async () => {
      const started = now();
      if (!keyValid(sourceKey) || !bucketValid(bucket)) throw new Error('Invalid irradiance cache key.');
      const result = await this.transaction(async transaction => {
        const budget = await this.budget(transaction), id = [sourceKey, bucket];
        const [sourceMeta, angleMeta] = await Promise.all([request(transaction.objectStore('sourceMetadata').get(sourceKey)),
          request(transaction.objectStore('angleMetadata').get(id))]);
        // An uncached angle must not read hundreds of KiB of shared lighting.
        if (!angleMeta && (!sourceMeta || sourceMetadataValid(sourceMeta))) return null;
        if (!sourceMetadataValid(sourceMeta) || !angleMetadataValid(angleMeta)) { this.reset(transaction); return null; }
        const [source, angle] = await Promise.all([request(transaction.objectStore('sources').get(sourceKey)), request(transaction.objectStore('angles').get(id))]);
        if (!sharedValid(source?.localData, source?.alpha)
          || source.alpha.length !== sourceMeta.cells || !entryValid(angle?.entry, sourceMeta.cells)) {
          this.reset(transaction); return null;
        }
        // IndexedDB already returned detached typed arrays. Retain those buffers
        // without another full-volume copy; the caller owns this read result.
        const entry = { rgb: angle.entry.rgb, ...(angle.entry.lengths ? { lengths: angle.entry.lengths } : {}),
          bytes: angle.entry.rgb.byteLength + (angle.entry.lengths?.byteLength ?? 0) };
        let statistics;
        try { statistics = statsCopy(source.stats).copy; } catch { this.reset(transaction); return null; }
        if (angleMeta.bytes !== entry.bytes + 512 || sourceMeta.bytes !== source.localData.byteLength + source.alpha.byteLength
          + new TextEncoder().encode(JSON.stringify(statistics)).byteLength * 2 + 640) {
          this.reset(transaction); return null;
        }
        const accessedAt = ++budget.clock; sourceMeta.accessedAt = accessedAt; angleMeta.accessedAt = accessedAt;
        transaction.objectStore('sourceMetadata').put(sourceMeta); transaction.objectStore('angleMetadata').put(angleMeta);
        await this.trim(transaction, budget, sourceKey);
        return { localData: source.localData, alpha: source.alpha, entry, stats: statistics, sharedHash: sourceMeta.sharedHash, entryHash: angleMeta.entryHash };
      });
      if (result && (await sharedHash(this.crypto, result.localData, result.alpha) !== result.sharedHash || await angleHash(this.crypto, result.entry) !== result.entryHash)) {
        await this.transaction(async transaction => {
          const budget = await this.budget(transaction), source = await request(transaction.objectStore('sourceMetadata').get(sourceKey));
          if (source?.sharedHash === result.sharedHash) { await this.removeSource(transaction, budget, source); transaction.objectStore('budget').put(budget); }
        });
        this.metrics.diskReadMs += now() - started; this.metrics.diskMisses++; return null;
      }
      const readMs = now() - started; this.metrics.diskReadMs += readMs;
      if (!result) { this.metrics.diskMisses++; return null; }
      delete result.sharedHash; delete result.entryHash; result.readMs = readMs; result.bytes = result.localData.byteLength + result.alpha.byteLength + result.entry.bytes;
      this.metrics.diskHits++; this.metrics.diskReadBytes += result.bytes; return result;
    });
  }
  put(sourceKey, bucket, value) {
    return this.admit(async () => {
      const started = now();
      if (!keyValid(sourceKey) || !bucketValid(bucket) || !sharedValid(value?.localData, value?.alpha) || !entryValid(value?.entry, value.alpha.length)) throw new Error('Invalid irradiance disk-cache entry.');
      const localData = value.localData.slice(), alpha = value.alpha.slice(), entry = entryCopy(value.entry), statistics = statsCopy(value.stats);
      const bytes = localData.byteLength + alpha.byteLength + statistics.bytes * 2 + 640, angleBytes = entry.bytes + 512;
      if (bytes + angleBytes > this.maxBytes) { this.metrics.diskRejected++; return null; }
      const hash = await sharedHash(this.crypto, localData, alpha), entryHash = await angleHash(this.crypto, entry);
      const writtenBytes = await this.transaction(async transaction => {
        const budget = await this.budget(transaction), id = [sourceKey, bucket];
        let [source, previous] = await Promise.all([request(transaction.objectStore('sourceMetadata').get(sourceKey)), request(transaction.objectStore('angleMetadata').get(id))]);
        if (source && !sourceMetadataValid(source) || previous && !angleMetadataValid(previous) || previous && !source) {
          Object.assign(budget, this.reset(transaction)); transaction.cacheBudget = budget; source = previous = undefined;
        }
        if (source && (source.sharedHash !== hash || source.cells !== alpha.length)) throw new Error('Irradiance source key reused for different shared lighting.');
        const sharedWrite = !source, accessedAt = ++budget.clock;
        if (!source) {
          source = { sourceKey, bytes, cells: alpha.length, sharedHash: hash, entries: 0, entryBytes: 0, accessedAt };
          transaction.objectStore('sources').put({ sourceKey, localData, alpha, stats: statistics.copy }); budget.bytes += bytes; budget.contexts++;
        }
        source.entries += previous ? 0 : 1; source.entryBytes += angleBytes - (previous?.bytes ?? 0); source.accessedAt = accessedAt;
        budget.entries += previous ? 0 : 1; budget.bytes += angleBytes - (previous?.bytes ?? 0);
        transaction.objectStore('sourceMetadata').put(source);
        transaction.objectStore('angles').put({ id, entry }); transaction.objectStore('angleMetadata').put({ id, sourceKey, bucket, bytes: angleBytes, accessedAt, entryHash });
        await this.trim(transaction, budget, sourceKey);
        return entry.bytes + (sharedWrite ? localData.byteLength + alpha.byteLength : 0);
      });
      const writeMs = now() - started; this.metrics.diskWrites++; this.metrics.diskWriteMs += writeMs; this.metrics.diskWriteBytes += writtenBytes;
      return { persisted: true, writeMs, bytes: writtenBytes };
    });
  }
  clear() {
    const prior = [...this.jobs];
    return this.admit(async () => { await Promise.all(prior); await this.transaction(transaction => { this.reset(transaction); }); return true; }, false);
  }
  close() {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = Promise.all([...this.jobs]).then(() => { this.database?.close(); this.database = null; });
    }
    return this.closePromise;
  }
}
