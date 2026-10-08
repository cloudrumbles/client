export const RESOURCE_PACK_DATABASE = 'pomme-resource-pack';
export const RESOURCE_PACK_LIMIT = 256 * 1024 * 1024;
const KEY = 'last-imported';

function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function databaseFor(factory) {
  if (!factory) throw new Error('Resource-pack persistence is unavailable because this browser does not support IndexedDB.');
  const request = factory.open(RESOURCE_PACK_DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('packs');
  return requestResult(request);
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Resource-pack cache transaction aborted.'));
  });
}
function cacheError(error, action) {
  if (error?.name === 'QuotaExceededError') return new Error('Browser storage is full; the resource pack could not be cached. The loaded textures remain available in this session.', { cause: error });
  return new Error(`Resource pack ${action} failed: ${error?.message ?? String(error)}`, { cause: error });
}

/** Store only a user-provided ZIP/JAR or bytes; this module never fetches URLs. */
export async function storeResourcePack(file, { indexedDB = globalThis.indexedDB, maxBytes = RESOURCE_PACK_LIMIT } = {}) {
  if (file == null) { await clearResourcePack({ indexedDB }); return null; }
  let blob;
  if (file instanceof Blob) blob = new Blob([file], { type: file.type || 'application/zip' });
  else if (file instanceof Uint8Array || file instanceof ArrayBuffer) blob = new Blob([file], { type: 'application/zip' });
  else throw new Error('Resource-pack caching requires an imported File, Blob or byte array; URLs are not accepted.');
  if (!Number.isFinite(maxBytes) || maxBytes < 0 || blob.size > maxBytes) throw new Error(`Resource pack exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB browser-cache limit.`);
  const name = typeof file.name === 'string' && file.name ? file.name : 'resource-pack.zip';
  if (name.length > 512) throw new Error('Resource-pack filename is too long.');
  const record = { schemaVersion: 1, name, type: blob.type, lastModified: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(), blob, bytes: blob.size };
  let database;
  try {
    database = await databaseFor(indexedDB);
    const transaction = database.transaction('packs', 'readwrite');
    transaction.objectStore('packs').put(record, KEY);
    await transactionDone(transaction);
    return { name, bytes: blob.size };
  } catch (error) { throw cacheError(error, 'cache write'); }
  finally { database?.close(); }
}

export async function restoreResourcePack({ indexedDB = globalThis.indexedDB, maxBytes = RESOURCE_PACK_LIMIT } = {}) {
  let database;
  try {
    database = await databaseFor(indexedDB);
    const record = await requestResult(database.transaction('packs', 'readonly').objectStore('packs').get(KEY));
    if (!record) return null;
    if (record.schemaVersion !== 1 || !(record.blob instanceof Blob) || record.blob.size !== record.bytes || record.bytes > maxBytes || typeof record.name !== 'string') throw new Error('The cached resource pack is invalid or exceeds the cache limit. Import the pack again.');
    if (typeof File !== 'undefined') return new File([record.blob], record.name, { type: record.type, lastModified: record.lastModified });
    const blob = new Blob([record.blob], { type: record.type });
    Object.defineProperties(blob, { name: { value: record.name, enumerable: true }, lastModified: { value: record.lastModified, enumerable: true } });
    return blob;
  } catch (error) { throw cacheError(error, 'restore'); }
  finally { database?.close(); }
}

export async function clearResourcePack({ indexedDB = globalThis.indexedDB } = {}) {
  let database;
  try {
    database = await databaseFor(indexedDB);
    const transaction = database.transaction('packs', 'readwrite');
    transaction.objectStore('packs').delete(KEY);
    await transactionDone(transaction);
  } catch (error) { throw cacheError(error, 'cache removal'); }
  finally { database?.close(); }
}
