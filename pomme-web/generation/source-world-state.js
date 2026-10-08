const VERSION = '1.21.11';
// Native 1.21.11 dimension_type data; noise shape height is a separate generation setting.
export const SOURCE_DIMENSIONS = Object.freeze({
  'minecraft:overworld': Object.freeze({ minY: -64, height: 384, hasSkylight: true }),
  'minecraft:the_nether': Object.freeze({ minY: 0, height: 256, hasSkylight: false }),
  'minecraft:the_end': Object.freeze({ minY: 0, height: 256, hasSkylight: true }),
});
export function sourceSeed(value) {
  if (typeof value === 'string') value = value.trim();
  if (!(typeof value === 'bigint' || typeof value === 'string' && value.length <= 21 && /^-?\d+$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value))) throw new Error('Enter a signed 64-bit integer seed.');
  const seed = BigInt(value);
  if (seed < -9223372036854775808n || seed > 9223372036854775807n) throw new Error('Seed must fit a signed 64-bit integer.');
  return String(seed);
}
export function validateSourceWorld(saved) {
  if (saved?.schemaVersion !== 1 || saved.kind !== 'source-generated' || saved.version !== VERSION || typeof saved.worldKey !== 'string' || !saved.worldKey.startsWith(`generated:${VERSION}:`) || saved.worldKey.length > 256 || !Object.hasOwn(SOURCE_DIMENSIONS, saved.dimension)) throw new Error('Saved browser terrain settings are unavailable or incompatible.');
  if (typeof saved.name !== 'string' || saved.name.length < 1 || saved.name.length > 64 || !Array.isArray(saved.spawn) || saved.spawn.length !== 3 || !saved.spawn.every(Number.isFinite) || Math.abs(saved.spawn[0]) > 30000000 || Math.abs(saved.spawn[2]) > 30000000 || Math.abs(saved.spawn[1]) > 2147483647 || typeof saved.cycle !== 'boolean') throw new Error('Invalid saved browser terrain settings.');
  return { schemaVersion: 1, kind: 'source-generated', version: VERSION, worldKey: saved.worldKey, seed: sourceSeed(saved.seed), dimension: saved.dimension,
    name: saved.name, spawn: saved.spawn.slice(), dayTime: sourceSeed(saved.dayTime), cycle: saved.cycle };
}
const DATABASE = 'pomme-generated-world-settings', MAX_WORLDS = 8, MAX_PENDING = 16;
let writes = Promise.resolve(), pending = 0;
const request = operation => new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error ?? new Error('Browser world settings request failed.')); });
const done = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Browser world settings transaction failed.')); });
async function open(factory) {
  if (!factory) throw new Error('Browser storage is unavailable.');
  const operation = factory.open(DATABASE, 1);
  operation.onupgradeneeded = () => operation.result.createObjectStore('worlds', { keyPath: 'worldKey' });
  return request(operation);
}
/** Durable immutable generation context, with mutable location and day time. */
export function storeSourceWorld(settings, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  const captured = validateSourceWorld(settings);
  if (pending >= MAX_PENDING) return Promise.reject(new Error('Browser world settings save queue is full.'));
  pending++;
  const operation = writes.then(async () => {
    if (!isCurrent()) return false;
    const database = await open(indexedDB);
    try {
      if (!isCurrent()) return false;
      const transaction = database.transaction('worlds', 'readwrite'), completed = done(transaction), store = transaction.objectStore('worlds');
      void completed.catch(() => {});
      const records = await request(store.getAll(undefined, MAX_WORLDS + 1));
      if (!isCurrent()) { await completed; return false; }
      if (records.length > MAX_WORLDS) { transaction.abort(); throw new Error('Browser world settings exceed their storage bound.'); }
      const previous = records.find(record => record.worldKey === captured.worldKey);
      if (previous) {
        const original = validateSourceWorld(previous.settings);
        if (original.seed !== captured.seed || original.dimension !== captured.dimension || original.version !== captured.version) { transaction.abort(); throw new Error('A saved world cannot change its generation seed or dimension.'); }
      }
      const retained = records.filter(record => record.worldKey !== captured.worldKey).sort((a, b) => a.savedAt - b.savedAt);
      if (retained.length >= MAX_WORLDS) store.delete(retained[0].worldKey);
      store.put({ worldKey: captured.worldKey, settings: captured, savedAt: Date.now() });
      await completed; return true;
    } finally { database.close(); }
  });
  writes = operation.catch(() => {}).finally(() => pending--);
  return operation;
}
export async function restoreSourceWorld(worldKey, { indexedDB = globalThis.indexedDB, isCurrent = () => true } = {}) {
  await writes;
  if (!isCurrent()) return null;
  const database = await open(indexedDB);
  try {
    const transaction = database.transaction('worlds', 'readonly'), completed = done(transaction), store = transaction.objectStore('worlds');
    void completed.catch(() => {});
    const records = worldKey ? [await request(store.get(worldKey))] : await request(store.getAll(undefined, MAX_WORLDS + 1));
    await completed;
    if (!isCurrent() || records.length > MAX_WORLDS) return null;
    for (const record of records.filter(Boolean).sort((a, b) => b.savedAt - a.savedAt)) {
      try { if (record.worldKey !== record.settings.worldKey) continue; return validateSourceWorld(record.settings); } catch {}
    }
    return null;
  } finally { database.close(); }
}
