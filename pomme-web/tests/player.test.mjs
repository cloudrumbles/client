import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';

// This fixture exposes the same native-coordinate query ABI as the WASM core.
// Its partial boxes deliberately differ from full blocks to exercise locomotion.
function fixture({ origin = [-32, -32], minY = -64, boxes = [], unloaded = new Set(), fluid = false } = {}) {
  const groundY = -20;
  return {
    world_origin_x: () => origin[0], world_origin_z: () => origin[1],
    world_width: () => 128, world_depth: () => 128, world_height: () => 384,
    world_min_y: () => minY, world_chunk_size: () => 16,
    world_column_loaded: (x, z) => !unloaded.has(`${x},${z}`),
    terrain_height: () => groundY,
    block_get: () => fluid ? 4127 : 0,
    block_flags: state => state === 4127 ? 4 : 0,
    collides_aabb: (x0, y0, z0, x1, y1, z1) => {
      if (x0 < origin[0] || z0 < origin[1] || x1 > origin[0] + 128 || z1 > origin[1] + 128 || y0 < groundY - 0.0001) return 1;
      return Number(boxes.some(([bx0, by0, bz0, bx1, by1, bz1]) =>
        x0 < bx1 - 0.0001 && x1 > bx0 + 0.0001 && y0 < by1 - 0.0001 && y1 > by0 + 0.0001 && z0 < bz1 - 0.0001 && z1 > bz0 + 0.0001));
    },
  };
}

function player(core = fixture(), position = [-8.5, -20, -8.5]) {
  const result = new Player(core);
  result.setPosition(position);
  return result;
}

function advance(subject, seconds, frameRate, keys = new Set()) {
  for (let frame = 0; frame < Math.round(seconds * frameRate); frame++) subject.update(1 / frameRate, keys);
}

test('native negative coordinates remain valid and movement is independent of display frame rate', () => {
  const keys = new Set(['KeyW']);
  const sixty = player(), oneFortyFour = player(), twenty = player();
  advance(sixty, 2, 60, keys); advance(oneFortyFour, 2, 144, keys); advance(twenty, 2, 20, keys);
  assert.deepEqual(sixty.position, oneFortyFour.position);
  assert.deepEqual(sixty.position, twenty.position);
  assert.equal(sixty.position[0], -8.5);
  assert.ok(sixty.position[2] < -16, 'can walk across zero-based demo limits');
  assert.ok(Math.abs(sixty.position[1] + 20) < 0.001, 'feet stay on negative-height terrain');
  assert.equal(sixty.grounded, true);
});

test('walk, sprint, sneak and jump use the Minecraft 20 Hz acceleration and gravity scale', () => {
  const walk = player(), sprint = player(), sneak = player();
  const start = walk.position[2];
  advance(walk, 2, 60, new Set(['KeyW']));
  advance(sprint, 2, 60, new Set(['KeyW', 'ControlLeft']));
  advance(sneak, 2, 60, new Set(['KeyW', 'ShiftLeft']));
  const walkDistance = start - walk.position[2];
  assert.ok(walkDistance > 8 && walkDistance < 9);
  assert.ok(Math.abs((start - sprint.position[2]) / walkDistance - 1.3) < 0.01);
  assert.ok(Math.abs((start - sneak.position[2]) / walkDistance - 0.3) < 0.01);
  assert.equal(sneak.height, 1.5);
  const jump = player();
  let apex = jump.position[1];
  for (let tick = 0; tick < 20; tick++) { jump.update(0.05, tick === 0 ? new Set(['Space']) : new Set()); apex = Math.max(apex, jump.position[1]); }
  assert.ok(apex > -18.8 && apex < -18.7, `jump rises about 1.25 blocks: ${apex + 20}`);
  assert.ok(Math.abs(jump.position[1] + 20) < 0.001);
});

test('partial native collision boxes permit a half-slab step and prevent crossing a full block', () => {
  const slab = player(fixture({ boxes: [[-8.8, -20, -20, -8.2, -19.5, -9]] }));
  advance(slab, 1, 60, new Set(['KeyW']));
  assert.ok(slab.position[2] < -11, 'step-height sweep climbs the half slab');
  assert.ok(slab.position[1] >= -19.5001 && slab.position[1] <= -19.499, 'feet rest on the slab surface');
  const wall = player(fixture({ boxes: [[-8.8, -20, -12, -8.2, -19, -9]] }));
  advance(wall, 1, 60, new Set(['KeyW']));
  assert.ok(wall.position[2] >= -8.701, 'a full block exceeds automatic step height');
  assert.ok(Math.abs(wall.position[1] + 20) < 0.001);
});

test('swept collision stops fast fall on a thin shape without tunnelling', () => {
  const subject = player(fixture({ boxes: [[-9, -10.1, -9, -8, -10, -8]] }), [-8.5, -5, -8.5]);
  subject.verticalSpeed = -75;
  subject.update(0.1);
  assert.ok(subject.position[1] >= -10.0002 && subject.position[1] <= -9.999);
  assert.equal(subject.grounded, true);
});

test('native fluid flags work for arbitrary state IDs and flight bypasses fluid gravity', () => {
  const water = player(fixture({ fluid: true }), [-8.5, -10, -8.5]);
  advance(water, 1, 60, new Set(['Space']));
  assert.equal(water.submerged, true);
  assert.ok(water.position[1] > -8, 'liquid jump acceleration swims upward');
  const flight = player(fixture({ fluid: true }), [-8.5, -10, -8.5]);
  flight.fly = true;
  advance(flight, 0.5, 60, new Set(['Space']));
  assert.equal(flight.submerged, false);
  assert.ok(flight.position[1] > -7);
});

test('unloaded columns freeze physics and loaded-column boundaries block movement', () => {
  const unloaded = new Set(['-1,-1']);
  const subject = player(fixture({ unloaded }), [-8.5, -10, -8.5]);
  const initial = [...subject.position];
  advance(subject, 1, 60, new Set(['KeyW']));
  assert.deepEqual(subject.position, initial);
  assert.equal(subject.waitingForTerrain, true);
  unloaded.clear();
  subject.update(0.05);
  assert.equal(subject.waitingForTerrain, false);
  assert.ok(subject.verticalSpeed < 0, 'gravity resumes when authoritative terrain arrives');
  unloaded.add('-1,-2');
  const edge = player(fixture({ unloaded }), [-8.5, -20, -15.5]);
  advance(edge, 1, 60, new Set(['KeyW']));
  assert.ok(edge.position[2] >= -15.701, 'cannot step across into a missing column');
  assert.equal(edge.waitingForTerrain, false);
});

test('native bounds use the world origin and crouching waits for head clearance', () => {
  const subject = player(fixture({ boxes: [[-9, -18.45, -9, -8, -18.2, -8]] }));
  subject.height = 1.5;
  subject.update(0.05);
  assert.equal(subject.height, 1.5);
  assert.equal(subject.sneaking, true);
  assert.equal(subject.eye[1], subject.position[1] + 1.27);
  subject.setPosition([-31.5, -20, -8.5]);
  subject.yaw = -Math.PI / 2;
  advance(subject, 1, 60, new Set(['KeyW']));
  assert.ok(subject.position[0] >= -31.7002, 'window boundary is native x=-32 rather than x=0');
  assert.equal(subject.setPosition([NaN, 0, 0]), false);
});

test('render interpolation smooths fixed-tick movement while teleports take effect immediately', () => {
  const subject = player();
  subject.update(0.05, new Set(['KeyW']));
  const initialView = subject.renderPosition;
  assert.ok(initialView[2] > subject.position[2], 'camera interpolates the preceding tick');
  subject.update(0.025, new Set(['KeyW']));
  assert.ok(subject.renderPosition[2] < initialView[2] && subject.renderPosition[2] > subject.position[2]);
  subject.setPosition([-20, -10, -20]);
  assert.deepEqual(subject.renderPosition, [-20, -10, -20]);
});

test('actual WASM resolves imported slab collisions and preserves negative-height locomotion', async () => {
  const { readFile } = await import('node:fs/promises');
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/core.wasm', import.meta.url)), {});
  const core = instance.exports;
  assert.equal(core.world_reset(-64, 384, -2, -2, 4, 4), 1);
  assert.equal(core.block_register(500, 0.8, 0.8, 0.8, 1), 1);
  const ptr = core.world_float_stage_ptr();
  new Float32Array(core.memory.buffer, ptr, 6).set([0, 0, 0, 1, 0.5, 1]);
  assert.equal(core.block_collision_register(500, ptr, 1), 1);
  const ground = new Uint16Array(4096);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) ground[(11 * 16 + z) * 16 + x] = 1;
  for (let z = -2; z < 2; z++) for (let x = -2; x < 2; x++) {
    const stage = core.world_stage_ptr();
    new Uint16Array(core.memory.buffer, stage, 4096).set(ground);
    assert.equal(core.world_load_section(x, -2, z, stage, 4096), 1);
  }
  for (let z = -16; z <= -10; z++) assert.equal(core.block_set(-9, -20, z, 500), 1);
  const subject = player(core);
  advance(subject, 1, 60, new Set(['KeyW']));
  assert.ok(subject.position[2] < -11, 'walking climbs an actual staged Minecraft collision box');
  assert.ok(Math.abs(subject.position[1] + 19.5) < 0.002, 'WASM collision clips to native slab surface');
  assert.equal(subject.grounded, true);
  assert.equal(subject.waitingForTerrain, false);
});

test('server hunger, movement effects and flight abilities modify locomotion through explicit hooks', () => {
  const hungry = player(), normal = player(), faster = player();
  hungry.canSprint = false;
  faster.movementMultiplier = 1.2;
  advance(hungry, 1, 60, new Set(['KeyW', 'ControlLeft']));
  advance(normal, 1, 60, new Set(['KeyW']));
  advance(faster, 1, 60, new Set(['KeyW']));
  assert.deepEqual(hungry.position, normal.position, 'low food prevents the sprint modifier');
  assert.ok(Math.abs((-8.5 - faster.position[2]) / (-8.5 - normal.position[2]) - 1.2) < 0.01);
  const flight = player(fixture(), [-8.5, -10, -8.5]), fastFlight = player(fixture(), [-8.5, -10, -8.5]);
  flight.fly = fastFlight.fly = true;
  fastFlight.flyingSpeed = 0.1;
  advance(flight, 0.5, 60, new Set(['Space', 'KeyW']));
  advance(fastFlight, 0.5, 60, new Set(['Space', 'KeyW']));
  assert.ok(Math.abs((fastFlight.position[1] + 10) / (flight.position[1] + 10) - 2) < 0.01);
});
