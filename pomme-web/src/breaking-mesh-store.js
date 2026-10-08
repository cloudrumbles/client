import { BREAKING_LIMITS, CRUMBLING_RENDER_STATE } from './breaking-overlay.js';

const STRIDE = 14;
const vector = value => value?.length === 3 && Array.from(value).every(Number.isFinite);

export function relativeBreakingVertices(source, origin, renderOrigin, fog) {
  const relative = new Float32Array(source), offset = origin.map((value, axis) => value - renderOrigin[axis]);
  for (let vertex = 0; vertex < source.length; vertex += STRIDE) {
    for (let axis = 0; axis < 3; axis++) relative[vertex + axis] = offset[axis] + source[vertex + axis];
    relative[vertex + 13] = fog ? 1 : 0;
  }
  return relative;
}

/** Dedicated bounded buffers; breaking stages never change terrain/shadow state. */
export class BreakingMeshStore {
  constructor(device, renderOrigin = [0,0,0]) {
    this.device = device; this.renderOrigin = [...renderOrigin]; this.meshes = new Map(); this.removals = [];
    this.vertices = 0; this.bytes = 0; this.uploads = 0; this.allocations = 0; this.rebases = 0; this.removed = 0; this.fullReactive = false;
  }

  bounds(mesh) {
    const offset = mesh.origin.map((value, axis) => value - this.renderOrigin[axis]);
    return { min: mesh.localBounds.min.map((value, axis) => offset[axis] + value), max: mesh.localBounds.max.map((value, axis) => offset[axis] + value) };
  }

  upload(key, vertices, bounds, { origin = [0,0,0], stage = 0, renderState = CRUMBLING_RENDER_STATE } = {}) {
    if (!(vertices instanceof Float32Array) || vertices.length % (STRIDE * 3) || !vertices.length || !vertices.every(Number.isFinite)) throw new Error('Breaking meshes require finite stride-14 triangle vertices.');
    if (!vector(origin) || !vector(bounds?.min) || !vector(bounds?.max) || bounds.min.some((value, axis) => value > bounds.max[axis])) throw new Error('Breaking meshes require finite local bounds and double-precision origins.');
    if (!Number.isInteger(stage) || stage < 0 || stage > 9) throw new Error('Breaking mesh stage must be in 0..9.');
    const previous = this.meshes.get(key), count = vertices.length / STRIDE;
    if (count > BREAKING_LIMITS.verticesPerBlock || this.vertices - (previous?.count || 0) + count > BREAKING_LIMITS.vertices || !previous && this.meshes.size >= BREAKING_LIMITS.visible) throw new Error('Breaking geometry exceeds its bounded budget.');
    const capacity = 2 ** Math.ceil(Math.log2(Math.max(256, vertices.byteLength)));
    if (capacity > this.device.limits.maxBufferSize) throw new Error('Breaking geometry exceeds the GPU buffer-size limit.');
    const source = new Float32Array(vertices), fog = Boolean(renderState.fog), data = relativeBreakingVertices(source, origin, this.renderOrigin, fog);
    let buffer = previous?.buffer, retainedCapacity = previous?.capacity || 0;
    if (retainedCapacity < vertices.byteLength) {
      buffer = this.device.createBuffer({ label: `Native breaking overlay ${key}`, size: capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    try { this.device.queue.writeBuffer(buffer, 0, data); }
    catch (error) { if (buffer !== previous?.buffer) buffer.destroy(); throw error; }
    if (buffer !== previous?.buffer) { previous?.buffer.destroy(); this.bytes += capacity - retainedCapacity; retainedCapacity = capacity; this.allocations++; }
    const mesh = { buffer, capacity: retainedCapacity, source, count, origin: [...origin], localBounds: { min: [...bounds.min], max: [...bounds.max] }, stage, fog };
    mesh.renderBounds = this.bounds(mesh); this.meshes.set(key, mesh); this.vertices += count - (previous?.count || 0); this.uploads++;
    return true;
  }

  remove(key) {
    const mesh = this.meshes.get(key); if (!mesh) return false;
    this.meshes.delete(key); this.vertices -= mesh.count; this.removed++;
    if (this.removals.length === BREAKING_LIMITS.visible) {
      const dropped = this.removals.shift(); dropped.buffer.destroy(); this.bytes -= dropped.capacity; this.fullReactive = true;
    }
    this.removals.push(mesh); return true;
  }

  rebase(renderOrigin) {
    if (renderOrigin.every((value, axis) => value === this.renderOrigin[axis])) return;
    this.renderOrigin = [...renderOrigin];
    for (const mesh of [...this.meshes.values(), ...this.removals]) {
      this.device.queue.writeBuffer(mesh.buffer, 0, relativeBreakingVertices(mesh.source, mesh.origin, renderOrigin, mesh.fog));
      mesh.renderBounds = this.bounds(mesh);
    }
    this.rebases++;
  }

  finishFrame() {
    for (const mesh of this.removals) { mesh.buffer.destroy(); this.bytes -= mesh.capacity; }
    this.removals.length = 0; this.fullReactive = false;
  }

  stats() { return { meshes: this.meshes.size, vertices: this.vertices, pendingRemovals: this.removals.length, fullReactive: this.fullReactive, bufferBytes: this.bytes,
    sourceBytes: [...this.meshes.values(), ...this.removals].reduce((bytes, mesh) => bytes + mesh.source.byteLength, 0), uploads: this.uploads, allocations: this.allocations, rebases: this.rebases, removed: this.removed }; }

  destroy() { for (const mesh of [...this.meshes.values(), ...this.removals]) mesh.buffer.destroy(); this.meshes.clear(); this.removals.length = 0; this.vertices = 0; this.bytes = 0; this.fullReactive = false; }
}
