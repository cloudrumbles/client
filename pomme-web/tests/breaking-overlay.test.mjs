import assert from 'node:assert/strict';
import test from 'node:test';
import { BREAKING_LIMITS, CRUMBLING_RENDER_STATE, BreakingOverlay, crumblingRenderState, localDestroyStage, projectBreakingUv } from '../src/breaking-overlay.js';

const atlas = () => {
  const tiles = Array.from({ length: 10 }, (_, id) => ({ id, name: `minecraft:block/destroy_stage_${id}` }));
  return { tiles, tileByName: new Map(tiles.map(tile => [tile.name, tile.id])) };
};
const triangle = (normal = [0, 0, -1], flags = 0) => new Float32Array([
  [0, 0, 0], [0, 0.5, 0], [0.5, 0.5, 0],
].flatMap(position => [...position, ...normal, 0.2, 0.3, 0.4, 0.25, 0.2, 0.8, 123, flags]));
const material = (id = 1, vertices = triangle()) => ({ id, flags: 32, fullCube: false, model: { supported: true }, templateVertices: vertices });
function fixture(options = {}) {
  const states = new Map(), writes = [], removes = [], defaultState = options.defaultState ?? 1;
  const world = { generation: 1, block_get: (...position) => states.get(position.join(',')) ?? defaultState,
    setBlock: () => { throw new Error('Cracks must never edit world blocks.'); },
    dirtyLighting: () => { throw new Error('Cracks must never dirty world lighting.'); } };
  const renderer = { uploadBreakingMesh: (...args) => writes.push(args), removeBreakingMesh: key => removes.push(key),
    uploadDynamicMesh: () => { throw new Error('Cracks must never use the shadow-producing dynamic stream.'); },
    uploadChunk: () => { throw new Error('Cracks must never rebuild terrain.'); } };
  const overlay = new BreakingOverlay({ world, renderer, materials: new Map([[1, material()]]), atlas: atlas(), ...options });
  return { overlay, states, writes, removes, world };
}
const view = (overlay, tick = 0, eye = [0, 0, 0]) => overlay.update({ tick, eye });

test('native local fractions and remote protocol fields use stages0..9 and out-of-range removal', () => {
  assert.deepEqual([0, -1, NaN, Infinity, 0.01, 0.099, 0.1, 0.999, 1].map(localDestroyStage), [-1, -1, -1, -1, 0, 0, 1, 9, 10]);
  const { overlay, writes, removes } = fixture();
  assert.equal(overlay.event({ type: 'break-progress', entityId: 42, location: { x: 0, y: 0, z: 0 }, destroyStage: 3 }), true);
  view(overlay); assert.equal(writes[0][3].stage, 3);
  assert.equal(overlay.event({ type: 'not-break-progress' }), false);
  assert.equal(overlay.progress(42, null, -1), true); view(overlay); assert.deepEqual(removes, ['__breaking:0,0,0']);
  overlay.localProgress(42, [0, 0, 0], 0.95); view(overlay); assert.equal(writes.at(-1)[3].stage, 9);
  overlay.localProgress(42, [0, 0, 0], 1); view(overlay); assert.equal(overlay.stats().tracked, 0);
  assert.equal(overlay.progress(1, [0, 0, 0], 10), false);
});

test('one retained block mesh picks strongest breaker, then highest ID, and moving a breaker retires its prior position', () => {
  const { overlay, writes, removes } = fixture();
  overlay.progress(9, [0, 0, 0], 6); overlay.progress(2, [0, 0, 0], 8); overlay.progress(12, [0, 0, 0], 8);
  view(overlay); assert.equal(writes.length, 1); assert.equal(overlay.meshes.get('0,0,0').entityId, 12);
  overlay.progress(12, null, -1); view(overlay); assert.equal(writes.length, 1); assert.equal(overlay.meshes.get('0,0,0').entityId, 2);
  overlay.progress(2, [2, 0, 0], 4); view(overlay); assert.equal(overlay.meshes.get('0,0,0').stage, 6);
  assert.equal(overlay.meshes.get('2,0,0').stage, 4); assert.equal(overlay.stats().visible, 2);
  overlay.progress(9, null, -1); view(overlay); assert.deepEqual(removes, ['__breaking:0,0,0']);
});

test('native projected UVs preserve all six face orientations and Direction enum tie ordering', () => {
  const p = [0.25, 0.75, 0.125];
  for (const [normal, uv] of [
    [[0, -1, 0], [0.25, -0.125]], [[0, 1, 0], [0.25, 0.125]],
    [[0, 0, -1], [-0.25, -0.75]], [[0, 0, 1], [0.25, -0.75]],
    [[-1, 0, 0], [-0.125, -0.75]], [[1, 0, 0], [0.125, -0.75]],
  ]) assert.deepEqual(projectBreakingUv(p, normal), uv);
  assert.deepEqual(projectBreakingUv(p, [1, -1, 0]), [0.25, -0.125]); // DOWN precedes EAST.
  assert.deepEqual(projectBreakingUv(p, [1, 0, 1]), [0.25, -0.75]); // SOUTH precedes EAST.
  assert.deepEqual(projectBreakingUv(p, [0, 0, 0]), [-0.25, -0.75]); // Native fallback NORTH.
});

test('overlay preserves exact thin/cutout source triangles, ignores baked tint/UV/light, and carries source native model offsets', () => {
  const source = triangle([0, 0, -1], 32 | 512 | 15 << 10), copy = new Float32Array(source);
  const { overlay, writes } = fixture({ materials: new Map([[1, material(1, source)]]), getModelOffset: () => [0.125, -0.25, 0.0625] });
  overlay.progress(1, [123, 40000, -456], 5); view(overlay, 0, [123, 40000, -456]);
  const [, vertices, bounds, options] = writes[0];
  assert.deepEqual(source, copy); assert.equal(vertices.length, 3 * 14);
  assert.deepEqual(options.origin, [123, 40000, -456]);
  assert.deepEqual(bounds, { min: [0.125, -0.25, 0.0625], max: [0.625, 0.25, 0.0625] });
  for (let index = 0; index < vertices.length; index += 14) {
    assert.deepEqual(Array.from(vertices.subarray(index + 6, index + 10)), [1, 1, 1, 1]);
    assert.equal(vertices[index + 12], 5); assert.equal(vertices[index + 13], 0);
    assert.equal(vertices[index + 10], -vertices[index]); assert.equal(vertices[index + 11], -vertices[index + 1]);
  }
  assert.equal(options.renderState.alphaCutoff, 0.1); assert.equal(options.renderState.castsShadow, false);
});

test('unchanged frames retain uploads even after stage-cache eviction; revisiting a cached stage reuses immutable geometry', () => {
  const { overlay, writes } = fixture({ limits: { cacheEntries: 1 } });
  overlay.progress(1, [0, 0, 0], 0); overlay.progress(2, [1, 0, 0], 1); view(overlay);
  assert.equal(writes.length, 2); assert.equal(overlay.stats().cacheEntries, 1);
  for (let tick = 1; tick < 100; tick++) view(overlay, tick);
  assert.equal(writes.length, 2); assert.equal(overlay.stats().geometryBuilds, 2);
  assert.equal(overlay.stats().retainedHits, 198);
  const cached = fixture(); cached.overlay.progress(1, [0, 0, 0], 0); view(cached.overlay);
  const first = cached.writes[0][1];
  cached.overlay.progress(1, [0, 0, 0], 1); view(cached.overlay);
  cached.overlay.progress(1, [0, 0, 0], 0); view(cached.overlay);
  assert.equal(cached.writes.at(-1)[1], first); assert.equal(cached.overlay.stats().geometryBuilds, 2);
});

test('native timeout observes >400 ticks only at 20-tick boundaries, and updates refresh the timeout', () => {
  const { overlay } = fixture(); overlay.progress(1, [0, 0, 0], 3, 0);
  for (const tick of [400, 401, 419]) { view(overlay, tick); assert.equal(overlay.stats().tracked, 1); }
  view(overlay, 420); assert.equal(overlay.stats().tracked, 0); assert.equal(overlay.stats().visible, 0);
  overlay.progress(1, [0, 0, 0], 3, 420); view(overlay, 820); assert.equal(overlay.stats().tracked, 1);
  overlay.progress(1, [0, 0, 0], 3, 821); view(overlay, 840); assert.equal(overlay.stats().tracked, 1);
});

test('mutable native geometry providers invalidate the retained stage through an explicit bounded revision', () => {
  const vertices = triangle(), geometry = { vertices, revision: 0 };
  const { overlay, writes } = fixture({ getTemplate: () => geometry }); overlay.progress(1, [0, 0, 0], 3); view(overlay);
  vertices[1] = -0.25; geometry.revision++; view(overlay, 1);
  assert.equal(writes.length, 2); assert.equal(writes[0][1][1], 0); assert.equal(writes[1][1][1], -0.25);
  view(overlay, 2); assert.equal(writes.length, 2);
  vertices[1] = -0.5; geometry.revision = String(geometry.revision); view(overlay, 3);
  assert.equal(writes.length, 3); assert.equal(writes.at(-1)[1][1], -0.5);
  geometry.revision = 'x'.repeat(129); view(overlay, 3); assert.equal(overlay.stats().visible, 0);
});

test('distance boundary is native block corner in1.20.4 and native block center in1.21.11', () => {
  const legacy = fixture(), current = fixture({ version: '1.21.11' });
  for (const item of [legacy, current]) item.overlay.progress(1, [32, 0, 0], 2);
  view(legacy.overlay, 0, [0, 0, 0]); assert.equal(legacy.overlay.stats().visible, 1);
  view(legacy.overlay, 1, [-0.001, 0, 0]); assert.equal(legacy.overlay.stats().visible, 0); assert.equal(legacy.overlay.stats().tracked, 1);
  view(current.overlay, 0, [0.5, 0.5, 0.5]); assert.equal(current.overlay.stats().visible, 1);
  view(current.overlay, 1, [0, 0, 0]); assert.equal(current.overlay.stats().visible, 0);
});

test('replacement blocks, native world reset, disconnect and invalid input cannot leave stale meshes', () => {
  const { overlay, states, removes, world } = fixture();
  overlay.progress(1, [0, 0, 0], 5); view(overlay); assert.equal(overlay.blockChanged([0, 0, 0], 1), false);
  states.set('0,0,0', 2); view(overlay); assert.equal(overlay.stats().tracked, 0); assert.equal(removes.length, 1);
  states.delete('0,0,0'); overlay.progress(1, [0, 0, 0], 5); view(overlay);
  assert.equal(overlay.blockChanged({ x: 0, y: 0, z: 0 }), true); assert.equal(overlay.stats().visible, 0);
  overlay.progress(1, [0, 0, 0], 5); view(overlay); world.generation++; view(overlay); assert.equal(overlay.stats().tracked, 0);
  for (const position of [[NaN, 0, 0], [0.2, 0, 0], [2147483648, 0, 0], [0, -2147483649, 0]]) assert.equal(overlay.progress(1, position, 1), false);
  assert.equal(overlay.progress(2147483648, [0, 0, 0], 1), false);
  assert.equal(overlay.progress(1, [0, 0, 0], 1, 0.5), false);
  overlay.progress(1, [0, 0, 0], 1); view(overlay); overlay.destroy(); overlay.destroy();
  assert.equal(overlay.progress(1, [0, 0, 0], 1), false); assert.equal(overlay.stats().visible, 0); assert.equal(overlay.stats().cacheVertices, 0);
});

test('default local/remote ticks reset before new-world admission and same-position refresh cannot rebind an old block record', () => {
  for (const send of [overlay => overlay.progress(1, [0, 0, 0], 3), overlay => overlay.localProgress(1, [0, 0, 0], 0.3),
    overlay => overlay.event({ type: 'break-progress', entityId: 1, location: { x: 0, y: 0, z: 0 }, destroyStage: 3 })]) {
    const { overlay, world, states } = fixture(); view(overlay, 1000); world.generation++; send(overlay);
    assert.equal(overlay.records.get(1).tick, 0); view(overlay, 420); assert.equal(overlay.stats().tracked, 0);
    send(overlay); states.set('0,0,0', 2); send(overlay); view(overlay, 420); assert.equal(overlay.stats().tracked, 0);
  }
  const { overlay, world } = fixture(); view(overlay, 1000); world.generation++; overlay.update({ eye: [0, 0, 0] });
  overlay.progress(1, [0, 0, 0], 3); assert.equal(overlay.records.get(1).tick, 0);
});

test('source column unloading retires every breaker and GPU key inside that native column', () => {
  const { overlay, removes } = fixture(); overlay.progress(1, [-1, 0, -1], 2); overlay.progress(2, [-16, 0, -16], 4); overlay.progress(3, [0, 0, 0], 6);
  view(overlay); overlay.removeColumn(-1, -1); assert.equal(overlay.stats().tracked, 1); assert.equal(overlay.stats().visible, 1);
  assert.deepEqual(removes.sort(), ['__breaking:-1,0,-1', '__breaking:-16,0,-16']);
});

test('full opaque neighbor culling and the exact native visibility callback cull only encoded model faces', () => {
  const east = triangle([1, 0, 0], 1 << 18), unculled = triangle();
  const vertices = new Float32Array([...east, ...unculled]), materials = new Map([[1, material(1, vertices)], [2, { ...material(2), fullCube: true, flags: 2 }]]);
  const { overlay, states, writes } = fixture({ materials }); states.set('1,0,0', 2);
  overlay.progress(1, [0, 0, 0], 2); view(overlay); assert.equal(writes[0][1].length, 3 * 14);
  states.delete('1,0,0'); view(overlay); assert.equal(writes.at(-1)[1].length, 6 * 14);
  const exact = fixture({ materials, shouldRenderFace: (_state, _position, face) => face !== 'east' });
  exact.overlay.progress(1, [0, 0, 0], 2); view(exact.overlay); assert.equal(exact.writes[0][1].length, 3 * 14);
});

test('resource admission uses user destroy-stage tiles, skips missing/unsupported/fluid geometry and rejects oversized/nonfinite triangles', () => {
  const absent = fixture({ atlas: { tiles: [] } }); absent.overlay.progress(1, [0, 0, 0], 2); view(absent.overlay); assert.equal(absent.writes.length, 0);
  for (const m of [{ ...material(), unsupported: true }, { ...material(), flags: 4 }, { ...material(), flags: 128 }, material(1, new Float32Array(0))]) {
    const item = fixture({ materials: new Map([[1, m]]) }); item.overlay.progress(1, [0, 0, 0], 2); view(item.overlay); assert.equal(item.writes.length, 0);
  }
  for (const vertices of [new Float32Array(6 * 14), new Float32Array([NaN, ...triangle().subarray(1)])]) {
    const item = fixture({ limits: { verticesPerBlock: 3 }, materials: new Map([[1, material(1, vertices)]]) });
    item.overlay.progress(1, [0, 0, 0], 2); view(item.overlay); view(item.overlay, 1);
    assert.equal(item.writes.length, 0); assert.equal(item.overlay.stats().rejectedGeometry, 1);
  }
  const oversizedOffset = fixture({ getModelOffset: () => [1e308, 0, 0] }); oversizedOffset.overlay.progress(1, [0, 0, 0], 2); view(oversizedOffset.overlay); assert.equal(oversizedOffset.writes.length, 0);
});

test('tracked/visible/vertex/cache caps bound untrusted packet streams without terrain or shadow writes', () => {
  const { overlay } = fixture();
  for (let id = 0; id < 1000; id++) overlay.progress(id, [id % 8, Math.floor(id / 8) % 8, Math.floor(id / 64) % 8], id % 10, 0);
  view(overlay); const stats = overlay.stats();
  assert.equal(stats.tracked, BREAKING_LIMITS.tracked); assert.equal(stats.visible, BREAKING_LIMITS.visible);
  assert.equal(stats.evictedBreakers, 936); assert.ok(stats.cacheEntries <= BREAKING_LIMITS.cacheEntries); assert.ok(stats.cacheVertices <= BREAKING_LIMITS.cacheVertices);
  const small = fixture({ limits: { vertices: 5, cacheVertices: 3, cacheEntries: 1 } });
  small.overlay.progress(1, [0, 0, 0], 1); small.overlay.progress(2, [1, 0, 0], 2); view(small.overlay);
  assert.equal(small.overlay.stats().vertices, 3); assert.equal(small.overlay.stats().visible, 1); assert.ok(small.overlay.stats().cacheVertices <= 3);
  assert.throws(() => fixture({ limits: { tracked: 65 } }), RangeError);
  assert.throws(() => new BreakingOverlay({ renderer: { uploadDynamicMesh() {}, removeMesh() {} } }), /dedicated render-only/);
});

test('sink caps apply during visible-set transitions and geometry growth, not only after a frame completes', () => {
  const sink = new Map(); let peakMeshes = 0, peakVertices = 0;
  const count = () => { peakMeshes = Math.max(peakMeshes, sink.size); peakVertices = Math.max(peakVertices, [...sink.values()].reduce((sum, count) => sum + count, 0)); };
  const vertices = new Float32Array([...triangle(), ...triangle(), ...triangle()]), small = triangle();
  const states = new Map([['0,0,0', 1], ['1,0,0', 2]]), mutable = new Map([[1, { vertices: small, revision: 0 }], [2, { vertices, revision: 0 }]]);
  const overlay = new BreakingOverlay({ getState: (...pos) => states.get(pos.join(',')) ?? 0, atlas: atlas(), materials: new Map([[1, material()], [2, material(2)]]),
    getTemplate: id => mutable.get(id), limits: { vertices: 12, visible: 2 },
    uploadMesh(key, source) { sink.set(key, source.length / 14); count(); }, removeMesh(key) { sink.delete(key); count(); } });
  overlay.progress(1, [0, 0, 0], 1); overlay.progress(2, [1, 0, 0], 2); view(overlay);
  mutable.set(1, { vertices, revision: 1 }); mutable.set(2, { vertices: small, revision: 1 }); view(overlay, 1);
  assert.equal(peakVertices, 12); assert.equal(peakMeshes, 2);
  overlay.progress(1, [3, 0, 0], 1); states.set('3,0,0', 1); overlay.progress(2, [4, 0, 0], 2); states.set('4,0,0', 2); view(overlay, 2);
  assert.equal(peakMeshes, 2); assert.ok(peakVertices <= 12);
});

test('CRUMBLING specifies exact blend, color-only writes, native polygon bias and version fog', () => {
  assert.deepEqual(CRUMBLING_RENDER_STATE.blend.color, { operation: 'add', srcFactor: 'dst', dstFactor: 'src' });
  assert.deepEqual(CRUMBLING_RENDER_STATE.blend.alpha, { operation: 'add', srcFactor: 'one', dstFactor: 'zero' });
  assert.equal(CRUMBLING_RENDER_STATE.depthWriteEnabled, false); assert.equal(CRUMBLING_RENDER_STATE.depthBias, -10);
  assert.equal(CRUMBLING_RENDER_STATE.depthBiasSlopeScale, -1); assert.equal(crumblingRenderState('1.20.4').fog, false);
  assert.equal(crumblingRenderState('1.21.11').fog, true); assert.equal(crumblingRenderState('26.1').fog, true);
});
