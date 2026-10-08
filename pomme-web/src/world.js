import { MaterialRegistry } from './registry.js';
import { DistantTerrain } from './distant.js';
import { ChunkStore } from './chunk-store.js';
import { createBiomeTints, applyBiomeTints, setBiomeSeed, tintComponents } from './biome-tints.js';
import { CachedIrradiance } from './irradiance-cache.js';

const keyOf = (x, z) => `${x},${z}`;
const idsIn = blocks => new Set(blocks);

/** Owns the authoritative near-world WASM and its worker mirror. */
export class BrowserWorld {
  constructor({ core, renderer, onReady = () => {}, onError = () => {}, onMesh = () => {}, onStatus = () => {}, onColumn = () => {}, onBlock = () => {}, onUnload = () => {} }) {
    Object.assign(this, { core, renderer, onReady, onError, onMesh, onStatus, onColumn, onBlock, onUnload });
    this.generation = 0;
    this.keys = new Set();
    this.nearReady = new Set();
    this.columns = new Map();
    this.sentModels = new Set();
    this.overlays = new Map();
    this.sourceRevisions = new Map();
    this.sourceRevision = 0;
    this.lightingDirty = new Set();
    this.lightingSequence = 0;
    this.lightingMetrics = { jobs: 0, discardedJobs: 0, cacheHits: 0, lastJobMs: null, lastWorkerMs: null, solvedColumns: 0 };
    this.mode = 'demo';
    if (renderer.setIrradianceVolume) this.irradiance = new CachedIrradiance({
      onVolume: volume => { if (!this.destroyed) { try { this.renderer.setIrradianceVolume(volume); } catch (error) { this.onError(error); } } }, onStatus,
    });
    this.worker = new Worker(new URL('./world.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.generation !== this.generation) return;
      if (data.type === 'mesh') {
        const [cx, cz] = data.index.split(',').map(Number);
        if (!this.contains(cx, cz)) return;
        try {
          this.renderer.uploadChunk(data.index, data.opaque, data.water, data.bounds, { stride: data.stride, origin: data.origin });
          this.keys.add(data.index); this.onMesh(data);
          const wasReady = this.nearReady.has(data.index), loaded = Boolean(this.core.world_column_loaded(cx, cz));
          if (loaded) this.nearReady.add(data.index); else this.nearReady.delete(data.index);
          if (loaded !== wasReady) this.updateNearColumns();
        } catch (error) { this.onError(error); }
      } else if (data.type === 'ready') this.onReady();
      else if (data.type === 'error') this.onError(new Error(data.message));
    };
    this.worker.onerror = event => this.onError(new Error(event.message));
  }
  post(message, transfer = []) { this.worker.postMessage({ ...message, generation: this.generation }, transfer); }
  initDemo(seed, edits) { this.post({ type: 'init', seed, edits }); }
  bounds() {
    const c = this.core;
    return { min: [c.world_origin_x(), c.world_min_y(), c.world_origin_z()], max: [c.world_origin_x() + c.world_width(), c.world_min_y() + c.world_height(), c.world_origin_z() + c.world_depth()] };
  }
  contains(cx, cz) {
    const { min, max } = this.bounds();
    return cx * 16 >= min[0] && cz * 16 >= min[2] && cx * 16 < max[0] && cz * 16 < max[2];
  }
  async reset({ registry, materials, minY = -64, height = 384, originX = -8, originZ = -8, width = 16, depth = 16, worldKey, mode = 'import', hasSkylight = true, colormaps = null, biomeDefinitions = null, biomeBlendRadius = 2, biomeSeed = 0n, atlas = null }) {
    this.generation++;
    this.irradiance?.clear();
    this.stopLocalLighting();
    await this.flushImportColumn();
    await this.store?.close(); this.store = null;
    await this.distant?.close();
    this.distant = null;
    for (const key of this.keys) this.renderer.removeChunk(key);
    this.keys.clear(); this.nearReady.clear(); this.columns.clear(); this.sentModels.clear(); this.overlays.clear();
    this.sourceRevisions.clear(); this.sourceRevision = 0;
    this.importingSections = false;
    this.mode = mode; this.registry = registry; this.worldKey = worldKey; this.hasSkylight = hasSkylight;
    this.materialRegistry = new MaterialRegistry(registry, materials);
    this.irradiance?.configure({ materials: this.materialRegistry.materials, atlas, minY, height, hasSkylight, generation: this.generation });
    if (!this.core.world_reset(minY, height, originX, originZ, width, depth)) throw new Error('Unsupported Minecraft dimension bounds.');
    this.materialRegistry.register(this.core);
    this.biomeConfiguration = createBiomeTints(registry, colormaps, biomeDefinitions);
    this.biomeBlendRadius = biomeBlendRadius; this.biomeSeed = BigInt(biomeSeed ?? 0);
    applyBiomeTints(this.core, this.biomeConfiguration, { blendRadius: biomeBlendRadius, seed: this.biomeSeed });
    this.core.world_set_skylight_default?.(hasSkylight ? 15 : 0);
    this.core.world_set_floor_collision?.(mode === 'server' ? 0 : 1);
    this.renderer.configureWorld({ ...this.bounds(), farPlane: 2048, hasSkylight });
    this.post({ type: 'reset', minY, height, originX, originZ, width, depth, hasSkylight, floorCollision: mode !== 'server', materials: this.materialRegistry.configuration(), biomeConfiguration: this.biomeConfiguration, biomeBlendRadius, biomeSeed: this.biomeSeed });
    this.distant = new DistantTerrain({
      worldKey, minY, height, materials: this.materialRegistry.materials, regionBatchSize: 4, biomeConfiguration: this.biomeConfiguration, biomeSeed: this.biomeSeed, biomeBlendRadius,
      onMesh: mesh => { this.renderer.uploadChunk(mesh.key, mesh.opaque, mesh.water, mesh.bounds, { stride: mesh.stride, origin: mesh.origin }); this.onMesh(mesh); },
      onRemove: key => this.renderer.removeChunk(key), onStatus: this.onStatus,
    });
    await this.distant.init();
    if (mode === 'import') {
      this.store = new ChunkStore({ worldKey, registryVersion: registry?.version?.minecraftVersion ?? '1.20.4', onStatus: this.onStatus }); await this.store.init();
      this.startLocalLighting();
    }
    this.updateNearColumns();
  }
  background(promise) { promise?.catch(error => { if (!this.destroyed) this.onStatus(error.message); }); }
  sourceChanged(column) {
    column.revision = ++this.sourceRevision;
    this.sourceRevisions.set(keyOf(column.x, column.z), column.revision);
  }
  startLocalLighting() {
    if (this.mode !== 'import' || this.destroyed) return;
    this.stopLocalLighting();
    const generation = this.generation;
    try {
      const worker = new Worker(new URL('./lighting.worker.js', import.meta.url), { type: 'module' });
      this.lightingWorker = worker;
      worker.onmessage = ({ data }) => {
        if (this.destroyed || this.lightingWorker !== worker || data.generation !== generation || generation !== this.generation) return;
        const job = this.lightingInFlight;
        if (!job || data.id !== job.id) return;
        this.lightingInFlight = null;
        if (data.type === 'light-error') { this.stopLocalLighting(); this.onStatus(`Local lighting stopped: ${data.error}`); return; }
        if (data.type !== 'light-result') return;
        if (job.revision !== this.sourceRevision) {
          this.lightingMetrics.discardedJobs++;
          for (const key of job.targets) this.lightingDirty.add(key);
        } else {
          this.lightingMetrics.jobs++;
          this.lightingMetrics.lastJobMs = performance.now() - job.started;
          this.lightingMetrics.lastWorkerMs = data.elapsedMs;
          this.lightingMetrics.cacheHits += data.cacheHits ?? 0;
          this.lightingMetrics.solvedColumns += data.results.length;
          for (const result of data.results) {
            const key = keyOf(result.x, result.z), column = this.columns.get(key) ?? job.columns.get(key);
            if (column) this.loadLight(result.x, result.z, result, { persist: true, column });
          }
        }
        this.scheduleLighting();
      };
      worker.onerror = event => {
        if (this.lightingWorker !== worker) return;
        this.stopLocalLighting(); this.onStatus(`Local lighting stopped: ${event.message}`);
      };
      const opacityById = new Map();
      for (const block of this.registry.blocks) for (let id = block.minStateId; id <= block.maxStateId; id++) opacityById.set(id, block.filterLight);
      worker.postMessage({ type: 'init', generation, materials: [...this.materialRegistry.materials].map(([id, material]) => [id, {
        flags: material.flags, opacity: material.opacity, filterLight: material.filterLight ?? opacityById.get(id), emitLight: material.emitLight,
      }]) });
    } catch (error) { this.stopLocalLighting(); this.onStatus(`Local lighting unavailable: ${error.message}`); }
  }
  stopLocalLighting() {
    clearTimeout(this.lightingTimer); this.lightingTimer = null;
    this.lightingWorker?.terminate(); this.lightingWorker = null;
    this.lightingInFlight = null; this.lightingDirty.clear();
  }
  dirtyLighting(cx, cz) {
    if (!this.lightingWorker || this.mode !== 'import') return;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) this.lightingDirty.add(keyOf(cx + dx, cz + dz));
    this.scheduleLighting();
  }
  queueMissingLighting() {
    if (!this.lightingWorker || this.mode !== 'import' || this.importingSections) return;
    for (const [key, column] of this.columns) {
      const provided = (column.light?.sky?.size ?? 0) + (column.light?.block?.size ?? 0)
        || column.sections.some(section => section.skyLight || section.blockLight);
      if (!provided && this.contains(column.x, column.z)) this.lightingDirty.add(key);
    }
    this.scheduleLighting();
  }
  scheduleLighting() {
    if (!this.lightingWorker || this.importingSections || this.lightingInFlight || !this.lightingDirty.size || this.lightingTimer) return;
    this.lightingTimer = setTimeout(() => {
      this.lightingTimer = null;
      this.background(this.runLighting());
    }, 100);
  }
  async runLighting() {
    if (!this.lightingWorker || this.lightingInFlight || !this.lightingDirty.size || this.destroyed) return;
    const worker = this.lightingWorker, generation = this.generation;
    const targets = [...this.lightingDirty].slice(0, 9);
    for (const key of targets) this.lightingDirty.delete(key);
    const job = { id: ++this.lightingSequence, revision: this.sourceRevision, targets, columns: new Map(), started: performance.now() };
    this.lightingInFlight = job;
    try {
      const sourceKeys = new Set();
      for (const key of targets) {
        const [cx, cz] = key.split(',').map(Number);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) sourceKeys.add(keyOf(cx + dx, cz + dz));
      }
      const catalog = new Set(this.store?.keys() ?? []);
      await Promise.all([...sourceKeys].map(async key => {
        const [cx, cz] = key.split(',').map(Number);
        const column = this.columns.get(key) ?? (catalog.has(key) ? await this.store.get(cx, cz) : null);
        if (column) job.columns.set(key, column);
      }));
      if (this.destroyed || generation !== this.generation || worker !== this.lightingWorker) return;
      if (job.revision !== this.sourceRevision) {
        this.lightingInFlight = null;
        for (const key of targets) this.lightingDirty.add(key);
        this.scheduleLighting(); return;
      }
      const knownTargets = targets.filter(key => job.columns.has(key));
      if (!knownTargets.length) { this.lightingInFlight = null; this.scheduleLighting(); return; }
      const neededKeys = new Set();
      for (const key of knownTargets) {
        const [cx, cz] = key.split(',').map(Number);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) neededKeys.add(keyOf(cx + dx, cz + dz));
      }
      const transfer = [];
      const columns = [...job.columns].filter(([key]) => neededKeys.has(key)).map(([key, column]) => ({ x: column.x, z: column.z, revision: this.sourceRevisions.get(key) ?? 0,
        sections: column.sections.map(section => {
          const blocks = section.blocks.slice(); transfer.push(blocks.buffer);
          return { sectionY: section.sectionY, blocks };
        }),
      }));
      worker.postMessage({ type: 'solve', generation, id: job.id, revision: job.revision, minY: this.core.world_min_y(), height: this.core.world_height(), hasSkylight: this.hasSkylight,
        targets: knownTargets, columns }, transfer);
    } catch (error) {
      if (this.lightingInFlight === job) { this.stopLocalLighting(); this.onStatus(`Local lighting stopped: ${error.message}`); }
    }
  }
  lightingStats() { return { ...this.lightingMetrics, pendingColumns: this.lightingDirty.size, busy: !!this.lightingInFlight, enabled: !!this.lightingWorker }; }
  updateNearColumns() {
    this.distant?.setNearColumns(new Set([...this.nearReady].filter(key => { const [x, z] = key.split(',').map(Number); return this.contains(x, z); })));
  }
  setOverlay(blocks) {
    this.overlays.clear();
    for (const block of blocks) this.rememberEdit(block);
  }
  rememberEdit(block) {
    const key = keyOf(Math.floor(block[0] / 16), Math.floor(block[2] / 16));
    let changes = this.overlays.get(key);
    if (!changes) this.overlays.set(key, changes = new Map());
    changes.set(block.slice(0, 3).join(','), block);
  }
  applyOverlay(column) {
    const changed = new Set();
    if (this.mode !== 'import') return changed;
    const changes = this.overlays.get(keyOf(column.x, column.z));
    for (const [x, y, z, id] of changes?.values() ?? []) {
      if (y < this.core.world_min_y() || y >= this.core.world_min_y() + this.core.world_height()) continue;
      let section = column.sections.find(s => s.sectionY === Math.floor(y / 16));
      if (!section) { if (id === 0) continue; section = { sectionY: Math.floor(y / 16), blocks: new Uint16Array(4096) }; column.sections.push(section); }
      const index = ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
      if (section.blocks[index] !== id) { section.blocks[index] = id; changed.add(section); }
    }
    return changed;
  }
  activate(blocks) {
    const ids = idsIn(blocks);
    this.materialRegistry?.activate(this.core, ids);
    const fresh = [...ids].filter(id => !this.sentModels.has(id));
    if (fresh.length) {
      this.post({ type: 'definitions', materials: this.materialRegistry.definitionsFor(fresh) });
      for (const id of fresh) this.sentModels.add(id);
    }
  }
  loadSection(cx, sy, cz, blocks, biomes = null) {
    if (!this.contains(cx, cz)) return;
    this.activate(blocks);
    const pointer = this.core.world_stage_ptr();
    new Uint16Array(this.core.memory.buffer, pointer, 4096).set(blocks);
    if (!this.core.world_load_section(cx, sy, cz, pointer, 4096)) throw new Error(`Invalid section ${cx},${sy},${cz}.`);
    const copied = blocks.slice();
    this.post({ type: 'section', x: cx, y: sy, z: cz, blocks: copied }, [copied.buffer]);
    if (biomes) this.loadSectionBiomes(cx, sy, cz, biomes);
  }
  ingestColumn(column) {
    const sections = column.sections.map(section => ({ ...section, sectionY: section.sectionY, blocks: section.blocks }));
    const stored = { x: column.x, z: column.z, sections, light: column.light, blockEntities: column.blockEntities, heightmaps: column.heightmaps };
    this.applyOverlay(stored);
    this.sourceChanged(stored);
    this.columns.set(keyOf(column.x, column.z), stored);
    for (const section of sections) {
      this.loadSection(column.x, section.sectionY, column.z, section.blocks, section.biomes);
      if (section.skyLight || section.blockLight) this.loadSectionLight(column.x, section.sectionY, column.z, section.skyLight, section.blockLight);
    }
    if (column.light) this.loadLight(column.x, column.z, column.light);
    this.updateNearColumns(); this.background(this.distant?.ingest(stored));
    this.queueMissingLighting();
    this.irradiance?.setColumn(stored);
    this.onColumn(stored);
  }
  async ingestSection({ cx, sy, cz, states, skyLight, blockLight, biomes }) {
    this.importingSections = true;
    const key = keyOf(cx, cz);
    if (this.importColumnKey && key !== this.importColumnKey) await this.flushImportColumn();
    this.importColumnKey = key;
    const column = this.columns.get(key) ?? { x: cx, z: cz, sections: [] };
    const at = column.sections.findIndex(s => s.sectionY === sy);
    const section = { sectionY: sy, blocks: states, skyLight, blockLight, biomes };
    if (at < 0) column.sections.push(section); else column.sections[at] = section;
    this.sourceChanged(column);
    this.columns.set(key, column); this.loadSection(cx, sy, cz, states, biomes);
    if (skyLight || blockLight) this.loadSectionLight(cx, sy, cz, skyLight, blockLight);
  }
  async flushImportColumn() {
    const key = this.importColumnKey;
    this.importColumnKey = null;
    const column = this.columns.get(key);
    if (!column) return;
    const overlaid = this.applyOverlay(column);
    if (overlaid.size) { this.sourceChanged(column); this.dirtyLighting(column.x, column.z); }
    for (const section of overlaid) if (this.contains(column.x, column.z)) this.loadSection(column.x, section.sectionY, column.z, section.blocks, section.biomes);
    await this.store?.put(column);
    await this.distant?.ingest(column);
    this.irradiance?.setColumn(column);
    if (!this.contains(column.x, column.z)) { this.columns.delete(key); this.sourceRevisions.delete(key); }
  }
  loadSectionBiomes(cx, sy, cz, biomes) {
    if (!this.contains(cx, cz) || !this.core.world_load_biomes) return;
    if (sy * 16 < this.core.world_min_y() || sy * 16 >= this.core.world_min_y() + this.core.world_height()) return;
    if (!(biomes instanceof Uint32Array) || biomes.length !== 64) throw new Error('Invalid Minecraft biome array.');
    const pointer = this.core.world_stage_ptr();
    new Uint32Array(this.core.memory.buffer, pointer, 64).set(biomes);
    if (!this.core.world_load_biomes(cx, sy, cz, pointer, 64)) throw new Error(`Invalid biome section ${cx},${sy},${cz}.`);
    const copied = biomes.slice();
    this.post({ type: 'biomes', x: cx, y: sy, z: cz, biomes: copied }, [copied.buffer]);
  }
  tintAt(x, y, z, kind) {
    return tintComponents(this.core.world_biome_tint?.(Math.floor(x), Math.floor(y), Math.floor(z), kind) ?? 0xffffff);
  }
  setBiomeSeed(seed) {
    this.biomeSeed = BigInt(seed ?? 0);
    setBiomeSeed(this.core, this.biomeSeed);
    this.post({ type: 'biome-seed', seed: this.biomeSeed });
    this.background(this.distant?.setBiomeSeed(this.biomeSeed));
  }
  loadSectionLight(cx, sy, cz, sky, block) {
    if (!this.contains(cx, cz) || !this.core.world_load_light) return;
    if (sy * 16 < this.core.world_min_y() || sy * 16 >= this.core.world_min_y() + this.core.world_height()) return;
    for (const values of [sky, block]) if (values && (!(values instanceof Uint8Array) || values.length !== 2048)) throw new Error('Invalid Minecraft lighting arrays');
    const ptr = this.core.world_stage_ptr();
    if (sky) new Uint8Array(this.core.memory.buffer, ptr, 2048).set(sky);
    if (block) new Uint8Array(this.core.memory.buffer, ptr + 2048, 2048).set(block);
    if (!this.core.world_load_light(cx, sy, cz, sky ? ptr : 0, block ? ptr + 2048 : 0, 2048)) throw new Error('Invalid Minecraft lighting arrays');
    this.post({ type: 'light', x: cx, y: sy, z: cz, sky, block });
  }
  loadLight(cx, cz, light, { persist = false, column = this.columns.get(keyOf(cx, cz)) } = {}) {
    if (column) {
      column.light ??= { sky: new Map(), block: new Map() };
      for (const kind of ['sky', 'block']) {
        column.light[kind] ??= new Map();
        for (const [sy, values] of light[kind]) column.light[kind].set(sy, values);
      }
    }
    for (const sy of new Set([...light.sky.keys(), ...light.block.keys()])) this.loadSectionLight(cx, sy, cz, light.sky.get(sy), light.block.get(sy));
    if (persist && column && this.store) this.background(this.store.put(column));
    this.irradiance?.setLight(cx, cz, light);
  }
  async finishImport() {
    await this.flushImportColumn();
    this.importingSections = false;
    this.updateNearColumns();
    await this.restoreNearColumns();
    this.queueMissingLighting();
  }
  async restoreNearColumns() {
    if (!this.store) return;
    const generation = this.generation, origin = `${this.core.world_origin_x()},${this.core.world_origin_z()}`;
    const missing = this.store.keys().filter(key => {
      const [x, z] = key.split(',').map(Number);
      return this.contains(x, z) && !this.columns.has(key);
    });
    for (let i = 0; i < missing.length; i += 8) {
      const columns = await Promise.all(missing.slice(i, i + 8).map(key => this.store.get(...key.split(',').map(Number))));
      if (this.destroyed || generation !== this.generation || origin !== `${this.core.world_origin_x()},${this.core.world_origin_z()}`) return;
      for (const column of columns) if (column) this.ingestColumn(column);
    }
    this.queueMissingLighting();
  }
  unload(cx, cz) {
    // Coarse terrain remains cached after a server unloads its near chunks.
    const key = keyOf(cx, cz);
    this.columns.delete(key); this.sourceRevisions.delete(key); this.sourceRevision++;
    this.irradiance?.removeColumn(cx, cz);
    this.core.world_unload_column(cx, cz);
    this.post({ type: 'unload', x: cx, z: cz });
    this.updateNearColumns();
    this.onUnload({ x: cx, z: cz });
  }
  setBlockEntity(entry) {
    const column = this.columns.get(keyOf(Math.floor(entry.x / 16), Math.floor(entry.z / 16)));
    if (!column || ![entry.x, entry.y, entry.z].every(Number.isInteger)) return false;
    const entries = column.blockEntities ??= [];
    const index = entries.findIndex(raw => {
      const local = raw.nbtData !== undefined;
      const x = local ? column.x * 16 + raw.x : raw.x ?? raw.nbt?.x;
      const z = local ? column.z * 16 + raw.z : raw.z ?? raw.nbt?.z;
      return x === entry.x && (raw.y ?? raw.nbt?.y) === entry.y && z === entry.z;
    });
    if (index >= 0) entries[index] = entry;
    else if (entries.length < 4096) entries.push(entry);
    else return false;
    if (this.store) this.background(this.store.put(column));
    return true;
  }
  setVisualOverride(x, y, z, id = null) {
    if (![x, y, z].every(Number.isInteger) || id !== null && (!Number.isInteger(id) || id < 0 || id > 65535)) return false;
    if (id !== null && this.materialRegistry) this.activate(new Uint16Array([id]));
    const state = id === null ? 0xffffffff : id;
    const changed = this.core.block_render_override(x, y, z, state);
    if (changed) this.post({ type: 'visual-override', block: [x, y, z, state] });
    return Boolean(changed);
  }
  setBlock(x, y, z, id) {
    if (![x, y, z, id].every(Number.isInteger) || [x, z].some(n => n < -2147483648 || n > 2147483647) || y < this.core.world_min_y() || y >= this.core.world_min_y() + this.core.world_height() || id < 0 || id > 65535 || (this.materialRegistry && !this.materialRegistry.materials.has(id))) return false;
    if (this.materialRegistry && this.contains(Math.floor(x / 16), Math.floor(z / 16))) this.activate(new Uint16Array([id]));
    const changed = this.core.block_set(x, y, z, id);
    if (changed) this.post({ type: 'edit', block: [x, y, z, id] });
    const column = this.columns.get(keyOf(Math.floor(x / 16), Math.floor(z / 16)));
    let section = column?.sections.find(s => s.sectionY === Math.floor(y / 16));
    if (column && !section) { section = { sectionY: Math.floor(y / 16), blocks: new Uint16Array(4096) }; column.sections.push(section); }
    let cachedChanged = false;
    if (section) {
      const index = ((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16);
      cachedChanged = section.blocks[index] !== id; section.blocks[index] = id;
    }
    if (column && (changed || cachedChanged)) this.sourceChanged(column);
    if (column && this.store) this.background(this.store.put(column));
    if (changed && this.mode === 'import') { this.rememberEdit([x, y, z, id]); this.dirtyLighting(Math.floor(x / 16), Math.floor(z / 16)); }
    this.background(this.distant?.updateBlock(x, y, z, id));
    if (changed || cachedChanged) { this.irradiance?.setBlock(x, y, z, id); this.onBlock({ x, y, z, stateId: id }); }
    return Boolean(changed);
  }
  updateCamera(eye) {
    if (this.mode !== 'demo') {
      const c = this.core, cx = Math.floor(eye[0] / 16), cz = Math.floor(eye[2] / 16);
      const width = c.world_width() / 16, depth = c.world_depth() / 16;
      const ox = c.world_origin_x() / 16, oz = c.world_origin_z() / 16;
      if (cx < ox + 3 || cz < oz + 3 || cx >= ox + width - 3 || cz >= oz + depth - 3) {
        const nx = cx - Math.floor(width / 2), nz = cz - Math.floor(depth / 2);
        c.world_rebase(nx, nz); this.post({ type: 'rebase', x: nx, z: nz });
        for (const key of this.keys) {
          const [x, z] = key.split(',').map(Number);
          if (!this.contains(x, z)) { this.renderer.removeChunk(key); this.keys.delete(key); this.nearReady.delete(key); }
        }
        for (const column of this.columns.values()) if (this.contains(column.x, column.z) && !c.world_column_loaded(column.x, column.z)) {
          for (const section of column.sections) { this.loadSection(column.x, section.sectionY, column.z, section.blocks, section.biomes); if (section.skyLight || section.blockLight) this.loadSectionLight(column.x, section.sectionY, column.z, section.skyLight, section.blockLight); }
          if (column.light) this.loadLight(column.x, column.z, column.light);
        }
        this.renderer.configureWorld({ ...this.bounds(), farPlane: 2048, hasSkylight: this.hasSkylight });
        this.updateNearColumns();
        if (this.store) {
          for (const [key, column] of this.columns) if (!this.contains(column.x, column.z) && key !== this.importColumnKey) { this.columns.delete(key); this.sourceRevisions.delete(key); }
          this.background(this.restoreNearColumns());
        }
      }
      this.distant?.updateCamera(eye);
    }
  }
  destroy() { this.destroyed = true; this.irradiance?.destroy(); this.stopLocalLighting(); this.worker.terminate(); this.background(this.distant?.close()); this.background(this.store?.close()); }
}
