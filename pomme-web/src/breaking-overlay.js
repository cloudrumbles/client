// Native references: MultiPlayerGameMode#getDestroyStage, LevelRenderer#
// destroyBlockProgress/tick/renderBlockDestroyAnimation, Direction#getRotation,
// SheetedDecalTextureGenerator, and RenderType(s)/RenderPipelines.CRUMBLING
// in the named 1.20.4 and 1.21.11 client sources. No Minecraft assets live here.

const STRIDE = 14;
const FACE_NAMES = ['east', 'west', 'up', 'down', 'south', 'north'];
const NORMALS = { east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0], south: [0, 0, 1], north: [0, 0, -1] };
const DIRECTIONS = ['down', 'up', 'north', 'south', 'west', 'east'];
const EMPTY = new Float32Array(0);

export const BREAKING_LIMITS = Object.freeze({ tracked: 64, visible: 32, verticesPerBlock: 16384, vertices: 98304, cacheVertices: 98304, cacheEntries: 320 });

// Native RGB = source * destination + destination * source. The gray 0.5
// background in a destroy texture consequently leaves the destination alone.
// Use a dedicated color pass after solid/cutout geometry; never submit these
// meshes to terrain, collision, light, shadow, or ordinary translucent caches.
export const CRUMBLING_RENDER_STATE = Object.freeze({
  blend: Object.freeze({
    color: Object.freeze({ operation: 'add', srcFactor: 'dst', dstFactor: 'src' }),
    alpha: Object.freeze({ operation: 'add', srcFactor: 'one', dstFactor: 'zero' }),
  }),
  depthWriteEnabled: false, depthCompare: 'less-equal', depthBias: -10, depthBiasSlopeScale: -1,
  cullMode: 'back', alphaCutoff: 0.1, color: Object.freeze([1, 1, 1, 1]),
  // A native destroy texture is a modulation factor, not an sRGB albedo.
  // Sampling an existing sRGB atlas therefore needs an rgba8unorm view (or
  // an inverse sRGB transfer) so encoded gray128 stays approximately neutral.
  textureEncoding: 'source-unorm', repeatUv: true, castsShadow: false, receivesLighting: false, reactive: true,
});

const modern = version => /^1\.(\d+)/.test(version) ? Number(/^1\.(\d+)/.exec(version)[1]) > 20 : true;
export function crumblingRenderState(version = '1.20.4') {
  // Modern rendertype_crumbling.fsh applies the native environmental/render
  // distance fog. The 1.20.4 shader has no fog or lightmap multiplication.
  return Object.freeze({ ...CRUMBLING_RENDER_STATE, fog: modern(version), version });
}

export function localDestroyStage(progress) {
  // Exactly the native helper; completion/reset is the caller's responsibility.
  return Number.isFinite(progress) && progress > 0 ? Math.trunc(progress * 10) : -1;
}

export function projectBreakingUv(position, normal) {
  // Direction's enum order decides exact ties. SheetedDecal takes the inverse
  // model pose, rotates Y(pi), X(-pi/2), then Direction#getRotation; baked UVs,
  // AO and tint are ignored. These expressions are that composed projection.
  let face = 'north', best = Number.MIN_VALUE;
  for (const name of DIRECTIONS) {
    const dot = normal.reduce((sum, value, axis) => sum + value * NORMALS[name][axis], 0);
    if (dot > best) { face = name; best = dot; }
  }
  const [x, y, z] = position;
  switch (face) {
    case 'down': return [x, -z];
    case 'up': return [x, z];
    case 'north': return [-x, -y];
    case 'south': return [x, -y];
    case 'west': return [-z, -y];
    case 'east': return [z, -y];
  }
}

function blockPosition(input) {
  const position = Array.isArray(input) || ArrayBuffer.isView(input) ? Array.from(input) : [input?.x, input?.y, input?.z];
  return position.length === 3 && position.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) ? position : null;
}
function nativeTick(tick) { return Number.isSafeInteger(tick) && tick >= 0 ? tick : null; }
const positionKey = position => position.join(',');
const bounded = (value, fallback, ceiling) => value === undefined ? fallback : Number.isInteger(value) && value > 0 && value <= ceiling ? value : (() => { throw new RangeError('Breaking overlay bounds must be positive integers within the hard limits.'); })();

/** Bounded render-only local and remote destroy animation tracker.
 *
 * uploadBreakingMesh(key, vertices, localBounds, {origin, stage, stride,
 * renderState}) must retain a mesh under that key without changing shadows.
 * An explicit uploadMesh/removeMesh pair can be injected for another renderer.
 * getTemplate(stateId, position, material) can supply exact live block-entity
 * triangles, as an immutable Float32Array or {vertices,revision}. A mutable
 * provider must use a bounded scalar revision that identifies immutable
 * contents (reusing a revision requires restoring those same contents).
 * getModelOffset supplies a native block-model offset. The default
 * template is the already baked asset material, never an invented unit cube.
 */
export class BreakingOverlay {
  constructor({ world, materials, atlas, version = '1.20.4', renderer, uploadMesh, removeMesh,
    getState, getTemplate, getModelOffset, shouldRenderFace, limits = {}, keyPrefix = '__breaking:' } = {}) {
    this.world = world; this.materials = materials; this.atlas = atlas; this.version = version;
    this.upload = uploadMesh ?? (renderer?.uploadBreakingMesh && renderer.uploadBreakingMesh.bind(renderer));
    this.remove = removeMesh ?? (renderer?.removeBreakingMesh && renderer.removeBreakingMesh.bind(renderer));
    if (typeof this.upload !== 'function' || typeof this.remove !== 'function') throw new TypeError('BreakingOverlay requires a dedicated render-only mesh sink.');
    this.getState = getState ?? ((...position) => world?.block_get?.(...position) ?? world?.getBlock?.(...position) ?? world?.core?.block_get?.(...position));
    this.getTemplate = getTemplate ?? ((_state, _position, material) => material?.templateVertices);
    this.getModelOffset = getModelOffset ?? (() => [0, 0, 0]);
    this.shouldRenderFace = shouldRenderFace;
    this.limits = Object.fromEntries(Object.entries(BREAKING_LIMITS).map(([name, ceiling]) => [name, bounded(limits[name], ceiling, ceiling)]));
    this.keyPrefix = String(keyPrefix); this.records = new Map(); this.meshes = new Map(); this.cache = new Map();
    this.templateIds = new WeakMap(); this.nextTemplateId = 0; this.cacheVertices = 0; this.sequence = 0;
    this.tick = 0; this.cleanupBucket = 0; this.generation = world?.generation; this.destroyed = false;
    this.metrics = { uploads: 0, removals: 0, retainedHits: 0, cacheHits: 0, geometryBuilds: 0, rejectedGeometry: 0, evictedBreakers: 0, missingTextures: 0 };
    this.renderState = crumblingRenderState(version); this.stageTiles = this.readStageTiles(atlas);
  }

  readStageTiles(atlas) {
    return Array.from({ length: 10 }, (_, stage) => {
      const name = `minecraft:block/destroy_stage_${stage}`;
      const id = atlas?.tileByName?.get(name) ?? atlas?.tiles?.find(tile => tile.name === name)?.id;
      return Number.isInteger(id) && id >= 0 && atlas?.tiles?.[id]?.name === name ? id : null;
    });
  }

  syncGeneration() {
    if (this.generation === this.world?.generation) return;
    this.clear(); this.generation = this.world?.generation;
  }

  progress(entityId, position, stage, tick) {
    if (this.destroyed || !Number.isInteger(entityId) || entityId < -2147483648 || entityId > 2147483647 || !Number.isInteger(stage)) return false;
    this.syncGeneration();
    if (stage < 0 || stage >= 10) return this.records.delete(entityId);
    const pos = blockPosition(position), at = nativeTick(tick ?? this.tick);
    if (!pos || at === null) return false;
    const previous = this.records.get(entityId), key = positionKey(pos);
    const stateId = previous?.key === key && previous.stateId !== undefined && previous.stateId !== null ? previous.stateId : this.getState(...pos);
    if (!previous && this.records.size >= this.limits.tracked) {
      let oldest;
      for (const record of this.records.values()) if (!oldest || record.tick < oldest.tick || record.tick === oldest.tick && record.sequence < oldest.sequence) oldest = record;
      this.records.delete(oldest.entityId); this.metrics.evictedBreakers++;
    }
    this.records.set(entityId, { entityId, position: pos, key, stage, tick: at, stateId, sequence: ++this.sequence });
    return true;
  }

  event(event, tick) {
    return event?.type === 'break-progress' && this.progress(event.entityId, event.location, event.destroyStage, tick);
  }

  localProgress(entityId, position, fraction, tick) {
    return this.progress(entityId, position, localDestroyStage(fraction), tick);
  }

  blockChanged(position, stateId) {
    const pos = blockPosition(position);
    if (!pos || this.destroyed) return false;
    const key = positionKey(pos); let changed = false;
    // Native renders the current block state until a remove packet/timeout.
    // We additionally retire known crack records on a replacement block.
    // A brand-new packet has no source state ID; callers must still guard
    // packet/world epochs to avoid admitting a stale previous-world packet.
    for (const [id, record] of this.records) if (record.key === key && (stateId === undefined || record.stateId !== stateId)) { this.records.delete(id); changed = true; }
    if (changed) this.removeVisible(key);
    return changed;
  }

  removeColumn(x, z) {
    if (this.destroyed || !Number.isInteger(x) || !Number.isInteger(z)) return;
    for (const [id, record] of this.records) if (Math.floor(record.position[0] / 16) === x && Math.floor(record.position[2] / 16) === z) {
      this.records.delete(id); this.removeVisible(record.key);
    }
  }

  faceMask(stateId, position, material) {
    let mask = 0;
    for (let index = 0; index < FACE_NAMES.length; index++) {
      const face = FACE_NAMES[index];
      let visible;
      if (this.shouldRenderFace) visible = this.shouldRenderFace(stateId, position, face, material);
      else {
        const normal = NORMALS[face], neighborPosition = position.map((value, axis) => value + normal[axis]);
        const neighbor = neighborPosition.every(value => value >= -2147483648 && value <= 2147483647) ? this.materials?.get(this.getState(...neighborPosition)) : null;
        // The common full opaque boundary is provable from the baked model.
        // Partial native occlusion shapes/skipRendering rules can be supplied
        // by the caller; collision boxes are deliberately not used as faces.
        visible = !(neighbor?.fullCube && !neighbor.unsupported && neighbor.model?.supported !== false && neighbor.flags & 2);
      }
      if (visible !== false) mask |= 1 << index;
    }
    return mask;
  }

  geometryKey(template, mask, offset, stage, revision = 0) {
    if (!(template instanceof Float32Array) || template.length === 0 || template.length % (STRIDE * 3) || !Array.isArray(offset) && !ArrayBuffer.isView(offset) || offset.length !== 3 || !Array.from(offset).every(Number.isFinite)) return null;
    if (!(Number.isSafeInteger(revision) || typeof revision === 'string' && revision.length <= 128)) return null;
    let id = this.templateIds.get(template);
    if (id === undefined) { id = ++this.nextTemplateId; this.templateIds.set(template, id); }
    const tile = this.stageTiles[stage];
    if (tile === null) { this.metrics.missingTextures++; return null; }
    return `${id}:${typeof revision}:${String(revision).length}:${revision}:${mask}:${Array.from(offset).join(',')}:${stage}:${tile}`;
  }

  geometry(template, mask, offset, stage, key) {
    const tile = this.stageTiles[stage];
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); this.metrics.cacheHits++; return cached.vertices.length ? cached : null; }
    let vertexCount = 0, valid = template.length / STRIDE <= this.limits.verticesPerBlock;
    if (valid) for (let index = 0; index < template.length; index += STRIDE * 3) {
      const cull = Math.round(template[index + 13]) >>> 18 & 7;
      if (cull >= 1 && cull <= 6 && !(mask & 1 << (cull - 1))) continue;
      for (let vertex = index; vertex < index + STRIDE * 3; vertex += STRIDE) {
        for (let axis = 0; axis < 6; axis++) if (!Number.isFinite(template[vertex + axis]) || axis < 3 && !Number.isFinite(Math.fround(template[vertex + axis] + offset[axis]))) valid = false;
      }
      vertexCount += 3;
    }
    if (!valid) { vertexCount = 0; this.metrics.rejectedGeometry++; }
    const vertices = vertexCount ? new Float32Array(vertexCount * STRIDE) : EMPTY;
    const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; let cursor = 0;
    if (vertexCount) for (let index = 0; index < template.length; index += STRIDE * 3) {
      const cull = Math.round(template[index + 13]) >>> 18 & 7;
      if (cull >= 1 && cull <= 6 && !(mask & 1 << (cull - 1))) continue;
      for (let vertex = index; vertex < index + STRIDE * 3; vertex += STRIDE) {
        const position = Array.from({ length: 3 }, (_, axis) => template[vertex + axis] + offset[axis]), normal = Array.from(template.subarray(vertex + 3, vertex + 6));
        const uv = projectBreakingUv(position, normal);
        // Render-only high/low material bits, AO, block tint and light are
        // intentionally cleared. Alpha comes solely from the destroy texture.
        vertices.set([...position, ...normal, 1, 1, 1, 1, ...uv, tile, 0], cursor); cursor += STRIDE;
        for (let axis = 0; axis < 3; axis++) { bounds.min[axis] = Math.min(bounds.min[axis], position[axis]); bounds.max[axis] = Math.max(bounds.max[axis], position[axis]); }
      }
    }
    this.metrics.geometryBuilds++;
    const value = { vertices, bounds, key };
    while (this.cache.size >= this.limits.cacheEntries || this.cacheVertices + vertexCount > this.limits.cacheVertices) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheVertices -= this.cache.get(oldest).vertices.length / STRIDE; this.cache.delete(oldest);
    }
    // A tighter caller cache bound may intentionally exclude a large model.
    if (vertexCount <= this.limits.cacheVertices) { this.cache.set(key, value); this.cacheVertices += vertexCount; }
    return vertexCount ? value : null;
  }

  update({ eye, tick } = {}) {
    if (this.destroyed) return;
    this.syncGeneration();
    tick = tick ?? this.tick;
    if (!eye || eye.length !== 3 || !Array.from(eye).every(Number.isFinite) || nativeTick(tick) === null) throw new TypeError('Breaking overlay needs a finite eye position and native render tick.');
    if (tick < this.tick) { this.clear(); }
    this.tick = tick;
    const bucket = Math.floor(tick / 20);
    if (bucket !== this.cleanupBucket) {
      // If frames skip ticks, run the cleanup at the last native 20-tick
      // boundary crossed. A record of age400 remains until the next boundary.
      const boundary = bucket * 20;
      for (const [id, record] of this.records) if (boundary - record.tick > 400) this.records.delete(id);
      this.cleanupBucket = bucket;
    }
    const candidates = new Map(), center = modern(this.version) ? 0.5 : 0;
    for (const [id, record] of this.records) {
      const state = this.getState(...record.position);
      if (record.stateId === undefined || record.stateId === null) record.stateId = state;
      else if (state !== record.stateId) { this.records.delete(id); continue; }
      const distance = record.position.reduce((sum, value, axis) => sum + (value + center - eye[axis]) ** 2, 0);
      if (distance > 1024) continue;
      const previous = candidates.get(record.key);
      if (!previous || record.stage > previous.stage || record.stage === previous.stage && record.entityId > previous.entityId) candidates.set(record.key, { ...record, distance });
    }
    const selected = [...candidates.values()].sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
    const planned = new Map(); let vertices = 0;
    for (const record of selected) {
      if (planned.size >= this.limits.visible) break;
      const material = this.materials?.get(record.stateId);
      if (!material || material.unsupported || material.model?.supported === false || material.flags & (4 | 128)) continue;
      const supplied = this.getTemplate(record.stateId, record.position, material), template = supplied instanceof Float32Array ? supplied : supplied?.vertices;
      const revision = supplied instanceof Float32Array ? 0 : supplied?.revision ?? 0, offset = this.getModelOffset(record.stateId, record.position, material);
      const mask = this.faceMask(record.stateId, record.position, material), signature = this.geometryKey(template, mask, offset, record.stage, revision);
      if (signature === null) continue;
      const previous = this.meshes.get(record.key);
      // Visible meshes retain their source geometry even when the stage LRU
      // evicts it. Cache pressure must not cause identical per-frame uploads.
      const geometry = previous?.geometry.key === signature ? previous.geometry : this.geometry(template, mask, offset, record.stage, signature);
      if (previous?.geometry === geometry) this.metrics.retainedHits++;
      if (!geometry || vertices + geometry.vertices.length / STRIDE > this.limits.vertices) continue;
      planned.set(record.key, { record, geometry }); vertices += geometry.vertices.length / STRIDE;
    }
    // Retire departed meshes before admitting new ones. Apply vertex-count
    // reductions before growth so the sink obeys the same caps throughout the
    // transition, rather than briefly retaining two full visible sets.
    for (const key of this.meshes.keys()) if (!planned.has(key)) this.removeVisible(key);
    const delta = ([key, plan]) => plan.geometry.vertices.length - (this.meshes.get(key)?.geometry.vertices.length ?? 0);
    for (const [position, { record, geometry }] of [...planned].sort((a, b) => delta(a) - delta(b))) {
      const previous = this.meshes.get(position), key = this.keyPrefix + position;
      if (!previous || previous.geometry !== geometry) {
        this.upload(key, geometry.vertices, geometry.bounds, { origin: record.position, stride: STRIDE, stage: record.stage, renderState: this.renderState });
        this.meshes.set(record.key, { key, geometry, stage: record.stage, entityId: record.entityId }); this.metrics.uploads++;
      } else { previous.stage = record.stage; previous.entityId = record.entityId; }
    }
  }

  removeVisible(key) {
    const mesh = this.meshes.get(key);
    if (!mesh) return;
    this.remove(mesh.key); this.meshes.delete(key); this.metrics.removals++;
  }

  clear() {
    for (const key of this.meshes.keys()) this.removeVisible(key);
    this.records.clear(); this.cache.clear(); this.cacheVertices = 0; this.templateIds = new WeakMap(); this.nextTemplateId = 0;
    this.tick = 0; this.cleanupBucket = 0;
  }

  stats() {
    return { ...this.metrics, tracked: this.records.size, visible: this.meshes.size,
      vertices: [...this.meshes.values()].reduce((sum, mesh) => sum + mesh.geometry.vertices.length / STRIDE, 0),
      cacheEntries: this.cache.size, cacheVertices: this.cacheVertices, destroyed: this.destroyed };
  }

  destroy() { if (!this.destroyed) { this.clear(); this.destroyed = true; } }
}
