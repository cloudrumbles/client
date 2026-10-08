import { MAX_PENDING_REQUESTS, MAX_PENDING_BYTES, structuredBytes } from './limits.js';

/** A browser worker owns authoritative WASM state, ticks and IndexedDB saves. */
export class BrowserAuthority {
  static async open(options) {
    const client = new BrowserAuthority(options);
    const { registry, worldKey, snapshot, minY, height, wasmUrl, wasmBytes, autoTick = false } = options;
    try { client.initial = await client.request('init', { registry, worldKey, snapshot, minY, height, wasmUrl: wasmUrl?.href ?? wasmUrl, wasmBytes, autoTick }); return client; }
    catch (error) { client.destroy(); throw error; }
  }
  constructor({ onEvents = () => {}, onError = () => {}, WorkerClass = globalThis.Worker } = {}) {
    this.onEvents = onEvents; this.onError = onError; this.pending = new Map(); this.sequence = 0; this.pendingBytes = 0;
    this.worker = new WorkerClass(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data.type === 'failure') { this.onError(new Error(data.message)); return; }
      const result = data.result ?? data;
      if (result.state) this.state = result.state;
      if (result.events?.length && !this.closing && !(data.type === 'tick' && this.tickGate)) {
        try { this.onEvents(result.events, this.state); } catch (error) { this.onError(error); }
      }
      if (data.type !== 'result') return;
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id);
      this.pendingBytes -= pending.bytes;
      if (data.error) pending.reject(new Error(data.error)); else pending.resolve(result);
    };
    this.worker.onerror = event => { const error = new Error(event.message); this.onError(error); this.destroy(error); };
  }
  request(action, args = {}) {
    if (this.closed || this.closing && action !== 'close') return Promise.reject(new Error('Browser authority is closed.'));
    if (this.pending.size >= MAX_PENDING_REQUESTS - (action === 'close' ? 0 : 1)) return Promise.reject(new Error('Browser authority request queue is full.'));
    let bytes;
    try { bytes = structuredBytes(args); } catch (error) { return Promise.reject(error); }
    if (this.pendingBytes + bytes > MAX_PENDING_BYTES - (action === 'close' ? 0 : 1024)) return Promise.reject(new Error('Browser authority request queue exceeds its memory limit.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pendingBytes += bytes;
      this.pending.set(id, { resolve, reject, bytes });
      try { this.worker.postMessage({ id, action, args }); }
      catch (error) { this.pending.delete(id); this.pendingBytes -= bytes; reject(error); }
    });
  }
  async loadSection(x, sectionY, z, blocks) { return this.request('load-section', { x, sectionY, z, blocks }); }
  async loadColumns(columns) { return this.request('load-columns', { columns }); }
  async setBlock(x, y, z, stateId) { return this.request('set-block', { x, y, z, stateId }); }
  async useBlock(x, y, z) { return (await this.request('use-block', { x, y, z })).value; }
  async blockAt(x, y, z) { return (await this.request('get-block', { x, y, z })).value; }
  async step(ticks = 1) { return this.request('step', { ticks }); }
  async setTime(time, daylight = true) { return this.request('set-time', { time: BigInt(time), daylight }); }
  async snapshot() { return (await this.request('snapshot')).value; }
  async restore(snapshot) { return this.request('restore', { snapshot }); }
  async sections() { return (await this.request('sections')).value; }
  async column(x, z) { return (await this.request('column', { x, z })).value; }
  async columns() {
    const metadata = (await this.request('columns')).value;
    const columns = new Map(metadata.map(column => [`${column.x},${column.z}`, { ...column, sections: [] }]));
    for (const section of await this.sections()) { const key = `${section.x},${section.z}`; if (!columns.has(key)) columns.set(key, { x: section.x, z: section.z, sections: [] }); columns.get(key).sections.push({ sectionY: section.sectionY, blocks: section.blocks, ...(section.biomes ? { biomes: section.biomes } : {}) }); }
    return [...columns.values()];
  }
  async start() { const result = await this.request('start'); this.tickGate = false; return result; }
  async pause() {
    // Worker messages are ordered: queued ticks still belong to this world,
    // and the pause acknowledgment follows the worker stopping its timer.
    const result = await this.request('pause'); this.tickGate = true; return result;
  }
  async save() { return (await this.request('save')).value; }
  async close({ save = true } = {}) { if (this.closed || this.closing) return; this.closing = true; this.tickGate = true; try { await this.request('close', { save }); } finally { this.destroy(); } }
  destroy(error = new Error('Browser authority is closed.')) {
    if (this.closed) return;
    this.closed = true; this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.pendingBytes = 0;
  }
}
