import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/player.js';
import { ServerGameplay } from '../src/gameplay.js';

const SPRINT_UUID = '662a6b8d-da3e-4c1c-8813-96ea6097278d';
const PLUGIN_UUID = '10000000-0000-4000-8000-000000000001';

function subject(state) {
  const core = {
    world_origin_x: () => -128, world_origin_z: () => -128,
    world_width: () => 256, world_depth: () => 256, world_height: () => 384,
    world_min_y: () => -64, world_column_loaded: () => 1,
    terrain_height: () => 0,
    collides_aabb: (_x0, y0) => Number(y0 < -0.0001),
  };
  const player = new Player(core); player.setPosition([0, 0, 0]);
  // Exercise the actual server-state bridge without needing a DOM constructor.
  const gameplay = {
    player, root: {}, active: false,
    ui: { health: {}, food: {}, level: {}, creative: {}, death: {}, respawn: {} },
    renderHotbar() {},
  };
  ServerGameplay.prototype.state.call(gameplay, { status: 'playing', gameMode: 0, health: 20, food: 20, ...state });
  return player;
}

function distance(player, keys = ['KeyW']) {
  for (let tick = 0; tick < 40; tick++) player.step(0.05, new Set(keys));
  return -player.position[2];
}

function attributes(modifiers, value = 0.1) {
  return [{ name: 'minecraft:generic.movement_speed', value, modifiers }];
}

test('server sprint attribute updates preserve the actual 1.3 locomotion factor', () => {
  const walk = subject({ attributes: attributes([]) });
  const sprint = subject({ attributes: attributes([{ uuid: SPRINT_UUID.toUpperCase(), operation: 2, amount: 0.30000001192092896 }]) });
  const released = subject({ attributes: attributes([{ uuid: SPRINT_UUID, operation: 2, amount: 0.3 }]) });
  const walkingDistance = distance(walk);
  assert.ok(Math.abs(distance(sprint, ['KeyW', 'ControlLeft']) / walkingDistance - 1.3) < 0.00001);
  assert.equal(distance(released), walkingDistance, 'stale server sprint metadata does not accelerate released sprint input');
  assert.equal(sprint.movementMultiplier, 1);
});

test('sprint normalization retains plugin and potion modifiers with vanilla attribute operation order', () => {
  const baseline = distance(subject({}));
  const player = subject({
    effects: [{ id: 0, amplifier: 0 }, { id: 1, amplifier: 0 }],
    attributes: attributes([
      { uuid: SPRINT_UUID, operation: 2, amount: 0.3 },
      { uuid: PLUGIN_UUID, operation: 0, amount: 0.02 },
      { uuid: '10000000-0000-4000-8000-000000000002', operation: 1, amount: 0.5 },
      { uuid: '10000000-0000-4000-8000-000000000003', operation: 1, amount: 0.25 },
      { uuid: '91aeaa56-376b-4498-935b-2f7f68070635', operation: 2, amount: 0.2 },
      { uuid: '7107de5e-7ce8-4030-940e-514c1f160890', operation: 2, amount: -0.15 },
    ]),
  });
  const expected = (0.1 + 0.02) * (1 + 0.5 + 0.25) * 1.2 * 0.85 / 0.1;
  assert.ok(Math.abs(distance(player) / baseline - expected) < 0.00001);
  assert.ok(Math.abs(player.movementMultiplier - expected) < 0.0000001);
});

test('a plugin speed boost of 0.3 remains distinct from the vanilla sprint UUID', () => {
  const baseline = distance(subject({}));
  const player = subject({ attributes: attributes([{ uuid: PLUGIN_UUID, operation: 2, amount: 0.3 }]) });
  assert.ok(Math.abs(distance(player, ['KeyW', 'ControlLeft']) / baseline - 1.69) < 0.00001);
});

test('effects provide base speed when no movement attribute exists', () => {
  const baseline = distance(subject({}));
  const player = subject({ effects: [{ id: 0, amplifier: 1 }, { id: 1, amplifier: 0 }] });
  assert.ok(Math.abs(distance(player) / baseline - 1.4 * 0.85) < 0.00001);
});
