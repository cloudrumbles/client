import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BreakingMeshStore } from '../src/breaking-mesh-store.js';

globalThis.GPUBufferUsage ??= { VERTEX: 32, COPY_DST: 8 };
const bounds = { min: [0,0,0], max: [1,.5,0] };
const vertices = (triangles = 2) => new Float32Array(Array.from({ length: triangles * 3 }, (_, i) => [i % 2,.125 + (i % 3) * .125,0,0,0,1,1,1,1,1,i % 2,i % 3,2,0]).flat());
function fixture(origin = [0,0,0]) {
  const buffers = [], writes = [];
  const device = { limits: { maxBufferSize: 1 << 26 }, createBuffer(descriptor) { const buffer = { descriptor, destroyed: 0, destroy() { this.destroyed++; } }; buffers.push(buffer); return buffer; },
    queue: { writeBuffer(buffer, offset, values) { if (device.failWrite) throw new Error('write rejected'); writes.push({ buffer, offset, values: new Float32Array(values) }); } } };
  return { store: new BreakingMeshStore(device, origin), device, buffers, writes };
}

test('breaking origins rebase all three axes in doubles before float conversion and retain source geometry', () => {
  const origin = [2_000_000_000,-2_000_000_000,2_000_000_000], f = fixture(origin), input = vertices();
  f.store.upload('block', input, bounds, { origin: [origin[0] + 1,origin[1] + 2,origin[2] + 3], stage: 4, renderState: { fog: true } });
  const mesh = f.store.meshes.get('block'), uploaded = f.writes[0].values;
  assert.deepEqual(Array.from(uploaded.slice(0,3)), [1,2.125,3]); assert.equal(uploaded[13], 1); assert.deepEqual(Array.from(input.slice(0,3)), [0,.125,0]);
  assert.deepEqual(mesh.renderBounds, { min: [1,2,3], max: [2,2.5,3] });
  input.fill(99); f.store.rebase([origin[0] + 256,origin[1] - 256,origin[2] + 256]);
  assert.deepEqual(Array.from(f.writes[1].values.slice(0,3)), [-255,258.125,-253]);
  assert.deepEqual(mesh.renderBounds, { min: [-255,258,-253], max: [-254,258.5,-253] });
  assert.equal(f.buffers.length, 1); assert.equal(f.store.stats().rebases, 1);
  f.store.destroy(); assert.equal(f.buffers[0].destroyed, 1);
});

test('stage changes retain buffer capacity while growth replaces one buffer and rollback preserves prior geometry', () => {
  const f = fixture(); f.store.upload('a', vertices(), bounds, { stage: 0 });
  const first = f.store.meshes.get('a').buffer;
  f.store.upload('a', vertices(1), bounds, { stage: 9 }); assert.equal(f.store.meshes.get('a').buffer, first); assert.equal(f.buffers.length, 1);
  f.device.failWrite = true; assert.throws(() => f.store.upload('a', vertices(8), bounds), /write rejected/);
  assert.equal(f.store.meshes.get('a').buffer, first); assert.equal(first.destroyed, 0); assert.equal(f.buffers[1].destroyed, 1); assert.equal(f.store.stats().vertices, 3);
  f.device.failWrite = false; f.store.upload('a', vertices(8), bounds); assert.equal(first.destroyed, 1); assert.equal(f.store.stats().allocations, 2);
  f.store.destroy(); assert.equal(f.buffers[2].destroyed, 1);
});

test('removal retains one frame of reactive geometry, rebases it and frees it after submission', () => {
  const f = fixture(); f.store.upload('a', vertices(), bounds); const mesh = f.store.meshes.get('a');
  assert.equal(f.store.remove('a'), true); assert.equal(f.store.remove('a'), false); assert.equal(f.store.stats().vertices, 0); assert.equal(f.store.stats().pendingRemovals, 1); assert.equal(mesh.buffer.destroyed, 0);
  f.store.rebase([256,0,0]); assert.equal(mesh.renderBounds.min[0], -256); assert.equal(f.writes.at(-1).values[0], -256);
  f.store.finishFrame(); assert.equal(mesh.buffer.destroyed, 1); assert.equal(f.store.stats().bufferBytes, 0); assert.equal(f.store.stats().sourceBytes, 0);
});

test('active and removed geometry remain bounded; removal overflow requests one frame of global history rejection', () => {
  const f = fixture(); for (let index = 0; index < 32; index++) f.store.upload(index, vertices(), bounds);
  assert.throws(() => f.store.upload(32, vertices(), bounds), /bounded budget/);
  for (let index = 0; index < 32; index++) f.store.remove(index);
  f.store.upload(32, vertices(), bounds); f.store.remove(32);
  assert.equal(f.store.stats().pendingRemovals, 32); assert.equal(f.buffers[0].destroyed, 1); assert.equal(f.store.stats().fullReactive, true);
  f.store.finishFrame(); assert.equal(f.store.stats().pendingRemovals, 0); assert.equal(f.store.stats().fullReactive, false); assert.equal(f.store.stats().bufferBytes, 0);
});

test('triangle, stage, origin, GPU and aggregate vertex limits reject before allocation', () => {
  const f = fixture();
  for (const [data, box, options] of [[new Float32Array(14),bounds,{}],[vertices(),bounds,{ stage: 10 }],[vertices(),bounds,{ origin: [0,Infinity,0] }],[vertices(),{ min: [0,0,0],max: [-1,0,0] },{}],[vertices(5462),bounds,{}]]) assert.throws(() => f.store.upload('bad', data, box, options));
  assert.equal(f.buffers.length, 0);
  f.device.limits.maxBufferSize = 256; assert.throws(() => f.store.upload('too-large', vertices(), bounds), /buffer-size/); assert.equal(f.buffers.length, 0);
  f.device.limits.maxBufferSize = 1 << 26;
  for (let index = 0; index < 6; index++) f.store.upload(index, vertices(5461), bounds);
  assert.throws(() => f.store.upload(6, vertices(3), bounds), /bounded budget/); assert.equal(f.store.stats().vertices, 98298);
  f.store.destroy();
});
