const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const complete = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error ?? new Error('Authority save aborted.')); transaction.onerror = () => {}; });
const MAX_WORLDS = 8, MAX_BYTES = 32 * 1024 * 1024;
import { MAX_METADATA_BYTES, structuredBytes } from './limits.js';

export class AuthorityStorage {
  async open() {
    const opening = indexedDB.open('pomme-browser-authority-v1', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('worlds', { keyPath: 'key' });
    this.database = await request(opening);
    this.database.onversionchange = () => this.close();
  }
  key(version, worldKey) {
    if (typeof version !== 'string' || typeof worldKey !== 'string' || !worldKey || worldKey.length > 4096) throw new Error('Invalid browser authority world key.');
    return `${version}:${worldKey}`;
  }
  async get(version, worldKey) {
    const transaction = this.database.transaction('worlds'), done = complete(transaction);
    const record = await request(transaction.objectStore('worlds').get(this.key(version, worldKey)));
    await done; return record?.snapshot ?? null;
  }
  async put(worldKey, snapshot) {
    const key = this.key(snapshot.version, worldKey), coreBytes = snapshot.bytes?.byteLength;
    if (!Number.isInteger(coreBytes) || coreBytes > 16 * 1024 * 1024 || coreBytes < 44) throw new Error('Invalid browser authority save size.');
    const byteLength = coreBytes + structuredBytes(snapshot.metadata ?? [], MAX_METADATA_BYTES);
    if (byteLength > 16 * 1024 * 1024) throw new Error('Browser authority save exceeds its memory limit.');
    const transaction = this.database.transaction('worlds', 'readwrite'), done = complete(transaction), store = transaction.objectStore('worlds');
    const records = await request(store.getAll());
    const now = Date.now(), previous = records.find(record => record.key === key);
    store.put({ key, snapshot, byteLength, updated: Math.max(now, (previous?.updated ?? 0) + 1) });
    const other = records.filter(record => record.key !== key).sort((a, b) => a.updated - b.updated);
    let bytes = byteLength + other.reduce((sum, record) => sum + record.byteLength, 0), count = other.length + 1;
    for (const record of other) {
      if (count <= MAX_WORLDS && bytes <= MAX_BYTES) break;
      store.delete(record.key); bytes -= record.byteLength; count--;
    }
    await done;
  }
  close() { this.database?.close(); this.database = null; }
}
