import { structuredBytes } from './limits.js';
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const complete = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error ?? new Error('Inventory save aborted.')); transaction.onerror = () => {}; });
export class InventoryStorage {
  async open() {
    const opening = indexedDB.open('pomme-browser-inventory-v1', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('inventories', { keyPath: 'key' });
    this.database = await request(opening); this.database.onversionchange = () => this.close();
  }
  key(version, worldKey) {
    if (typeof version !== 'string' || typeof worldKey !== 'string' || !worldKey || worldKey.length > 4096) throw new Error('Invalid browser inventory world key.');
    return `${version}:${worldKey}`;
  }
  async get(version, worldKey) {
    const transaction = this.database.transaction('inventories'), done = complete(transaction);
    const record = await request(transaction.objectStore('inventories').get(this.key(version, worldKey))); await done; return record?.snapshot ?? null;
  }
  async put(worldKey, snapshot) {
    const key = this.key(snapshot.version, worldKey), byteLength = structuredBytes(snapshot, 5 * 1024 * 1024);
    const transaction = this.database.transaction('inventories', 'readwrite'), done = complete(transaction), store = transaction.objectStore('inventories');
    const records = await request(store.getAll()), previous = records.find(record => record.key === key);
    store.put({ key, snapshot, byteLength, updated: Math.max(Date.now(), (previous?.updated ?? 0) + 1) });
    const other = records.filter(record => record.key !== key).sort((a, b) => a.updated - b.updated);
    let bytes = byteLength + other.reduce((sum, record) => sum + record.byteLength, 0), count = other.length + 1;
    for (const record of other) { if (count <= 8 && bytes <= 32 * 1024 * 1024) break; store.delete(record.key); bytes -= record.byteLength; count--; }
    await done;
  }
  close() { this.database?.close(); this.database = null; }
}
