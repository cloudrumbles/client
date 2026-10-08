import { IRRADIANCE_LIMITS, irradianceMaterials } from './irradiance.js';

const keyOf = (x, z) => `${x},${z}`;
const sectionIndex = (x, y, z) => ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
const equal = (left, right) => Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
const copyLight = values => {
  if (values === undefined || values === null) return null;
  if (!(values instanceof Uint8Array) || values.length !== 2048) throw new Error('Irradiance requires packed native light nibbles.');
  return values.slice();
};
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** A copied near-band mirror, not a second unbounded world. Call update with
 * BrowserWorld.columns when the snapped band changes so it can refill only
 * intersecting source sections. All other frames do a constant-size key check. */
export class CachedIrradiance {
  constructor({ onVolume = () => {}, onStatus = () => {}, workerFactory = () => new Worker(new URL('./irradiance.worker.js', import.meta.url), { type: 'module' }), schedule = callback => setTimeout(callback, 60), cancelSchedule = timer => clearTimeout(timer) } = {}) {
    Object.assign(this, { onVolume, onStatus, workerFactory, schedule, cancelSchedule });
    this.columns = new Map(); this.generation = 0; this.revision = 0; this.sequence = 0; this.sunBucket = 0;
    this.metrics = { jobs: 0, discardedJobs: 0, reusedFrames: 0, invalidations: 0, localCacheHits: 0, sunCacheHits: 0, diskCacheHits: 0, prefetchedSunCacheHits: 0, sunCacheEntries: 0, sunCacheBytes: 0, residentCacheBytes: 0, volumeUploads: 0, sourceBytes: 0, outputBytes: 0, lastWorkerMs: null, lastDiskReadMs: null };
  }
  configure({ materials, atlas = null, minY = -64, height = 384, hasSkylight = true, generation = this.generation + 1, persistentCache = true }) {
    if (!Number.isSafeInteger(minY) || !Number.isInteger(height) || height < 16 || height > 1024 || !Number.isSafeInteger(minY + height) || !Number.isSafeInteger(generation)) throw new Error('Invalid irradiance world bounds.');
    const tables = irradianceMaterials(materials, atlas);
    this.clear(); this.worker?.terminate(); this.worker = null;
    Object.assign(this, { minY, height, hasSkylight: Boolean(hasSkylight), generation, tables, failed: false });
    try {
      const worker = this.workerFactory();
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.destroyed || this.worker !== worker || data.generation !== this.generation) return;
        const job = this.inFlight;
        if (!job || data.id !== job.id) return;
        this.inFlight = null;
        if (data.type === 'irradiance-error') { this.fail(data.error); return; }
        if (data.type !== 'irradiance-result') { this.fail('Unknown irradiance result.'); return; }
        if (job.key !== this.currentKey() || data.key !== job.key) this.metrics.discardedJobs++;
        else {
          const cells = this.dimensions.reduce((a, b) => a * b, 1);
          if (!(data.localData instanceof Uint16Array) || !(data.bounceData instanceof Uint16Array) || data.localData.length !== cells * 4 || data.bounceData.length !== cells * 4 || !equal(data.origin, this.origin) || !equal(data.dimensions, this.dimensions)) { this.fail('Malformed irradiance result.'); return; }
          this.completedKey = job.key; this.metrics.jobs++; this.metrics.volumeUploads++;
          this.metrics.localCacheHits += Number(Boolean(data.stats?.localCacheHit));
          this.metrics.sunCacheHits += Number(Boolean(data.stats?.sunCacheHit));
          this.metrics.diskCacheHits += Number(Boolean(data.stats?.diskCacheHit));
          this.metrics.prefetchedSunCacheHits += Number(Boolean(data.stats?.prefetchedSunCacheHit));
          this.metrics.sunCacheEntries = data.stats?.sunCacheEntries ?? 0;
          this.metrics.sunCacheBytes = data.stats?.sunCacheBytes ?? 0;
          this.metrics.residentCacheBytes = data.stats?.residentCacheBytes ?? 0;
          this.metrics.lastDiskReadMs = data.stats?.diskReadMs ?? null;
          this.metrics.lastWorkerMs = data.stats?.workerMs ?? null;
          this.metrics.outputBytes = data.localData.byteLength + data.bounceData.byteLength;
          this.onVolume(data);
        }
        this.queue();
      };
      worker.onerror = event => { if (this.worker === worker) this.fail(event.message ?? 'Irradiance worker stopped.'); };
      worker.postMessage({ type: 'init', generation, tables, persistentCache: Boolean(persistentCache) });
    } catch (error) { this.fail(error.message); }
  }
  fail(message) {
    this.failed = true; this.cancelSchedule(this.timer); this.timer = null;
    this.inFlight = null; this.worker?.terminate(); this.worker = null; this.metrics.outputBytes = 0; this.metrics.sunCacheEntries = this.metrics.sunCacheBytes = this.metrics.residentCacheBytes = 0;
    this.onVolume(null); this.onStatus(`Cached colored lighting unavailable: ${message}`);
  }
  clear() {
    this.cancelSchedule(this.timer); this.timer = null; this.inFlight = null;
    this.columns.clear(); this.origin = null; this.dimensions = null; this.completedKey = null;
    this.revision++; this.metrics.sourceBytes = 0; this.metrics.outputBytes = 0; this.metrics.sunCacheEntries = this.metrics.sunCacheBytes = this.metrics.residentCacheBytes = 0; this.onVolume(null);
  }
  currentKey() { return this.origin ? `${this.generation}:${this.origin.join(',')}:${this.dimensions.join(',')}:${this.revision}:${this.sunBucket}:${Number(this.hasSkylight)}` : null; }
  changed({ geometry = true } = {}) {
    if (geometry) {
      this.revision++; this.metrics.invalidations++;
      if (this.completedKey) { this.completedKey = null; this.metrics.outputBytes = 0; this.onVolume(null); }
    }
    this.queue();
  }
  intersects(x, z) {
    return this.origin && x * 16 < this.origin[0] + this.dimensions[0] && x * 16 + 16 > this.origin[0] && z * 16 < this.origin[2] + this.dimensions[2] && z * 16 + 16 > this.origin[2];
  }
  recountBytes() {
    this.metrics.sourceBytes = [...this.columns.values()].reduce((total, column) => total + [...column.sections.values()].reduce((sum, section) => sum + section.blocks.byteLength + (section.sky?.byteLength ?? 0) + (section.block?.byteLength ?? 0), 0), 0);
  }
  setColumn(column, { notify = true } = {}) {
    if (!Number.isSafeInteger(column?.x) || !Number.isSafeInteger(column?.z) || !Array.isArray(column?.sections) || column.sections.length > 64) throw new Error('Invalid irradiance source column.');
    if (!this.intersects(column.x, column.z)) return false;
    const key = keyOf(column.x, column.z), first = Math.floor(this.origin[1] / 16), last = Math.floor((this.origin[1] + this.dimensions[1] - 1) / 16);
    const sections = new Map();
    for (const source of column.sections) {
      const sy = source.sectionY;
      if (!Number.isInteger(sy)) throw new Error('Invalid irradiance source section Y.');
      if (sy < first || sy > last) continue;
      if (!(source.blocks instanceof Uint16Array) || source.blocks.length !== 4096 || sections.has(sy)) throw new Error('Invalid irradiance source blocks.');
      sections.set(sy, { blocks: source.blocks.slice(), sky: copyLight(column.light?.sky?.get(sy) ?? source.skyLight), block: copyLight(column.light?.block?.get(sy) ?? source.blockLight) });
    }
    // Empty native sections can still have explicit light arrays.
    for (let sy = first; sy <= last; sy++) {
      if (sections.has(sy)) continue;
      const sky = column.light?.sky?.get(sy), block = column.light?.block?.get(sy);
      if (sky || block) sections.set(sy, { blocks: new Uint16Array(4096), sky: copyLight(sky), block: copyLight(block) });
    }
    if (sections.size > IRRADIANCE_LIMITS.maxSections || (!this.columns.has(key) && this.columns.size >= IRRADIANCE_LIMITS.maxColumns)) throw new Error('Irradiance source mirror exceeds its fixed budget.');
    const previous = this.columns.get(key);
    const identical = previous && previous.sections.size === sections.size && [...sections].every(([sy, section]) => { const old = previous.sections.get(sy); return old && equal(section.blocks, old.blocks) && (section.sky === null && old.sky === null || equal(section.sky, old.sky)) && (section.block === null && old.block === null || equal(section.block, old.block)); });
    if (identical) return false;
    this.columns.set(key, { x: column.x, z: column.z, sections }); this.recountBytes();
    if (notify) this.changed();
    return true;
  }
  removeColumn(x, z) {
    if (!this.columns.delete(keyOf(x, z))) return false;
    this.recountBytes(); this.changed(); return true;
  }
  setBlock(x, y, z, id) {
    if (![x, y, z, id].every(Number.isInteger) || id < 0 || id > 65535) return false;
    const column = this.columns.get(keyOf(Math.floor(x / 16), Math.floor(z / 16))), sy = Math.floor(y / 16);
    if (!column || y < this.origin[1] || y >= this.origin[1] + this.dimensions[1]) return false;
    let section = column.sections.get(sy);
    if (!section) { section = { blocks: new Uint16Array(4096), sky: null, block: null }; column.sections.set(sy, section); this.recountBytes(); }
    const index = sectionIndex(x, y, z);
    if (section.blocks[index] === id) return false;
    section.blocks[index] = id; this.changed(); return true;
  }
  setLight(x, z, light) {
    const column = this.columns.get(keyOf(x, z));
    if (!column || !light) return false;
    const first = Math.floor(this.origin[1] / 16), last = Math.floor((this.origin[1] + this.dimensions[1] - 1) / 16);
    let changed = false;
    for (const kind of ['sky', 'block']) for (const [sy, values] of light[kind] ?? []) {
      if (!Number.isInteger(sy)) throw new Error('Invalid irradiance light section Y.');
      if (sy < first || sy > last) continue;
      let section = column.sections.get(sy);
      if (!section) { section = { blocks: new Uint16Array(4096), sky: null, block: null }; column.sections.set(sy, section); }
      if (equal(section[kind], values)) continue;
      section[kind] = copyLight(values); changed = true;
    }
    if (changed) { this.recountBytes(); this.changed(); }
    return changed;
  }
  update({ eye, dayPhase = .22, columns = null }) {
    if (this.destroyed || !this.tables || this.failed) return;
    if (!Array.isArray(eye) || eye.length !== 3 || !eye.every(Number.isFinite) || !Number.isFinite(dayPhase)) throw new Error('Invalid irradiance camera.');
    const dimensions = [48, Math.min(32, this.height), 48];
    const origin = [Math.floor(eye[0] / 8) * 8 - 24, clamp(Math.floor(eye[1] / 8) * 8 - Math.floor(dimensions[1] / 2), this.minY, this.minY + this.height - dimensions[1]), Math.floor(eye[2] / 8) * 8 - 24];
    if (!origin.every(Number.isSafeInteger)) throw new Error('Irradiance camera exceeds safe coordinates.');
    const normalizedPhase = (dayPhase % 1 + 1) % 1, bucket = Math.floor(normalizedPhase * IRRADIANCE_LIMITS.sunBuckets) % IRRADIANCE_LIMITS.sunBuckets;
    const moved = !equal(origin, this.origin), sunChanged = bucket !== this.sunBucket;
    this.sunBucket = this.hasSkylight ? bucket : 0;
    if (moved) {
      this.origin = origin; this.dimensions = dimensions; this.columns.clear();
      if (columns instanceof Map) {
        const firstX = Math.floor(origin[0] / 16), lastX = Math.floor((origin[0] + dimensions[0] - 1) / 16);
        const firstZ = Math.floor(origin[2] / 16), lastZ = Math.floor((origin[2] + dimensions[2] - 1) / 16);
        for (let z = firstZ; z <= lastZ; z++) for (let x = firstX; x <= lastX; x++) {
          const column = columns.get(keyOf(x, z));
          if (column) this.setColumn(column, { notify: false });
        }
      }
      this.recountBytes(); this.changed();
    } else if (sunChanged && this.hasSkylight) this.changed({ geometry: false });
    else this.metrics.reusedFrames++;
    this.queue();
  }
  snapshot() {
    const [width, height, depth] = this.dimensions, cells = width * height * depth;
    const states = new Uint16Array(cells), known = new Uint8Array(cells), sky = new Uint8Array(cells), block = new Uint8Array(cells);
    for (let z = 0; z < depth; z++) for (let x = 0; x < width; x++) {
      const wx = this.origin[0] + x, wz = this.origin[2] + z, column = this.columns.get(keyOf(Math.floor(wx / 16), Math.floor(wz / 16)));
      if (!column) continue;
      for (let y = 0; y < height; y++) {
        const wy = this.origin[1] + y, target = (z * height + y) * width + x, source = sectionIndex(wx, wy, wz), section = column.sections.get(Math.floor(wy / 16));
        known[target] = 1;
        if (!section) continue;
        states[target] = section.blocks[source];
        if (section.sky) sky[target] = section.sky[source >>> 1] >>> ((source & 1) * 4) & 15;
        if (section.block) block[target] = section.block[source >>> 1] >>> ((source & 1) * 4) & 15;
      }
    }
    return { origin: [...this.origin], dimensions: [...this.dimensions], states, known, sky, block, sunBucket: this.sunBucket, hasSkylight: this.hasSkylight };
  }
  queue() {
    if (this.destroyed || this.failed || !this.worker || !this.origin || this.timer || this.inFlight || this.completedKey === this.currentKey()) return;
    this.timer = this.schedule(() => { this.timer = null; this.submit(); });
  }
  submit() {
    if (!this.worker || !this.origin || this.inFlight || this.completedKey === this.currentKey()) return;
    const snapshot = this.snapshot(), job = { id: ++this.sequence, key: this.currentKey() };
    this.inFlight = job;
    try { this.worker.postMessage({ type: 'solve', generation: this.generation, ...job, snapshot }, [snapshot.states.buffer, snapshot.known.buffer, snapshot.sky.buffer, snapshot.block.buffer]); }
    catch (error) { this.fail(error.message); }
  }
  stats() {
    return { ...this.metrics, enabled: Boolean(this.worker), busy: Boolean(this.inFlight), pending: Boolean(this.timer), sourceColumns: this.columns.size,
      materialBytes: this.tables ? IRRADIANCE_LIMITS.materialBytes : 0, snapshotBytes: this.dimensions ? this.dimensions.reduce((a, b) => a * b, 1) * 5 : 0,
      maxSourceBytes: IRRADIANCE_LIMITS.maxColumns * IRRADIANCE_LIMITS.maxSections * 12288,
      dimensions: this.dimensions ? [...this.dimensions] : null, origin: this.origin ? [...this.origin] : null, sunBucket: this.sunBucket };
  }
  destroy() { this.destroyed = true; this.clear(); this.worker?.terminate(); this.worker = null; this.tables = null; }
}
