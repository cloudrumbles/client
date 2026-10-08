import { structuredBytes } from '../authority/limits.js';
const SOURCE_BYTES = 8 * 1024 * 1024, TOTAL_BYTES = 32 * 1024 * 1024;
let writes = Promise.resolve(), pending = 0, pendingBytes = 0;
const key = value => { if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('Invalid source item world key.'); return value; };
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const done = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Source item cache aborted.')); });
const bytes = source => {
  if (source?.format !== 'java-source-world-items-v1' || !Array.isArray(source.records) || source.records.length > 1024 || source.unavailable && (source.records.length || typeof source.unavailable.reason !== 'string' || source.unavailable.reason.length > 512)) throw new Error('Invalid source item descriptor.');
  return structuredBytes(source, SOURCE_BYTES);
};
async function open(factory) {
  if (!factory) return null;
  const operation = factory.open('pomme-source-world-items-v1', 1);
  operation.onupgradeneeded = () => operation.result.createObjectStore('sources', { keyPath: 'worldKey' }); return request(operation);
}
export function storeSourceWorldItems(worldKey, source, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  key(worldKey); const size = bytes(source) + worldKey.length * 2 + 64;
  if (pending >= 8 || pendingBytes + size > TOTAL_BYTES) return Promise.reject(new Error('Source item cache queue exceeds its limit.'));
  const captured = structuredClone(source);
  pending++; pendingBytes += size;
  const operation = writes.then(async () => {
    if (!isCurrent()) return false; const database = await open(indexedDB); if (!database) return false;
    try {
      if (!isCurrent()) return false;
      const transaction = database.transaction('sources', 'readwrite'), completed = done(transaction), store = transaction.objectStore('sources'); void completed.catch(() => {});
      const all = await request(store.getAll()); if (!isCurrent()) { await completed; return false; }
      const retained = [];
      for (const record of all) if (record.worldKey !== worldKey) {
        try { key(record.worldKey); if (record.bytes !== bytes(record.source) + record.worldKey.length * 2 + 64 || !Number.isFinite(record.savedAt)) throw new Error('Invalid cache accounting.'); retained.push(record); }
        catch { store.delete(record.worldKey); }
      }
      retained.sort((left, right) => left.savedAt - right.savedAt); let used = retained.reduce((total, record) => total + record.bytes, size);
      while (retained.length >= 8 || used > TOTAL_BYTES) { const record = retained.shift(); if (!record) throw new Error('Source items exceed cache capacity.'); store.delete(record.worldKey); used -= record.bytes; }
      store.put({ worldKey, source: captured, bytes: size, savedAt: Date.now() }); await completed; return true;
    } finally { database.close(); }
  });
  writes = operation.catch(() => {}).finally(() => { pending--; pendingBytes -= size; }); return operation;
}
export async function restoreSourceWorldItems(worldKey, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  key(worldKey); await writes; if (!isCurrent()) return null; const database = await open(indexedDB); if (!database) return null;
  try {
    if (!isCurrent()) return null; const transaction = database.transaction('sources'), completed = done(transaction); void completed.catch(() => {});
    const record = await request(transaction.objectStore('sources').get(worldKey)); await completed; if (!isCurrent() || !record) return null;
    try { bytes(record.source); return structuredClone(record.source); } catch { return null; }
  } finally { database.close(); }
}
