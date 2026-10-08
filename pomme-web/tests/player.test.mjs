import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { vehicleStateFromEntity } from '../src/vehicle.js';

// This fixture exposes the same native-coordinate query ABI as the WASM core.
// Its partial boxes deliberately differ from full blocks to exercise locomotion.
function fixture({ origin = [-32, -32], minY = -64, boxes = [], unloaded = new Set(), fluid = false, blockAt = null, flags = null } = {}) {
  const groundY = -20;
  return {
    world_origin_x: () => origin[0], world_origin_z: () => origin[1],
    world_width: () => 128, world_depth: () => 128, world_height: () => 384,
    world_min_y: () => minY, world_chunk_size: () => 16,
    world_column_loaded: (x, z) => !unloaded.has(`${x},${z}`),
    terrain_height: () => groundY,
    block_get: (x, y, z) => blockAt ? blockAt(x, y, z) : fluid ? 4127 : 0,
    block_flags: state => flags ? flags(state) : state === 4127 ? 4 : 0,
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

const nativeMaterials = new Map([
  [0, { name: 'air', flags: 0, collisionBoxes: [], properties: {} }],
  [1, { name: 'stone', flags: 3, collisionBoxes: [[0, 0, 0, 1, 1, 1]], properties: {} }],
  [2, { name: 'ice', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]], properties: {} }],
  [3, { name: 'water', flags: 4, collisionBoxes: [], properties: { level: '0' } }],
  [4, { name: 'lava', flags: 4, collisionBoxes: [], properties: { level: '0' } }],
  [5, { name: 'ladder', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 0.125]], properties: { facing: 'north' } }],
  [6, { name: 'vine', flags: 0, collisionBoxes: [], properties: {} }],
  [7, { name: 'scaffolding', flags: 1, collisionBoxes: [], properties: {} }],
  [8, { name: 'honey_block', flags: 1, collisionBoxes: [[0.0625, 0, 0.0625, 0.9375, 0.9375, 0.9375]], properties: {} }],
  [9, { name: 'slime_block', flags: 3, collisionBoxes: [[0, 0, 0, 1, 1, 1]], properties: {} }],
  [10, { name: 'soul_sand', flags: 1, collisionBoxes: [[0, 0, 0, 1, 0.875, 1]], properties: {} }],
  [11, { name: 'oak_trapdoor', flags: 1, collisionBoxes: [], properties: { facing: 'north', open: 'true' } }],
  [12, { name: 'oak_trapdoor', flags: 1, collisionBoxes: [], properties: { facing: 'east', open: 'true' } }],
  [13, { name: 'water', flags: 4, collisionBoxes: [], properties: { level: '7' } }],
  [14, { name: 'water', flags: 4, collisionBoxes: [], properties: { level: '1' } }],
  [15, { name: 'water', flags: 4, collisionBoxes: [], properties: { level: '8' } }],
  [16, { name: 'cobweb', flags: 0, collisionBoxes: [], properties: {} }],
  [17, { name: 'sweet_berry_bush', flags: 0, collisionBoxes: [], properties: { age: '3' } }],
  [18, { name: 'powder_snow', flags: 0, collisionBoxes: [], properties: {} }],
  [19, { name: 'bubble_column', flags: 4, collisionBoxes: [], properties: { drag: 'false' } }],
  [20, { name: 'bubble_column', flags: 4, collisionBoxes: [], properties: { drag: 'true' } }],
]);
function nativePlayer({ blockAt = (x, y) => y < -20 ? 1 : 0, position, boxes = [] } = {}) {
  const subject = player(fixture({ blockAt, boxes, flags: id => nativeMaterials.get(id)?.flags ?? 0 }), position);
  subject.setMaterials({ materials: nativeMaterials });
  return subject;
}

test('ground slipperiness changes acceleration and preserves ice momentum after input stops', () => {
  const stone = nativePlayer(), ice = nativePlayer({ blockAt: (x, y) => y < -20 ? 2 : 0 });
  stone.velocity[0] = ice.velocity[0] = 10;
  advance(stone, 0.5, 20); advance(ice, 0.5, 20);
  assert.ok(ice.position[0] - -8.5 > (stone.position[0] - -8.5) * 2.5, 'ice retains the native 0.98 × 0.91 drag');
  const stoneStart = nativePlayer(), iceStart = nativePlayer({ blockAt: (x, y) => y < -20 ? 2 : 0 });
  stoneStart.tick(new Set(['KeyW'])); iceStart.tick(new Set(['KeyW']));
  assert.ok(Math.abs((-8.5 - iceStart.position[2]) / (-8.5 - stoneStart.position[2]) - (0.6 / 0.98) ** 3) < 1e-10, 'ground acceleration scales with friction cubed');
});

test('honey reduces jump impulse and soul sand slows horizontal travel without affecting ordinary terrain', () => {
  const honey = nativePlayer({ blockAt: (x, y) => y < -20 ? 8 : 0 });
  let apex = honey.position[1];
  for (let tick = 0; tick < 20; tick++) { honey.tick(tick ? new Set() : new Set(['Space'])); apex = Math.max(apex, honey.position[1]); }
  assert.ok(apex + 20 > 0.3 && apex + 20 < 0.4, `half-strength honey jump rises ${apex + 20}`);
  const stone = nativePlayer(), soul = nativePlayer({ blockAt: (x, y) => y < -20 ? 10 : 0 }), enchanted = nativePlayer({ blockAt: (x, y) => y < -20 ? 10 : 0 });
  enchanted.setEquipment({ soulSpeed: 1 });
  advance(stone, 1, 20, new Set(['KeyW'])); advance(soul, 1, 20, new Set(['KeyW'])); advance(enchanted, 1, 20, new Set(['KeyW']));
  assert.ok((-8.5 - soul.position[2]) < (-8.5 - stone.position[2]) * 0.65);
  assert.deepEqual(enchanted.position, stone.position, 'soul-speed equipment removes the sand slowdown; attribute packet supplies its speed modifier');
});

test('landing on slime restores downward momentum upward unless sneaking suppresses the bounce', () => {
  const bounce = nativePlayer({ blockAt: (x, y) => y < -20 ? 9 : 0, position: [-8.5, -18, -8.5] });
  const sneak = nativePlayer({ blockAt: (x, y) => y < -20 ? 9 : 0, position: [-8.5, -18, -8.5] });
  bounce.velocity[1] = sneak.velocity[1] = -20;
  advance(bounce, 0.2, 20); advance(sneak, 0.2, 20, new Set(['ShiftLeft']));
  assert.ok(bounce.velocity[1] > 15 && bounce.position[1] > -19.5, 'slime returns the impact speed instead of losing it in collision clipping');
  assert.ok(Math.abs(sneak.position[1] + 20) < 0.001 && sneak.velocity[1] < 0, 'sneaking lands normally');
});

test('ladders and vines cap falling speed, permit jump climbing, and sneaking holds their height', () => {
  for (const id of [5, 6]) {
    const climbing = nativePlayer({ blockAt: () => id, position: [-8.5, -10, -8.5] });
    climbing.velocity[1] = -30;
    climbing.tick(new Set());
    assert.equal(climbing.climbing, true);
    assert.ok(Math.abs(climbing.position[1] + 10.15) < 1e-10);
    advance(climbing, 0.5, 20, new Set(['ShiftLeft']));
    assert.ok(Math.abs(climbing.position[1] + 10.15) < 1e-10, 'sneaking cancels sliding before collision and gravity');
    const rising = nativePlayer({ blockAt: () => id, position: [-8.5, -10, -8.5] });
    advance(rising, 0.5, 20, new Set(['Space']));
    assert.ok(rising.position[1] > -9);
    assert.equal(rising.fallDistance, 0);
  }
  const scaffold = nativePlayer({ blockAt: () => 7, position: [-8.5, -10, -8.5] });
  advance(scaffold, 0.5, 20, new Set(['ShiftLeft']));
  assert.ok(scaffold.position[1] < -10.5, 'scaffolding allows downward sneaking');
});

test('an open trapdoor continues a ladder only when the ladder below faces the same way', () => {
  const matching = nativePlayer({ blockAt: (x, y) => y === -10 ? 11 : 5, position: [-8.5, -10, -8.5] });
  const opposite = nativePlayer({ blockAt: (x, y) => y === -10 ? 12 : 5, position: [-8.5, -10, -8.5] });
  matching.tick(new Set(['Space'])); opposite.tick(new Set(['Space']));
  assert.equal(matching.climbing, true); assert.equal(opposite.climbing, false);
  assert.ok(matching.velocity[1] > 0 && opposite.velocity[1] < 0);
});

test('native fluid levels distinguish shallow contact from lava and underwater swimming poses', () => {
  const shallow = nativePlayer({ blockAt: (x, y) => y === -10 ? 13 : 0, position: [-8.5, -9.8, -8.5] });
  shallow.tick(new Set()); assert.equal(shallow.submerged, false);
  shallow.setPosition([-8.5, -9.95, -8.5]); shallow.tick(new Set());
  assert.equal(shallow.fluid, 'water'); assert.ok(shallow.fluidHeight < 0.07 && shallow.fluidHeight > 0.06);
  const water = nativePlayer({ blockAt: () => 3, position: [-8.5, -10, -8.5] });
  const lava = nativePlayer({ blockAt: () => 4, position: [-8.5, -10, -8.5] });
  water.velocity[0] = lava.velocity[0] = 10;
  water.tick(new Set()); lava.tick(new Set());
  assert.equal(water.fluid, 'water'); assert.equal(lava.fluid, 'lava');
  assert.equal(water.velocity[0], 8); assert.equal(lava.velocity[0], 5);
  assert.ok(lava.velocity[1] < water.velocity[1], 'lava uses gravity/4 after its depth-dependent drag');
  water.tick(new Set(['KeyW', 'ControlLeft']));
  assert.equal(water.pose, 'swimming'); assert.equal(water.height, 0.6); assert.equal(water.eyeHeight, 0.4);
});

test('submerged native plants provide water drag while waterlogged slabs retain solid support', () => {
  for (const name of ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']) {
    const material = { name: `minecraft:${name}`, flags: 16 | 32, collisionBoxes: [],
      properties: {}, fluid: { kind: 1, level: 0, stillTile: -1, flowTile: -1 } };
    const subject = player(fixture({ blockAt: () => 700, flags: id => id === 700 ? material.flags : 0 }), [-8.5, -10, -8.5]);
    subject.setMaterials(new Map([[700, material]])); subject.velocity[0] = 10;
    subject.tick(new Set());
    assert.equal(subject.fluid, 'water', name); assert.equal(subject.velocity[0], 8, name);
    assert.equal(subject.grounded, false, name);
  }
  const slab = { name: 'minecraft:oak_slab', flags: 1 | 16, collisionBoxes: [[0, 0, 0, 1, .5, 1]],
    properties: { type: 'bottom', waterlogged: 'true' }, fluid: { kind: 1, level: 0 } };
  const subject = player(fixture({ blockAt: (x, y, z) => x === -9 && y === -10 && z === -9 ? 701 : 0,
    flags: id => id === 701 ? slab.flags : 0, boxes: [[-9, -10, -9, -8, -9.5, -8]] }), [-8.5, -9.5, -8.5]);
  subject.setMaterials(new Map([[701, slab]]));
  for (let tick = 0; tick < 10; tick++) subject.tick(new Set());
  assert.equal(subject.fluid, 'water'); assert.equal(subject.grounded, true);
  assert.ok(subject.position[1] >= -9.5001 && subject.position[1] < -9.499);
});

test('flowing water pushes toward a lower native level and uniform source water has no artificial drift', () => {
  const source = nativePlayer({ blockAt: () => 3, position: [-8.5, -10, -8.5] });
  source.tick(new Set()); assert.equal(source.velocity[0], 0); assert.equal(source.velocity[2], 0);
  const flowing = nativePlayer({ blockAt: (x) => x === -8 ? 14 : 3, position: [-8.5, -10, -8.5] });
  flowing.tick(new Set()); assert.ok(Math.abs(flowing.position[0] + 8.5 - 0.014) < 1e-10 && Math.abs(flowing.velocity[0] - 0.224) < 1e-10);
});

test('levitation, slow falling and jump boost use zero-based server effect IDs and expire at 20 Hz', () => {
  const ordinary = nativePlayer({ position: [-8.5, -10, -8.5] }), slow = nativePlayer({ position: [-8.5, -10, -8.5] }), levitating = nativePlayer({ position: [-8.5, -10, -8.5] });
  slow.setEffects([{ id: 27, amplifier: 0, duration: 200 }]);
  levitating.setEffects(new Map([[24, { amplifier: 1, duration: 200 }]]));
  advance(ordinary, 0.5, 20); advance(slow, 0.5, 20); advance(levitating, 0.5, 20);
  assert.ok(slow.position[1] > ordinary.position[1] + 2);
  assert.ok(levitating.position[1] > -9.5 && levitating.velocity[1] > 1.5);
  const jump = nativePlayer(); jump.setEffects([{ id: 7, amplifier: 1, duration: 1 }]);
  jump.tick(new Set(['Space'])); assert.ok(Math.abs(jump.position[1] + 20 - 0.62) < 1e-10);
  assert.equal(jump.effectLevel('jump_boost'), 0);
  jump.setEffects([{ id: 7, amplifier: 1, duration: 1 }]);
  assert.equal(jump.effectLevel('jump_boost'), 0, 'unchanged stale state snapshots cannot renew an expired effect');
});

test('dolphin grace and depth strider improve water movement using the imported equipment and effect hooks', () => {
  const water = nativePlayer({ blockAt: () => 3, position: [-8.5, -10, -8.5] }), dolphin = nativePlayer({ blockAt: () => 3, position: [-8.5, -10, -8.5] }), boots = nativePlayer({ blockAt: () => 3, position: [-8.5, -10, -8.5] });
  dolphin.setEffects({ dolphins_grace: 0 }); boots.setEquipment({ depthStrider: 3 });
  advance(water, 1, 20, new Set(['KeyW'])); advance(dolphin, 1, 20, new Set(['KeyW'])); advance(boots, 1, 20, new Set(['KeyW']));
  assert.ok((-8.5 - dolphin.position[2]) > (-8.5 - water.position[2]) * 2);
  assert.ok((-8.5 - boots.position[2]) > (-8.5 - water.position[2]) * 2);
});

test('swimming pose can remain crawling after water when an imported low tunnel blocks standing', () => {
  const subject = nativePlayer({ boxes: [[-9, -19.25, -9, -8, -18, -8]] });
  subject.height = 0.6; subject.tick(new Set());
  assert.equal(subject.pose, 'crawling'); assert.equal(subject.height, 0.6);
  subject.setPosition([-10.5, -20, -8.5]); subject.tick(new Set());
  assert.equal(subject.pose, 'standing'); assert.equal(subject.height, 1.8);
});

test('actual WASM scaffolding uses one-way contextual platforms instead of its static model outline', async () => {
  const { readFile } = await import('node:fs/promises');
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/core.wasm', import.meta.url)), {});
  const core = instance.exports;
  assert.equal(core.world_reset(-64, 384, -2, -2, 4, 4), 1);
  assert.equal(core.block_register(700, 0.8, 0.7, 0.4, 1), 1);
  const boxes = [[0, 0, 0, 0.125, 1, 0.125], [0.875, 0, 0.875, 1, 1, 1], [0, 0.875, 0, 1, 1, 1]];
  const ptr = core.world_float_stage_ptr();
  new Float32Array(core.memory.buffer, ptr, boxes.length * 6).set(boxes.flat());
  assert.equal(core.block_collision_register(700, ptr, boxes.length), 1);
  const ground = new Uint16Array(4096);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) ground[(11 * 16 + z) * 16 + x] = 1;
  for (let z = -2; z < 2; z++) for (let x = -2; x < 2; x++) {
    const stage = core.world_stage_ptr();
    new Uint16Array(core.memory.buffer, stage, 4096).set(ground);
    assert.equal(core.world_load_section(x, -2, z, stage, 4096), 1);
  }
  for (let y = -20; y < -10; y++) assert.equal(core.block_set(-9, y, -9, 700), 1);
  const materials = new Map([...nativeMaterials, [700, { name: 'scaffolding', flags: 1, collisionBoxes: boxes, properties: { distance: '0', bottom: 'false' } }]]);
  const subject = player(core, [-8.5, -10, -8.5]); subject.setMaterials(materials);
  advance(subject, 0.5, 20);
  assert.ok(Math.abs(subject.position[1] + 10) < 0.002, 'can stand on the top of the imported scaffold');
  advance(subject, 0.5, 20, new Set(['ShiftLeft']));
  assert.ok(subject.position[1] < -10.5, 'sneaking passes down through the top platform');
  subject.setPosition([-8.5, -20, -8.5]);
  advance(subject, 1, 20, new Set(['Space']));
  assert.ok(subject.position[1] > -18, 'jumping climbs through successive static outline tops');
  assert.equal(subject.climbing, true);
});

test('honey side contact limits slide speed and resets accumulated fall distance', () => {
  const subject = nativePlayer({ blockAt: (x, y, z) => x === -9 && z === -9 ? 8 : 0, position: [-7.755, -10.2, -8.5] });
  subject.velocity = [-0.1, -20, 0]; subject.fallDistance = 4;
  subject.tick(new Set());
  assert.ok(Math.abs(subject.position[1] + 11.2) < 1e-10, 'Entity.move checks inside-block effects after collision movement');
  assert.ok(subject.velocity[1] > -2.6 && subject.velocity[1] < -2.5);
  assert.ok(Math.abs(subject.velocity[0]) < 0.01, 'fast-fall wall sliding removes most horizontal momentum');
  assert.equal(subject.fallDistance, 0);
  const y = subject.position[1]; subject.tick(new Set());
  assert.ok(Math.abs(subject.position[1] - y) < 0.13, 'subsequent movement uses the honey-limited velocity followed by land gravity');
});

test('elytra flight follows the original 1.20.4 lift and drag equations without walking acceleration', () => {
  const subject = nativePlayer({ position: [-8.5, -5, -8.5] });
  const commands = []; subject.onFallFlyingChange = value => commands.push(value);
  subject.setEquipment({ elytra: true }); subject.pitch = 0; subject.velocity = [0, 0, -20];
  subject.tick(new Set(['Space', 'KeyW']));
  assert.equal(subject.fallFlying, true); assert.equal(subject.pose, 'fall_flying');
  assert.deepEqual(commands, [true], 'a fresh airborne jump begins one server fall-flight command');
  assert.ok(Math.abs(subject.velocity[1] - (-0.018 * Math.fround(0.98) * 20)) < 1e-10);
  assert.ok(Math.abs(subject.velocity[2] - (-1.0018 * Math.fround(0.99) * 20)) < 1e-10);
  assert.equal(subject.height, 0.6); assert.equal(subject.fallFlyTicks, 1);
  subject.tick(new Set(['Space'])); assert.deepEqual(commands, [true], 'holding Space does not send repeated commands');
  const ordinary = nativePlayer({ position: [-8.5, -5, -8.5] }); ordinary.velocity = [0, 0, -20]; ordinary.tick(new Set());
  assert.ok(subject.velocity[1] > ordinary.velocity[1], 'elytra reduces the descent through directional lift');
});

test('elytra pitch converts horizontal speed into height and remains independent of display frame rate', () => {
  const sixty = nativePlayer({ position: [8.5, 80, 50] }), highRate = nativePlayer({ position: [8.5, 80, 50] });
  for (const subject of [sixty, highRate]) { subject.setEquipment({ elytra: true }); subject.setFallFlying(true); subject.pitch = 0.5; subject.velocity = [0, -2, -25]; }
  advance(sixty, 2, 60); advance(highRate, 2, 144);
  assert.deepEqual(sixty.position, highRate.position); assert.deepEqual(sixty.velocity, highRate.velocity);
  assert.ok(sixty.position[1] > 80, 'looking upward trades horizontal momentum for height');
  assert.ok(Math.abs(sixty.velocity[2]) < 25, 'climb loses horizontal speed');
  const grounded = nativePlayer(); grounded.setEquipment({ elytra: true });
  assert.equal(grounded.startFallFlying(), false, 'elytra cannot begin while standing on a block');
  const levitating = nativePlayer({ position: [-8.5, -10, -8.5] }); levitating.setEquipment({ elytra: true }); levitating.setEffects({ levitation: 0 });
  assert.equal(levitating.startFallFlying(), false);
});

test('dynamic native collision boxes stop player motion on moving pistons and extended shulker lids', () => {
  const subject = nativePlayer({ position: [-8.5, -5, -8.5] });
  let boxes = [[-9, -10.1, -9, -8, -10, -8]];
  subject.setCollisionProvider(bounds => { assert.equal(bounds.length, 6); return boxes; });
  subject.verticalSpeed = -75; subject.update(0.1);
  assert.ok(subject.position[1] >= -10.0005 && subject.position[1] <= -9.999, 'sweep clips to an external animated collision surface');
  assert.equal(subject.grounded, true);
  boxes = []; subject.update(0.1);
  assert.equal(subject.grounded, false, 'removing a dynamic lid releases support on the next tick');
});

test('boat prediction uses sourced buoyancy, paddle acceleration and passenger attachment coordinates', () => {
  const subject = nativePlayer({ blockAt: (x, y) => y < -10 ? 3 : 0, position: [-8.5, -10.4, -8.5] });
  const packets = []; subject.onVehicleMove = state => packets.push(state);
  subject.setVehicle({ id: 42, type: 'boat', position: [-8.5, -10.4, -8.5], yaw: 0, controlled: true });
  advance(subject, 1, 20, new Set(['KeyW']));
  assert.equal(subject.pose, 'sitting'); assert.equal(subject.vehicle.status, 'in_water');
  assert.ok(subject.vehicle.position[2] < -12.5, 'rowing predicts actual boat motion');
  assert.ok(subject.vehicle.position[1] > -10.6 && subject.vehicle.position[1] < -10.3, 'boat floats near its sourced buoyancy equilibrium');
  assert.equal(packets.length, 20); assert.deepEqual(packets.at(-1).paddles, [true, true]);
  assert.ok(Math.abs(subject.position[1] - subject.vehicle.position[1] - (0.1875 - Math.fround(0.6))) < 1e-10);
  const before = subject.vehicle.yaw;
  advance(subject, 0.5, 20, new Set(['KeyD']));
  assert.ok(subject.vehicle.yaw > before); assert.deepEqual(packets.at(-1).paddles, [true, false]);
  assert.equal(subject.startFallFlying(), false, 'riding blocks elytra startup');
});

test('mounted minecart movement follows server authority and sends steer inputs without walking out of its seat', () => {
  const subject = nativePlayer(); const inputs = [];
  subject.onVehicleMove = state => inputs.push(state.input);
  subject.setVehicle({ id: 8, type: 'minecart', position: [-8.5, -10, -8.5], yaw: 0, controlled: true });
  const start = [...subject.position]; advance(subject, 0.5, 20, new Set(['KeyW']));
  assert.deepEqual(subject.position, start); assert.equal(subject.vehicle.controlled, false);
  assert.equal(inputs.at(-1).forward, 1);
  subject.setVehicle({ id: 8, position: [-10, -9, -12], yaw: 0.4 }); subject.tick(new Set(['ShiftLeft']));
  assert.equal(subject.position[0], -10); assert.equal(subject.position[2], -12);
  assert.ok(Math.abs(subject.position[1] - (-9 + 0.1875 - Math.fround(0.6))) < 1e-10);
  assert.equal(inputs.at(-1).unmount, true);
  subject.setVehicle(null); assert.equal(subject.vehicle, null);
});

test('saddled horse prediction honors server movement attributes and sends the original charged-jump strength', () => {
  const subject = nativePlayer(), walk = nativePlayer(); const jumps = [];
  subject.onVehicleJump = state => jumps.push(state);
  subject.setVehicle({ id: 25, type: 'horse', position: [-8.5, -20, -8.5], controlled: true, movementSpeed: 0.225, jumpStrength: 0.7 });
  advance(subject, 1, 20, new Set(['KeyW'])); advance(walk, 1, 20, new Set(['KeyW']));
  assert.ok((-8.5 - subject.vehicle.position[2]) > (-8.5 - walk.position[2]) * 2);
  assert.ok(Math.abs(subject.position[1] - subject.vehicle.position[1] - (1.6 - 0.15625 - Math.fround(0.6))) < 1e-10);
  for (let tick = 0; tick < 11; tick++) subject.tick(new Set(['Space']));
  subject.tick(new Set());
  assert.deepEqual(jumps, [{ id: 25, power: 100 }]);
  assert.ok(subject.vehicle.velocity[1] > 12 && subject.vehicle.position[1] > -19.4, 'full charge applies the server horse jump-strength attribute');
  const strafe = nativePlayer(); strafe.setVehicle({ id: 26, type: 'horse', position: [-8.5, -20, -8.5], controlled: true });
  strafe.tick(new Set(['KeyA'])); assert.ok(strafe.vehicle.position[0] < -8.5, 'rider left input keeps the native protocol sign and world direction');
});

test('boat prediction uses the full hull width for imported collision and freezes at unloaded terrain', () => {
  const subject = nativePlayer({ boxes: [[-9.5, -20, -12, -7.5, -18, -10]] });
  subject.setVehicle({ id: 44, type: 'chest_boat', position: [-8.5, -20, -8.5], controlled: true });
  advance(subject, 1, 20, new Set(['KeyW']));
  assert.ok(subject.vehicle.position[2] >= -9.313, '1.375-block hull clips before the wall');
  const unloaded = new Set(['-1,-1']);
  const waiting = player(fixture({ unloaded }), [-8.5, -10, -8.5]);
  waiting.setVehicle({ id: 45, type: 'boat', position: [-8.5, -10, -8.5], controlled: true });
  const before = [...waiting.vehicle.position]; advance(waiting, 1, 20, new Set(['KeyW']));
  assert.deepEqual(waiting.vehicle.position, before); assert.equal(waiting.waitingForTerrain, true);
});

test('cobweb and berry bushes apply their original next-move stuck multipliers and clear momentum', () => {
  const web = nativePlayer({ blockAt: () => 16, position: [-8.5, -10, -8.5] });
  web.tick(new Set()); web.velocity = [10, -10, 0];
  const before = [...web.position]; web.tick(new Set());
  assert.ok(Math.abs(web.position[0] - before[0] - 0.125) < 1e-10);
  assert.ok(Math.abs(web.position[1] - before[1] + 0.5 * Math.fround(0.05)) < 1e-10);
  assert.equal(web.velocity[0], 0, 'stuck displacement cannot carry old momentum into later ticks');
  const berry = nativePlayer({ blockAt: () => 17, position: [-8.5, -10, -8.5] });
  berry.tick(new Set()); berry.velocity = [10, 0, 0]; const x = berry.position[0]; berry.tick(new Set());
  assert.ok(Math.abs(berry.position[0] - x - 0.5 * Math.fround(0.8)) < 1e-10);
});

test('powder snow gives leather boots a contextual platform while other players sink into its stuck region', () => {
  const blockAt = (x, y) => y === -11 ? 18 : y < -20 ? 1 : 0;
  const boots = nativePlayer({ blockAt, position: [-8.5, -10, -8.5] }), bare = nativePlayer({ blockAt, position: [-8.5, -10, -8.5] });
  boots.setEquipment({ leatherBoots: true });
  advance(boots, 0.5, 20); advance(bare, 0.5, 20);
  assert.ok(Math.abs(boots.position[1] + 10) < 0.001);
  assert.ok(bare.position[1] < -10.2 && bare.inPowderSnow, 'ordinary footwear has no static snow collision');
  advance(boots, 0.5, 20, new Set(['ShiftLeft'])); assert.ok(boots.position[1] < -10.2, 'descending ignores the leather-boot platform');
});

test('bubble columns lift or pull players using server native drag properties', () => {
  const upward = nativePlayer({ blockAt: () => 19, position: [-8.5, -10, -8.5] });
  const downward = nativePlayer({ blockAt: () => 20, position: [-8.5, -10, -8.5] });
  advance(upward, 0.5, 20); advance(downward, 0.5, 20);
  assert.ok(upward.position[1] > -8.5 && upward.velocity[1] > 3);
  assert.ok(downward.position[1] < -10.8 && downward.velocity[1] < -3);
  assert.equal(upward.fallDistance, 0);
});

test('attached firework rockets apply the original directional boost only during elytra flight', () => {
  const subject = nativePlayer({ position: [-8.5, -5, -8.5] }); subject.pitch = 0; subject.velocity = [0, 0, -20];
  assert.equal(subject.applyFireworkBoost(), false);
  subject.setFallFlying(true); assert.equal(subject.applyFireworkBoost(), true);
  assert.deepEqual(subject.velocity, [0, 0, -27]);
  subject.setFireworkBoost(true); subject.tick(new Set());
  assert.ok(subject.velocity[2] < -30, 'server attachment hook keeps boosting while the rocket remains active');
});

test('server vehicle metadata uses generated field names, sourced saddle bit, wire yaw conversion and attribute modifiers', () => {
  const registry = { entities: [{ id: 50, name: 'horse', width: 1.3964844, height: 1.6, metadataKeys: ['pose', 'baby', 'flags', 'no_gravity'] }, { id: 9, name: 'boat', width: 1.375, height: 0.5625, metadataKeys: ['type'] }] };
  const entity = { id: 2, entityType: 50, x: -9, y: 64, z: 4, yaw: Math.PI, passengers: [5], metadata: [{ key: 2, value: 4 | 32 }], attributes: [{ name: 'minecraft:generic.movement_speed', value: 0.2, modifiers: [{ amount: 0.05, operation: 0 }, { amount: 0.2, operation: 1 }, { amount: 0.5, operation: 2 }] }] };
  const state = vehicleStateFromEntity(entity, registry, 5);
  assert.equal(state.controlled, true); assert.equal(state.saddled, true); assert.equal(state.standing, true);
  assert.equal(state.yaw, 0, 'wire south-zero heading becomes Player north-zero heading');
  assert.ok(Math.abs(state.movementSpeed - 0.45) < 1e-10);
  const otherRider = vehicleStateFromEntity({ ...entity, passengers: [6, 5] }, registry, 5);
  assert.equal(otherRider.controlled, false); assert.equal(otherRider.index, 1);
  const unsaddled = vehicleStateFromEntity({ ...entity, metadata: [] }, registry, 5);
  assert.equal(unsaddled.controlled, false);
  const raft = vehicleStateFromEntity({ ...entity, entityType: 9, metadata: [{ key: 0, value: 8 }] }, registry, 5);
  assert.equal(raft.variant, 8); assert.equal(raft.controlled, true);
});

test('pig and strider control requires the confirmed steering item and metadata boost changes native travel speed', () => {
  const registry = { entities: [{ id: 73, name: 'pig', width: 0.9, height: 0.9, metadataKeys: ['saddle', 'boost_time'] }, { id: 99, name: 'strider', width: 0.9, height: 1.7, metadataKeys: ['saddle', 'boost_time', 'suffocating'] }] };
  const entity = { id: 31, entityType: 73, x: -8.5, y: -20, z: -8.5, yaw: Math.PI, passengers: [5], metadata: [{ key: 0, value: true }] };
  assert.equal(vehicleStateFromEntity(entity, registry, 5).controlled, false);
  const state = vehicleStateFromEntity(entity, registry, 5, { heldItems: ['minecraft:carrot_on_a_stick'] });
  assert.equal(state.controlled, true); assert.equal(state.movementSpeed, 0.25);
  const pig = nativePlayer(), boosted = nativePlayer(); pig.setVehicle(state); boosted.setVehicle({ ...state, boostTime: 40 });
  advance(pig, 1, 20); advance(boosted, 1, 20);
  assert.ok(pig.vehicle.position[2] < -10, 'sourced pig ridden input always moves forward while steering item is held');
  assert.ok((-8.5 - boosted.vehicle.position[2]) > (-8.5 - pig.vehicle.position[2]) * 1.5);
  const strider = vehicleStateFromEntity({ ...entity, entityType: 99 }, registry, 5, { heldItems: ['carrot_on_a_stick'] });
  assert.equal(strider.controlled, false);
  assert.equal(vehicleStateFromEntity({ ...entity, entityType: 99 }, registry, 5, { heldItems: ['warped_fungus_on_a_stick'] }).controlled, true);
});

test('strider lava travel stands on the original half-block fluid platform and moves without lava drag', () => {
  const subject = nativePlayer({ blockAt: (x, y) => y === -11 ? 4 : 0, position: [-8.5, -10.5, -8.5] });
  subject.setVehicle({ id: 49, type: 'strider', position: [-8.5, -10.5, -8.5], controlled: true, width: 0.9, height: 1.7, movementSpeed: 0.175, cold: false });
  advance(subject, 1, 20);
  assert.ok(Math.abs(subject.vehicle.position[1] + 10.5) < 0.001, 'Strider canStandOnFluid uses LiquidBlock.STABLE_SHAPE height 0.5');
  assert.ok(subject.vehicle.position[2] < -12 && subject.vehicle.grounded);
});

test('camel charged dash uses original horizontal and vertical strength and a 55-tick cooldown', () => {
  const subject = nativePlayer(); const jumps = []; subject.onVehicleJump = state => jumps.push(state);
  subject.setVehicle({ id: 52, type: 'camel', position: [-8.5, -20, -8.5], controlled: true, width: 1.7, height: 2.375, movementSpeed: 0.09, jumpStrength: 0.42, poseTime: 100 });
  subject.yaw = 0;
  for (let tick = 0; tick < 11; tick++) subject.tick(new Set(['Space']));
  subject.tick(new Set());
  assert.deepEqual(jumps, [{ id: 52, power: 100 }]);
  assert.equal(subject.vehicle.dashCooldown, 55);
  assert.ok(subject.vehicle.position[2] < -10.49 && subject.vehicle.position[2] > -10.51, 'dash adds 22.2222 × 0.09 blocks of immediate movement');
  assert.ok(subject.vehicle.velocity[1] > 8.6 && subject.vehicle.velocity[1] < 8.7, 'camel adds its impulse to the preceding ground-gravity velocity');
  for (let tick = 0; tick < 11; tick++) subject.tick(new Set(['Space'])); subject.tick(new Set());
  assert.equal(jumps.length, 1, 'held jump cannot request a second dash during cooldown');
});

test('camel sitting and standing transitions preserve sourced passenger seat heights and suppress travel', () => {
  const registry = { entities: [{ id: 11, name: 'camel', width: 1.7, height: 2.375, metadataKeys: ['flags', 'last_pose_change_tick'] }] };
  const entity = { id: 55, entityType: 11, x: -8.5, y: -20, z: -8.5, yaw: Math.PI, passengers: [5, 6], metadata: [{ key: 0, value: 4 }, { key: 1, value: -100n }] };
  const sitting = vehicleStateFromEntity(entity, registry, 5, { worldAge: 150n });
  const subject = nativePlayer(); subject.setVehicle(sitting); subject.yaw = 0;
  assert.ok(Math.abs(subject.position[1] - (-20 + 2.375 - 1.43 - 0.375 + 0.2 - Math.fround(0.6))) < 1e-10);
  subject.tick(new Set(['KeyW']));
  assert.equal(subject.vehicle.camelSitting, false, 'forward input starts standing from an established seated pose');
  assert.equal(subject.vehicle.poseTime, 0); assert.equal(subject.vehicle.position[2], -8.5);
  assert.ok(Math.abs(subject.position[1] - (-20 + 2.375 - 0.375 + 0.2 - 1.43 - Math.fround(0.6))) < 1e-10);
  advance(subject, 1, 20, new Set(['KeyW'])); assert.equal(subject.vehicle.position[2], -8.5, 'cannot travel while standing animation remains in progress');
});

test('sleeping applies the original bed attachment, eye height and immobilized input until server wake', () => {
  const subject = nativePlayer(); let wakes = 0; subject.onWakeRequest = () => wakes++;
  subject.setSleeping(true, { position: [-9, -20, -9] });
  const position = [...subject.position];
  advance(subject, 0.5, 20, new Set(['KeyW', 'Space']));
  assert.deepEqual(subject.position, [-8.5, -19.3125, -8.5]); assert.deepEqual(subject.position, position);
  assert.equal(subject.eyeHeight, 0.2); assert.equal(subject.pose, 'sleeping'); assert.equal(wakes, 1);
  subject.setSleeping(false); assert.equal(subject.height, 1.8);
  subject.tick(new Set(['KeyW'])); assert.ok(subject.position[2] < position[2]);
});

test('creative flight touching the ground cancels through its explicit abilities callback and view pitch reaches both poles', () => {
  const subject = nativePlayer({ position: [-8.5, -19.8, -8.5] });
  const abilities = []; subject.onFlyingChange = value => abilities.push(value);
  subject.fly = true; subject.velocity[1] = -10; subject.tick(new Set());
  assert.equal(subject.fly, false); assert.equal(subject.grounded, true); assert.deepEqual(abilities, [false]);
  subject.look(0, 100000); assert.equal(subject.pitch, -Math.PI / 2);
  subject.look(0, -100000); assert.equal(subject.pitch, Math.PI / 2);
  const spectator = nativePlayer({ position: [-8.5, -19.8, -8.5] }); spectator.fly = true; spectator.noclip = true; spectator.velocity[1] = -10;
  spectator.tick(new Set()); assert.equal(spectator.fly, true, 'spectator noclip keeps flight when crossing ground');
});
