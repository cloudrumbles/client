import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Player } from '../src/player.js';
import { aabbAt, clipShapeAxis, clipShapeMovement, pistonMovementArea, shulkerMovementArea, restrictPistonMovement, blockMotionDisplacement, pistonBaseCorrection } from '../src/dynamic-collision.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('native shape clipping reaches thin faces exactly without a sampled sweep', () => {
  const bounds = [-.3, 2, -.3, .3, 3.8, .3], shapes = [[1.03125, 2, -.5, 1.046875, 4, .5], [-2, 2, -.5, -1.96875, 4, .5], [-.5, -3.03125, -.5, .5, -3, .5]];
  near(clipShapeAxis(bounds, shapes, 0, 100), .73125);
  near(clipShapeAxis(bounds, shapes, 0, -100), -1.66875);
  near(clipShapeAxis(bounds, shapes, 1, -100), -5);
  assert.equal(clipShapeAxis(bounds, shapes, 2, 3), 3, 'sideways movement alongside the shape is unobstructed');
  assert.equal(clipShapeAxis(bounds, shapes, 0, 1e-8), 0, 'matches VoxelShape.collideX tiny displacement cutoff');
});

test('native collision order resolves Y then the larger horizontal axis', () => {
  const bounds = [-.3, 1, -.3, .3, 2.8, .3], shapes = [[-.5, 0, -.5, .5, 1, .5], [1, 1, .75, 2, 3, 1.5]];
  assert.deepEqual(clipShapeMovement(bounds, shapes, [2, -1, .5]), [2, 0, .45], 'X first advances alongside the wall, then Z reaches its near face');
  assert.deepEqual(clipShapeMovement(bounds, shapes, [.5, -1, 2]), [.5, 0, 2], 'Z first walks around the corner rather than clipping X prematurely');
});

test('shape tangency and original 1e-7 gaps do not create phantom side walls', () => {
  const bounds = [0, 0, 0, 1, 1, 1];
  assert.equal(clipShapeAxis(bounds, [[2, 1, 0, 3, 2, 1]], 0, 4), 4, 'touching on Y is not a transverse overlap');
  assert.equal(clipShapeAxis(bounds, [[1 - 5e-8, 0, 0, 2, 1, 1]], 0, 1), -5.000000002919336e-8, 'native tolerance can correct a sub-epsilon face overlap');
  assert.equal(clipShapeAxis(bounds, [[.5, 0, 0, 1.5, 1, 1]], 0, 1), 1, 'a pre-existing overlap is allowed to escape');
});

test('all six piston sweep directions use only their advancing face', () => {
  const bounds = [3, -2, 5, 4, -1, 6];
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const direction = [0, 0, 0]; direction[axis] = sign;
    const actual = pistonMovementArea(bounds, direction, .5), expected = [...bounds];
    if (sign > 0) { expected[axis] = bounds[axis + 3]; expected[axis + 3] += .5; }
    else { expected[axis + 3] = bounds[axis]; expected[axis] -= .5; }
    assert.deepEqual(actual, expected);
  }
});

test('piston displacement cap is cumulative and signed across same-tick pushes', () => {
  assert.deepEqual(restrictPistonMovement(0, .51), { cumulative: .51, allowed: .51 });
  assert.deepEqual(restrictPistonMovement(.4, .51), { cumulative: .51, allowed: .10999999999999999 });
  assert.deepEqual(restrictPistonMovement(.51, .2), { cumulative: .51, allowed: 0 });
  assert.deepEqual(restrictPistonMovement(.51, -.5), { cumulative: .010000000000000009, allowed: -.5 });
});

test('slime launches occupants and honey carries grounded centers without pushing distant players', () => {
  const event = { kind: 'piston', position: [1, 2, 0], direction: [1, 0, 0], previousProgress: 0, currentProgress: .5, extending: true, boxes: [[0, 2, 0, 1, 3, 1]], materialName: 'minecraft:slime_block' };
  const push = blockMotionDisplacement(event, aabbAt([1.2, 2, .5], .3, 1.8));
  assert.equal(push.slime, true); near(push.distance, .51);
  const touchingBody = blockMotionDisplacement(event, aabbAt([.5, 2, .5], .3, 1.8));
  assert.equal(touchingBody.distance, 0, 'slime velocity applies to occupants, independent of the advancing face');
  const honey = { ...event, materialName: 'honey_block', boxes: [[.0625, 2, .0625, .9375, 2.9375, .9375]] };
  assert.equal(blockMotionDisplacement(honey, aabbAt([.5, 2.9375, .5], .3, 1.8), { grounded: true, position: [.5, 2.9375, .5] }).carry, true);
  assert.equal(blockMotionDisplacement(honey, aabbAt([.5, 2.9375, .5], .3, 1.8), { grounded: false, position: [.5, 2.9375, .5] }), null);
  assert.equal(blockMotionDisplacement(event, aabbAt([5, 2, .5], .3, 1.8)), null);
  const corner = aabbAt([1.1, 2.9375, .5], .3, 1.8);
  assert.equal(blockMotionDisplacement(honey, corner, { grounded: true, position: [1.1, 2.9375, .5] }), null, 'center outside the moved unit block fails its ordinary sticky criterion');
  assert.equal(blockMotionDisplacement(honey, corner, { grounded: true, position: [1.1, 2.9375, .5], supportedBy: true }).carry, true, 'native mainSupportingBlockPos carries a player standing over its corner');
});

test('shulker opening push follows full progress delta while closing never pushes', () => {
  const east = shulkerMovementArea([2, -4, 5], [1, 0, 0], .2, .3);
  assert.deepEqual(east, [3.2, -4, 5, 3.3, -3, 6]);
  const west = shulkerMovementArea([2, -4, 5], [-1, 0, 0], .2, .3);
  assert.deepEqual(west, [1.7, -4, 5, 1.8, -3, 6]);
  const event = { kind: 'shulker', position: [2, -4, 5], direction: [1, 0, 0], previousProgress: .2, currentProgress: .3 };
  near(blockMotionDisplacement(event, aabbAt([3.45, -4, 5.5], .3, 1.8)).distance, .11);
  assert.equal(blockMotionDisplacement({ ...event, previousProgress: .3, currentProgress: .2 }, aabbAt([3.45, -4, 5.5], .3, 1.8)), null);
});

test('retracting source pistons correct entities trapped entirely within their base', () => {
  const event = { kind: 'piston', position: [0, 0, 0], direction: [-1, 0, 0], previousProgress: 0, currentProgress: .5, source: true, extending: false };
  const correction = pistonBaseCorrection(event, [.1, .1, .1, .7, .9, .7]);
  assert.deepEqual(correction.direction, [1, -0, -0]); near(correction.distance, .51);
  assert.equal(pistonBaseCorrection({ ...event, extending: true }, [.1, .1, .1, .7, .9, .7]), null);
  assert.equal(pistonBaseCorrection(event, [-.5, .1, .1, .1, .9, .7]), null, 'does not reverse a player already extending through the opposite base face');
});

async function wasmPlayer({ wall = false } = {}) {
  const { instance } = await WebAssembly.instantiate(await readFile(new URL('../public/core.wasm', import.meta.url)), {}), core = instance.exports;
  core.world_reset(-64, 384, -1, -1, 2, 2); core.world_set_floor_collision(0);
  const materials = new Map([[0, { name: 'air', flags: 0, collisionBoxes: [] }], [1, { name: 'stone', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]] }], [500, { name: 'thin_test_plate', flags: 1, collisionBoxes: [[0, 0, 0, 1, .03125, 1]] }]]);
  core.block_register(500, .5, .5, .5, 1);
  const floats = core.world_float_stage_ptr(); new Float32Array(core.memory.buffer, floats, 6).set(materials.get(500).collisionBoxes[0]); core.block_collision_register(500, floats, 1);
  for (let x = -1; x < 1; x++) for (let z = -1; z < 1; z++) { const section = new Uint16Array(4096), ptr = core.world_stage_ptr(); for (let zz = 0; zz < 16; zz++) for (let xx = 0; xx < 16; xx++) section[xx + zz * 16] = 1; new Uint16Array(core.memory.buffer, ptr, 4096).set(section); core.world_load_section(x, 0, z, ptr, 4096); }
  if (wall) for (let y = 1; y < 4; y++) core.block_set(2, y, 0, 1);
  const player = new Player(core, { materials }); player.setPosition([1.2, 1, .5]); player.grounded = true;
  return { core, player, materials };
}

test('actual WASM material-backed clipping lands exactly on a thin registered native shape', async () => {
  const { core, player } = await wasmPlayer(); core.block_set(0, 5, 0, 500); player.setPosition([.5, 12, .5]);
  const position = [...player.position]; near(player.sweepAxis(position, 1, -40), -6.96875); near(position[1], 5.03125);
  assert.equal(core.block_get(0, 5, 0), 500);
});

test('support lookup uses nearest owner-block center and native descending Y/Z/X ties', async () => {
  const { player } = await wasmPlayer(); player.setPosition([1, 1, .5]); player.updateSupportingBlock(true);
  assert.deepEqual(player.mainSupportingBlockPos, [1, 0, 0], 'equidistant floor blocks select the greater X coordinate');
  player.setPosition([.5, 1, 1]); player.updateSupportingBlock(true);
  assert.deepEqual(player.mainSupportingBlockPos, [0, 0, 1], 'equal X uses the greater Z coordinate');
  player.setPosition([.5, 2, .5]);
  player.setCollisionProvider(() => [], () => [{ box: [.2, 1, .2, .8, 2, .8], position: [4, 1, 0], key: '4,1,0', moving: true }]);
  player.updateSupportingBlock(true); assert.deepEqual(player.mainSupportingBlockPos, [4, 1, 0], 'a moved shape retains its actual piston owner instead of its translated mesh cell');
  player.updateSupportingBlock(false); assert.equal(player.mainSupportingBlockPos, null); assert.equal(player.onGroundNoBlocks, false);
});

test('native second step candidate climbs a shallow stair beneath a low forward ceiling', async () => {
  const { core, player, materials } = await wasmPlayer();
  for (const [id, name, collision] of [[501, 'shallow_stair', [0, 0, 0, 1, .2, 1]], [502, 'low_ceiling', [0, .1, 0, 1, 1, 1]]]) {
    materials.set(id, { name, flags: 1, collisionBoxes: [collision] }); core.block_register(id, .5, .5, .5, 1);
    const ptr = core.world_float_stage_ptr(); new Float32Array(core.memory.buffer, ptr, 6).set(collision); core.block_collision_register(id, ptr, 1);
  }
  core.block_set(1, 1, 0, 501); core.block_set(1, 3, 0, 502); player.setPosition([.5, 1, .5]); player.grounded = true;
  player.move(1, 0, 0);
  near(player.position[0], 1.5); near(player.position[1], 1.2);
  assert.equal(player.horizontalCollision, false);
  assert.equal(player.collides(), false, 'standing fits between the shallow stair and its forward ceiling');
});

test('actual WASM clips piston pushes at a static wall and preserves authoritative voxels', async () => {
  const { core, player } = await wasmPlayer({ wall: true });
  const event = { kind: 'piston', key: '1,1,0', tick: 10n, position: [1, 1, 0], direction: [1, 0, 0], previousProgress: 0, currentProgress: .5, extending: true, boxes: [[0, 1, 0, 1, 2, 1]], materialName: 'stone' };
  const revisions = Array.from({ length: core.world_chunk_count() }, (_, index) => core.chunk_revision(index));
  near(player.applyBlockMotions([event]), 1); near(player.position[0], 1.7);
  near(player.position[1], 1); assert.equal(player.horizontalCollision, true);
  assert.equal(core.block_get(2, 1, 0), 1); assert.deepEqual(Array.from({ length: core.world_chunk_count() }, (_, index) => core.chunk_revision(index)), revisions, 'push updates only the local entity, never world/light/mesh state');
});

test('same-tick piston pushes cap total displacement and reset on the next world tick', async () => {
  const { player } = await wasmPlayer();
  const event = { kind: 'piston', tick: 10, position: [1, 1, 0], direction: [1, 0, 0], previousProgress: 0, currentProgress: .5, extending: true, boxes: [[0, 1, 0, 1, 2, 1]], materialName: 'slime_block' };
  player.applyBlockMotions([event]); near(player.position[0], 1.71); near(player.velocity[0], 20);
  const second = { ...event, position: [2, 1, 0], boxes: [[1, 1, 0, 2, 2, 1]] };
  player.applyBlockMotions([second]); near(player.position[0], 1.71);
  player.applyBlockMotions([{ ...second, tick: 11 }]); near(player.position[0], 2.22);
});

test('a low display frame rate orders all block entities by native tick before sharing piston caps', async () => {
  const { player } = await wasmPlayer();
  const motion = (tick, face, previousProgress) => ({ kind: 'piston', tick, position: [face, 1, 0], direction: [1, 0, 0], previousProgress, currentProgress: previousProgress + .5, extending: true, boxes: [[face - 1, 1, 0, face, 2, 1]], materialName: 'stone' });
  // BlockEntityScene collects each entity's accumulated ticks in turn. Two
  // pistons still share at most .51 displacement during each world tick.
  player.applyBlockMotions([motion(9007199254741001n, 1, 0), motion(9007199254741002n, 1.5, .5), motion(9007199254741001n, 2, 0), motion(9007199254741002n, 2.5, .5)]);
  near(player.position[0], 2.22);
});

test('dynamic provider excludes only the pushing source and native pushes bypass sneak edge protection', async () => {
  const { player } = await wasmPlayer();
  const received = [];
  player.setCollisionProvider((bounds, options) => { received.push(options); return options?.excludeMotion === 'source' ? [] : [[0, 1, 0, 1.5, 2, 1]]; });
  player.sneaking = true; player.stayOnEdge = () => { throw new Error('PISTON must not run voluntary movement edge protection'); };
  player.applyBlockMotions([{ kind: 'piston', key: 'source', tick: 1, position: [1, 1, 0], direction: [1, 0, 0], previousProgress: 0, currentProgress: .5, extending: true, boxes: [[0, 1, 0, 1, 2, 1]], materialName: 'stone' }]);
  near(player.position[0], 1.71); assert.ok(received.some(options => options?.excludeMotion === 'source')); assert.equal(player.collisionOptions, null);
});

test('shulker displacement remains constrained by loaded columns and spectator mode', async () => {
  const { player } = await wasmPlayer(); player.setPosition([15.55, 1, .5]);
  const event = { kind: 'shulker', key: '14,1,0', tick: 1, position: [14, 1, 0], direction: [1, 0, 0], previousProgress: .3, currentProgress: .4 };
  player.applyBlockMotions([event]); near(player.position[0], 15.66);
  player.applyBlockMotions([{ ...event, previousProgress: .4, currentProgress: .5 }]); near(player.position[0], 15.7);
  player.noclip = true; player.applyBlockMotions([{ ...event, previousProgress: .5, currentProgress: .6 }]); near(player.position[0], 15.7);
});
