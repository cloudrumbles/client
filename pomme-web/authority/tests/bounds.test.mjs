import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { BrowserAuthority } from '../client.js';
import { AuthorityStorage } from '../storage.js';
import { InventoryStorage } from '../inventory-storage.js';
import { InventoryAuthority } from '../inventory-client.js';
import { structuredBytes, MAX_PENDING_REQUESTS } from '../limits.js';
class PendingWorker {
  constructor() { this.messages = []; }
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
test('authority request count and memory are bounded before posting work', async () => {
  const client = new BrowserAuthority({ WorkerClass: PendingWorker }), pending = [];
  for (let index = 0; index < MAX_PENDING_REQUESTS - 1; index++) pending.push(client.request('step', { ticks: 1 }).catch(error => error.message));
  await assert.rejects(client.request('step', { ticks: 1 }), /queue is full/); assert.equal(client.worker.messages.length, MAX_PENDING_REQUESTS - 1);
  client.destroy(); await Promise.all(pending); assert.equal(client.pendingBytes, 0);
  const memory = new BrowserAuthority({ WorkerClass: PendingWorker });
  await assert.rejects(memory.request('restore', { bytes: new Uint8Array(33 * 1024 * 1024) }), /memory limit/); assert.equal(memory.worker.messages.length, 0); memory.destroy();
});
test('authority close immediately suppresses pending old-world events', async () => {
  const received = [], client = new BrowserAuthority({ WorkerClass: PendingWorker, onEvents: events => received.push(...events) });
  const use = client.request('use-block', {}), close = client.close({ save: false });
  client.worker.onmessage({ data: { type: 'result', id: 1, result: { events: [{ stateId: 1 }], value: true } } }); await use;
  assert.deepEqual(received, []); client.worker.onmessage({ data: { type: 'result', id: 2, result: { events: [] } } }); await close;
  assert.equal(client.worker.terminated, true); await assert.rejects(client.request('step', {}), /closed/);
});
test('authority pause drains delayed native tick changes before gating its active world mirror', async () => {
  const mirror = new Map(), received = [], client = new BrowserAuthority({ WorkerClass: PendingWorker, onEvents: (events, state) => {
    for (const event of events) mirror.set(`${event.x},${event.y},${event.z}`, event.stateId);
    received.push({ events, age: state.age });
  } });
  try {
    const button = stateId => ({ x: 1, y: 2, z: 3, stateId });
    const tick = (stateId, age) => client.worker.onmessage({ data: { type: 'tick', events: [button(stateId)], state: { age } } });
    tick(11, 1n); assert.equal(mirror.get('1,2,3'), 11);
    const pause = client.pause();
    // The native release was already posted by the worker when the page
    // paused. Deliver it later, followed by the ordered pause acknowledgment.
    await new Promise(resolve => setTimeout(() => {
      tick(10, 20n);
      client.worker.onmessage({ data: { type: 'result', id: 1, result: { events: [], state: { age: 20n } } } });
      resolve();
    }, 0));
    await pause;
    assert.equal(mirror.get('1,2,3'), 10);
    assert.deepEqual(received.map(entry => entry.age), [1n, 20n]);
    assert.equal(client.state.age, 20n); assert.equal(client.tickGate, true);
    tick(11, 21n); assert.equal(mirror.get('1,2,3'), 10, 'acknowledged pause suppresses later unsolicited ticks');
    const resume = client.start();
    client.worker.onmessage({ data: { type: 'result', id: 2, result: { events: [], state: { age: 20n } } } }); await resume;
    tick(11, 22n); assert.equal(mirror.get('1,2,3'), 11); assert.equal(client.tickGate, false);
  } finally { client.destroy(); }
});
test('a rejected authority pause keeps delivering its still-running tick changes', async () => {
  const received = [], client = new BrowserAuthority({ WorkerClass: PendingWorker, onEvents: events => received.push(...events) });
  try {
    const pause = client.pause(), rejected = assert.rejects(pause, /pause failed/);
    client.worker.onmessage({ data: { type: 'result', id: 1, error: 'pause failed' } }); await rejected;
    client.worker.onmessage({ data: { type: 'tick', events: [{ stateId: 10 }], state: { age: 20n } } });
    assert.deepEqual(received, [{ stateId: 10 }]); assert.notEqual(client.tickGate, true);
  } finally { client.destroy(); }
});
test('authority storage keeps at most eight complete private worlds', async () => {
  const storage = new AuthorityStorage(); await storage.open();
  for (let index = 0; index < 9; index++) await storage.put(`bounded-${index}`, { version: 'test', bytes: new Uint8Array(44), metadata: [] });
  assert.equal(await storage.get('test', 'bounded-0'), null); assert.ok(await storage.get('test', 'bounded-8'));
  assert.equal(await storage.get('different', 'bounded-8'), null);
  await assert.rejects(storage.put('oversized', { version: 'test', bytes: new Uint8Array(17 * 1024 * 1024) }), /save size/);
  storage.close();
});
test('authority metadata rejects excessive depth and accounts typed arrays', () => {
  assert.ok(structuredBytes({ bytes: new Uint8Array(4096) }) >= 4096);
  const root = {}, shared = new Uint8Array(100), cycle = { shared }; cycle.self = cycle;
  assert.ok(structuredBytes({ a: cycle, b: cycle }) < 1000);
  let current = root; for (let index = 0; index < 70; index++) current = current.next = {};
  assert.throws(() => structuredBytes(root), /complexity/);
});

test('block and inventory saves preserve established multi-region world identities', async () => {
  const worldKey = `import:1.21.11:${Array.from({ length: 100 }, (_, index) => `r.${index}.0.mca:8454144:1712345678900`).join('|')}`;
  assert.ok(worldKey.length > 256 && worldKey.length <= 4096);
  for (const Storage of [AuthorityStorage, InventoryStorage]) {
    const storage = new Storage(); await storage.open();
    const snapshot = { version: '1.21.11', bytes: new Uint8Array(44), metadata: [], words: new Uint32Array(211), components: [{}] };
    try {
      await storage.put(worldKey, snapshot); assert.deepEqual(await storage.get('1.21.11', worldKey), snapshot);
      assert.equal(await storage.get('1.20.4', worldKey), null);
      assert.throws(() => storage.key('1.21.11', 'x'.repeat(4097)), /world key/);
    } finally { storage.close(); }
  }
});

test('every inventory close caller waits for the same persisted shutdown', async () => {
  const inventory = new InventoryAuthority({ WorkerClass: PendingWorker }), first = inventory.close(), second = inventory.close();
  assert.equal(second, first); assert.equal(inventory.transport.closed, undefined);
  inventory.transport.worker.onmessage({ data: { type: 'result', id: 1, result: { events: [] } } });
  await Promise.all([first, second]); assert.equal(inventory.transport.closed, true); assert.equal(inventory.transport.pending.size, 0);
});
