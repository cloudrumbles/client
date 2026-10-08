import { mapSourceRegistry, mapGeneratedColumn, SOURCE_VERSION } from './source-generation-mapping.js';
const DIMENSIONS = new Map([['minecraft:overworld', 0], ['minecraft:the_nether', 1], ['minecraft:the_end', 2]]);
const aborted = message => new DOMException(message, 'AbortError');
function contextFor(context) {
  if (!context || typeof context.seed === 'string' && context.seed.length > 21) throw new Error('Invalid source generation world context.');
  if (!(typeof context.seed === 'bigint' || typeof context.seed === 'string' && /^-?\d+$/.test(context.seed) || typeof context.seed === 'number' && Number.isSafeInteger(context.seed))) throw new Error('Generation requires an exact signed 64-bit seed.');
  const seed = BigInt(context.seed);
  if (seed < -9223372036854775808n || seed > 9223372036854775807n || !DIMENSIONS.has(context.dimension) || typeof context.worldKey !== 'string' || !context.worldKey || context.worldKey.length > 1024 || context.version !== SOURCE_VERSION) throw new Error('Invalid source generation world context.');
  return Object.freeze({ worldKey: context.worldKey, seed: String(seed), dimension: context.dimension, version: context.version });
}
/** Dedicated source generation worker. A running indivisible native phase is cancelled by termination. */
export class SourceGenerationWorker {
  constructor({ workerFactory = () => new Worker(new URL('./source-generation.worker.js', import.meta.url), { type: 'module' }), maximumRequests = 8, budgetMs = 12, onProgress = () => {} } = {}) {
    if (!Number.isInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > 64 || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Invalid generation worker budget.');
    Object.assign(this, { workerFactory, maximumRequests, budgetMs, onProgress, queue: [], active: null, worker: null, context: null, registry: null, mapping: null, epoch: 0, nextId: 1, closed: false });
  }
  configure(context, registry) {
    if (this.closed) throw new Error('Source generation worker is closed.');
    const next = contextFor(context);
    if (registry?.version !== next.version) throw new Error('Source generation registry does not match the world.');
    if (this.worker && this.context && this.registry === registry && Object.keys(next).every(key => this.context[key] === next[key]) && !this.failure) return;
    this.abortAll('Generation world changed.'); this.context = next; this.registry = registry;
    if (!this.start()) throw this.failure;
  }
  start() {
    this.mapping = null; this.failure = null;
    let worker;
    try { worker = this.workerFactory(); }
    catch (error) { this.failAll(error); return false; }
    const epoch = this.epoch; this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (worker !== this.worker || epoch !== this.epoch) return;
      if (data.type === 'ready') {
        try { this.mapping = mapSourceRegistry(data.manifest, this.registry); this.pump(); }
        catch (error) { this.failAll(error); }
        return;
      }
      const job = this.active;
      if (!job || data.id !== job.id || data.epoch !== this.epoch || data.worldKey !== this.context.worldKey || data.seed !== this.context.seed || data.dimension !== DIMENSIONS.get(this.context.dimension)) return;
      if (data.type === 'progress') { try { this.onProgress({ ...data, context: this.context }); } catch {} return; }
      if (data.type === 'error' && data.fatal) { this.failAll(new Error(data.message)); return; }
      if (data.type === 'column' || data.type === 'error') {
        this.active = null; job.cleanup();
        try { if (data.type === 'error') throw new Error(data.message);
          if (data.x !== job.x || data.z !== job.z || data.stage !== job.stage) throw new Error('Native generation returned a different column.');
          job.resolve({ ...mapGeneratedColumn(data, this.mapping), context: this.context, durations: data.durations }); }
        catch (error) { job.reject(error); }
        this.pump();
      }
    };
    worker.onerror = event => { if (worker === this.worker && epoch === this.epoch) this.failAll(new Error(event.message || 'Source generation worker failed.')); };
    return true;
  }
  request({ x, z, stage = 'surface', signal } = {}) {
    if (this.closed || !this.context) return Promise.reject(new Error('No source generation world is configured.'));
    if (this.failure) return Promise.reject(this.failure);
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < -1875000 || x >= 1875000 || z < -1875000 || z >= 1875000 || !['noise', 'surface'].includes(stage)) return Promise.reject(new Error('Invalid source generation chunk.'));
    if (signal?.aborted) return Promise.reject(aborted('Generation request was cancelled.'));
    if (this.queue.length + Number(!!this.active) >= this.maximumRequests) return Promise.reject(new Error('Source generation request queue is full.'));
    return new Promise((resolve, reject) => {
      const job = { id: this.nextId++, x, z, stage, resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        if (this.active === job) {
          this.active = null; job.cleanup(); job.reject(aborted('Generation request was cancelled.')); this.worker?.terminate(); this.worker = null; this.epoch++; this.start();
        } else { const index = this.queue.indexOf(job); if (index >= 0) { this.queue.splice(index, 1); job.cleanup(); job.reject(aborted('Generation request was cancelled.')); } }
      };
      signal?.addEventListener('abort', cancel, { once: true }); this.queue.push(job); this.pump();
    });
  }
  pump() {
    if (!this.worker || !this.mapping || this.active || !this.queue.length) return;
    const job = this.queue.shift(); this.active = job;
    try { this.worker.postMessage({ type: 'generate', ...this.context, dimension: DIMENSIONS.get(this.context.dimension), id: job.id, epoch: this.epoch, x: job.x, z: job.z, stage: job.stage, budgetMs: this.budgetMs }); }
    catch (error) { this.failAll(error); }
  }
  abortAll(message = 'Generation requests were cancelled.') {
    this.epoch++; this.worker?.terminate(); this.worker = null; this.mapping = null;
    for (const job of [...(this.active ? [this.active] : []), ...this.queue]) { job.cleanup(); job.reject(aborted(message)); }
    this.active = null; this.queue = [];
  }
  failAll(error) {
    this.failure = error;
    for (const job of [...(this.active ? [this.active] : []), ...this.queue]) { job.cleanup(); job.reject(error); }
    this.active = null; this.queue = []; this.worker?.terminate(); this.worker = null; this.mapping = null;
  }
  close() { this.abortAll('Source generation worker closed.'); this.closed = true; this.context = null; this.registry = null; }
}
