import { structuredBytes } from '../authority/limits.js';
const DATABASE = 'pomme-source-player-inventories', MAX_BYTES = 32 * 1024 * 1024, SOURCE_BYTES = 4 * 1024 * 1024, MAX_WORLDS = 8;
let writes = Promise.resolve(), pending = 0, pendingBytes = 0;
const request = operation => new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error ?? new Error('Source inventory storage request failed.')); });
const done = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Source inventory storage transaction failed.')); });
function key(worldKey) { if (typeof worldKey !== 'string' || worldKey.length < 1 || worldKey.length > 4096) throw new Error('Invalid source inventory world key.'); return worldKey; }
function sourceBytes(source) {
  const unavailable = source?.unavailable && source.player === null && source.present === true && typeof source.unavailable.reason === 'string' && source.unavailable.reason.length <= 512;
  if (source?.format !== 'java-player-inventory-v1' || typeof source.present !== 'boolean' || source.present && source.player?.type !== 10 && !unavailable) throw new Error('Invalid source player inventory descriptor.');
  return structuredBytes(source, SOURCE_BYTES);
}
async function open(factory) {
  if (!factory) return null;
  const operation = factory.open(DATABASE, 1);
  operation.onupgradeneeded = () => { if (!operation.result.objectStoreNames.contains('sources')) operation.result.createObjectStore('sources', { keyPath: 'worldKey' }); };
  return request(operation);
}

/** Bounded bootstrap cache; confirmed native inventory saves always outrank it. */
export function storeSourceLevelInventory(worldKey, source, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  key(worldKey); const bytes = sourceBytes(source) + worldKey.length * 2 + 64;
  if (pending >= MAX_WORLDS || pendingBytes + bytes > MAX_BYTES) return Promise.reject(new Error('Source inventory storage queue exceeds its limit.'));
  const captured = structuredClone(source); pending++; pendingBytes += bytes;
  const operation = writes.then(async () => {
    if (!isCurrent()) return false;
    const database = await open(indexedDB); if (!database) return false;
    try {
      if (!isCurrent()) return false;
      const transaction = database.transaction('sources', 'readwrite'), completed = done(transaction), store = transaction.objectStore('sources');
      void completed.catch(() => {});
      const records = await request(store.getAll());
      if (!isCurrent()) { await completed; return false; }
      const retained = [];
      for (const record of records) {
        if (record.worldKey === worldKey) continue;
        try { key(record.worldKey); const actualBytes = sourceBytes(record.source) + record.worldKey.length * 2 + 64; if (!Number.isFinite(record.savedAt) || record.bytes !== actualBytes) throw new Error('Invalid source cache accounting.'); retained.push(record); }
        catch { store.delete(record.worldKey); }
      }
      retained.sort((a, b) => a.savedAt - b.savedAt);
      let used = retained.reduce((total, record) => total + record.bytes, bytes);
      while (retained.length >= MAX_WORLDS || used > MAX_BYTES) { const evicted = retained.shift(); if (!evicted) throw new Error('Source inventory exceeds storage limit.'); store.delete(evicted.worldKey); used -= evicted.bytes; }
      store.put({ worldKey, source: captured, bytes, savedAt: Date.now() }); await completed; return true;
    } finally { database.close(); }
  });
  writes = operation.catch(() => {}).finally(() => { pending--; pendingBytes -= bytes; }); return operation;
}

export async function restoreSourceLevelInventory(worldKey, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  key(worldKey); await writes;
  if (!isCurrent()) return null;
  const database = await open(indexedDB); if (!database) return null;
  try {
    if (!isCurrent()) return null;
    const transaction = database.transaction('sources', 'readonly'), completed = done(transaction);
    void completed.catch(() => {});
    const record = await request(transaction.objectStore('sources').get(worldKey)); await completed;
    if (!isCurrent() || !record) return null;
    try { sourceBytes(record.source); return structuredClone(record.source); } catch { return null; }
  } finally { database.close(); }
}
