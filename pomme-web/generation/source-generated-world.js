import { SourceGenerationWorker } from './source-generation.js';

const columnKey = (x, z) => `${x},${z}`;
const cancelled = () => new DOMException('Generated world changed.', 'AbortError');

/** Persists native generated columns before admitting them to the existing world and lighting workers. */
export class SourceGeneratedWorld {
  constructor({ world, context, registry, maximumRequests = 4, workerFactory, onProgress, onError = () => {} }) {
    if (!world?.store || world.mode !== 'import' || world.worldKey !== context?.worldKey) throw new Error('Generated terrain requires a matching persistent local world.');
    Object.assign(this, { world, context: { ...context }, epoch: world.generation, maximumRequests, onError, pending: new Map(), closed: false });
    this.generator = new SourceGenerationWorker({ maximumRequests, workerFactory, onProgress });
    this.generator.configure(context, registry);
  }
  isCurrent() { return !this.closed && !this.world.destroyed && this.world.generation === this.epoch && this.world.worldKey === this.context.worldKey; }
  ensureColumn(x, z) {
    if (!this.isCurrent()) return Promise.reject(cancelled());
    if (!Number.isInteger(x) || !Number.isInteger(z) || x < -1875000 || x >= 1875000 || z < -1875000 || z >= 1875000) return Promise.reject(new Error('Invalid generated-world chunk.'));
    const key = columnKey(x, z);
    if (this.pending.has(key)) return this.pending.get(key).promise;
    if (this.pending.size >= this.maximumRequests) return Promise.reject(new Error('Generated world request queue is full.'));
    const abort = new AbortController();
    const entry = { abort, promise: null };
    entry.promise = this.loadColumn(x, z, abort.signal).then(column => { this.failure = null; return column; }, error => { if (error.name !== 'AbortError') this.failure = error; throw error; })
      .finally(() => { if (this.pending.get(key) === entry) this.pending.delete(key); });
    this.pending.set(key, entry);
    return entry.promise;
  }
  async loadColumn(x, z, signal) {
    const resident = this.world.columns.get(columnKey(x, z));
    if (resident) return resident;
    const store = this.world.store;
    const saved = await store.get(x, z);
    if (!this.isCurrent()) throw cancelled();
    if (saved) {
      if (this.world.contains(x, z)) this.world.ingestColumn(saved);
      return saved;
    }
    const generated = await this.generator.request({ x, z, signal });
    if (!this.isCurrent()) throw cancelled();
    const column = { x, z, sections: generated.sections.map(section => ({ sectionY: section.sectionY, blocks: section.states, biomes: section.biomes })) };
    this.world.applyOverlay(column);
    await store.put(column);
    if (!this.isCurrent()) throw cancelled();
    if (this.world.contains(x, z)) this.world.ingestColumn(column);
    return column;
  }
  updateCamera(eye, radius = 2) {
    if (!this.isCurrent() || this.failure || !Number.isInteger(radius) || radius < 0 || radius > 4) return;
    const centerX = Math.floor(eye[0] / 16), centerZ = Math.floor(eye[2] / 16), nearby = [];
    if (!Number.isInteger(centerX) || !Number.isInteger(centerZ)) return;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      const x = centerX + dx, z = centerZ + dz;
      if (x < -1875000 || x >= 1875000 || z < -1875000 || z >= 1875000 || !this.world.contains(x, z)) continue;
      if (!this.world.columns.has(columnKey(x, z)) && !this.pending.has(columnKey(x, z))) nearby.push({ x, z, distance: dx * dx + dz * dz });
    }
    nearby.sort((a, b) => a.distance - b.distance || a.z - b.z || a.x - b.x);
    for (const { x, z } of nearby.slice(0, this.maximumRequests - this.pending.size)) {
      this.ensureColumn(x, z).catch(error => { if (this.isCurrent() && error.name !== 'AbortError') this.onError(error); });
    }
  }
  close() {
    this.closed = true;
    for (const entry of this.pending.values()) entry.abort.abort();
    this.generator.close();
  }
}
