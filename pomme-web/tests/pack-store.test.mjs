import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { storeResourcePack, restoreResourcePack, clearResourcePack } from '../src/pack-store.js';

test('resource pack cache preserves original JAR bytes, filename and metadata', async () => {
  const indexedDB = new IDBFactory(), bytes = Uint8Array.from([80, 75, 0, 127, 255]);
  const file = new File([bytes], 'minecraft-client-1.20.4.jar', { type: 'application/java-archive', lastModified: 123456 });
  assert.equal(await restoreResourcePack({ indexedDB }), null);
  assert.deepEqual(await storeResourcePack(file, { indexedDB }), { name: file.name, bytes: 5 });
  const restored = await restoreResourcePack({ indexedDB });
  assert.equal(restored.name, file.name);
  assert.equal(restored.lastModified, file.lastModified);
  assert.equal(restored.type, file.type);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes);
  await clearResourcePack({ indexedDB });
  assert.equal(await restoreResourcePack({ indexedDB }), null);
});

test('the cache keeps only the latest imported pack and enforces its byte limit', async () => {
  const indexedDB = new IDBFactory();
  await storeResourcePack(new File([new Uint8Array([1, 2])], 'first.zip'), { indexedDB });
  await storeResourcePack(new File([new Uint8Array([3, 4, 5])], 'second.jar'), { indexedDB });
  await assert.rejects(storeResourcePack(new Blob([new Uint8Array(5)]), { indexedDB, maxBytes: 4 }), /cache limit/);
  assert.equal((await restoreResourcePack({ indexedDB })).name, 'second.jar', 'rejected writes preserve the previous valid imported pack');
  await assert.rejects(restoreResourcePack({ indexedDB, maxBytes: 2 }), /exceeds the cache limit/);
  await storeResourcePack(null, { indexedDB });
  assert.equal(await restoreResourcePack({ indexedDB }), null);
});

test('URLs are never fetched and unavailable/quota storage errors are descriptive', async () => {
  await assert.rejects(storeResourcePack('https://example.com/pack.zip'), /URLs are not accepted/);
  await assert.rejects(storeResourcePack(new Blob([1]), { indexedDB: null }), /IndexedDB/);
  const quota = { open() {
    const request = {};
    queueMicrotask(() => { request.error = new DOMException('Full', 'QuotaExceededError'); request.onerror(); });
    return request;
  } };
  await assert.rejects(storeResourcePack(new Blob([1]), { indexedDB: quota }), /storage is full/);
});
