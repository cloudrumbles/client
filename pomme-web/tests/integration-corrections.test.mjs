import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { MinecraftSession } from '../src/minecraft.js';
import { Player } from '../src/player.js';
import { vehicleStateFromEntity, VehicleController } from '../src/vehicle.js';

// Exercise the real wire codecs and the shared session/physics contracts.
function connection(version, callbacks = {}) {
  const registry = minecraftData(version), sent = [], positions = [], events = [];
  const writer = minecraftProtocol.createSerializer({ state: 'play', isServer: true, version });
  const reader = minecraftProtocol.createDeserializer({ state: 'play', isServer: false, version });
  const outbound = minecraftProtocol.createSerializer({ state: 'play', isServer: false, version });
  const outboundReader = minecraftProtocol.createDeserializer({ state: 'play', isServer: true, version });
  const client = new MinecraftSession({
    registry: { version: registry.version, items: registry.itemsArray, entities: registry.entitiesArray, effects: registry.effectsArray },
    onPosition: position => positions.push(position), onEvent: event => events.push(event), ...callbacks,
    transport: { packet(name, params) { sent.push(outboundReader.parsePacketBuffer(outbound.createPacketBuffer({ name, params })).data); return true; }, close() {}, connect: async () => {} },
  });
  Object.assign(client.state, { entityId: 9, status: 'playing' });
  const receive = (name, params) => {
    const packet = reader.parsePacketBuffer(writer.createPacketBuffer({ name, params })).data;
    client.receive({ type: 'packet', state: 'play', name: packet.name, data: packet.params });
    const failure = events.find(event => event.type === 'error');
    assert.equal(failure, undefined, failure?.message);
  };
  return { client, registry, receive, sent, positions };
}

function priorPosition() { return { position: [10, 64, 30], yaw: -Math.PI, pitch: 0, grounded: false, velocity: [20, 40, 60] }; }
function spawn(registry, name = 'boat') {
  const type = registry.entitiesByName[name] ?? registry.entitiesArray.find(entity => /(?:^|_)boat$/.test(entity.name));
  return { entityId: 44, objectUUID: '12345678-1234-1234-1234-123456789012', type: type.id, x: 10, y: 64, z: 30, pitch: 0, yaw: 64, headPitch: 0, objectData: 0, velocity: { x: 0.5, y: 0.25, z: 0 } };
}
function near(actual, expected, tolerance = 1e-10) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} must equal ${expected}`); }

test('wire status effects use the same native registry IDs and canonical names as locomotion', () => {
  const core = { terrain_height: () => 0, world_width: () => 256, world_depth: () => 256, world_height: () => 384, world_min_y: () => -64, world_column_loaded: () => true, block_get: () => 0, block_flags: () => 0, collides_aabb: () => 0 };
  const player = new Player(core);
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const { client, receive } = connection(version, { onState: state => player.setEffects(state.effects) });
    for (const [id, name] of [[0, 'speed'], [7, 'jump_boost'], [24, 'levitation'], [27, 'slow_falling'], [29, 'dolphins_grace']]) {
      receive('entity_effect', { entityId: 9, effectId: id, amplifier: 1, duration: 1200, hideParticles: 0, flags: 0, factorCodec: undefined });
      assert.equal(client.state.effects.find(effect => effect.id === id)?.name, name);
      assert.equal(player.effectLevel(name), 2, `${version} ${name} must reach player physics`);
    }
    receive('remove_entity_effect', { entityId: 9, effectId: 0 });
    assert.equal(player.effectLevel('speed'), 0);
    assert.equal(player.effectLevel('levitation'), 2);
  }
});

for (const version of ['1.21.11', '26.1']) {
  test(`${version} relative player correction rotates and resolves motion atomically`, () => {
    const { client, receive, positions, sent } = connection(version);
    client.hasPosition = true; client.tick(priorPosition(), 0.05);
    receive('position', { teleportId: 17, x: 2, y: 70, z: -3, dx: 0.25, dy: -0.25, dz: 1, yaw: 90, pitch: 0,
      flags: { x: true, y: false, z: true, yaw: false, pitch: false, dx: true, dy: true, dz: true, yawDelta: true } });
    const correction = positions.at(-1);
    assert.deepEqual([correction.x, correction.y, correction.z], [12, 70, 27]);
    near(correction.yaw, -Math.PI / 2);
    assert.ok(correction.velocity, 'Resolved packet motion must travel with its position correction');
    near(correction.velocity.x, -2.75); near(correction.velocity.y, 1.75); near(correction.velocity.z, 2);
    const acknowledgement = sent.filter(packet => ['teleport_confirm', 'position_look'].includes(packet.name)).slice(-2);
    assert.equal(acknowledgement[0].name, 'teleport_confirm');
    assert.equal(acknowledgement[0].params.teleportId, 17);
    assert.equal(acknowledgement[1].params.x, 12);
  });

  test(`${version} entity teleport applies relative pose and motion while position sync preserves motion`, () => {
    const { client, registry, receive } = connection(version);
    receive('spawn_entity', spawn(registry));
    receive('entity_teleport', { entityId: 44, x: 1, y: 65, z: 2, dx: 0.1, dy: 0.2, dz: 0.3, yaw: 5.25, pitch: -23.75, onGround: true,
      flags: { x: true, y: false, z: true, yaw: true, pitch: false, dx: true, dy: false, dz: true, yawDelta: false } });
    const entity = client.entities.get(44);
    assert.deepEqual([entity.x, entity.y, entity.z], [11, 65, 32]);
    near(entity.yaw, 95.25 * Math.PI / 180); near(entity.pitch, -23.75 * Math.PI / 180);
    // Modern lpVec3 velocities have an independent wire quantization step.
    near(entity.velocity.x, 4800, 1); near(entity.velocity.y, 1600); near(entity.velocity.z, 2400);
    const motion = { ...entity.velocity };
    receive('sync_entity_position', { entityId: 44, x: -4, y: 66, z: 8, dx: 7, dy: 8, dz: 9, yaw: 12.25, pitch: 4.125, onGround: false });
    assert.deepEqual(entity.velocity, motion, 'Vanilla position sync does not replace entity delta movement');
    assert.deepEqual([entity.x, entity.y, entity.z], [-4, 66, 8]);
    near(entity.yaw, 12.25 * Math.PI / 180); near(entity.pitch, 4.125 * Math.PI / 180);
  });

  test(`${version} a mounted player acknowledges local teleports without moving the passenger`, () => {
    const { client, registry, receive, positions, sent } = connection(version);
    receive('spawn_entity', spawn(registry));
    receive('set_passengers', { entityId: 44, passengers: [9] });
    client.hasPosition = true; client.tick(priorPosition(), 0.05);
    receive('position', { teleportId: 18, x: 100, y: 200, z: 300, dx: 0, dy: 0, dz: 0, yaw: 90, pitch: 45, flags: {} });
    assert.equal(positions.length, 0, 'Mounted teleport must not move the local camera away from its root vehicle');
    const acknowledgement = sent.filter(packet => ['teleport_confirm', 'position_look'].includes(packet.name)).slice(-2);
    assert.equal(acknowledgement[0].name, 'teleport_confirm');
    assert.deepEqual([acknowledgement[1].params.x, acknowledgement[1].params.y, acknowledgement[1].params.z], [10, 64, 30]);
  });
}

test('1.20.4 relative coordinate corrections preserve motion on their corresponding axes', () => {
  const { client, receive, positions } = connection('1.20.4');
  client.hasPosition = true; client.tick(priorPosition(), 0.05);
  receive('position', { teleportId: 3, x: 2, y: 70, z: -3, yaw: 180, pitch: 0, flags: 5 });
  const correction = positions.at(-1);
  assert.deepEqual([correction.x, correction.y, correction.z], [12, 70, 27]);
  assert.deepEqual(correction.velocity, { x: 1, y: 0, z: 3 });
});

test('mounted vehicle server corrections are acknowledged and reach controlled motion', () => {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const { client, registry, receive, sent } = connection(version);
    receive('spawn_entity', spawn(registry));
    receive('set_passengers', { entityId: 44, passengers: [9] });
    const entity = client.entities.get(44), state = vehicleStateFromEntity(entity, { entities: registry.entitiesArray }, 9);
    assert.equal(state.controlled, true);
    const controller = new VehicleController({}, state);
    if (version !== '1.20.4') controller.velocity.forEach((component, index) => near(component, [10, 5, 0][index], 0.001));
    const protocolVelocity = version === '1.20.4' ? { x: 4000, y: 2000, z: 0 } : { x: 0.5, y: 0.25, z: 0 };
    receive('entity_velocity', { entityId: 44, velocity: protocolVelocity });
    receive('vehicle_move', { x: -8, y: 67, z: 12, yaw: 12.25, pitch: -4.125 });
    const updated = vehicleStateFromEntity(entity, { entities: registry.entitiesArray }, 9);
    controller.update({ ...updated, teleport: true });
    assert.deepEqual(controller.position, [-8, 67, 12]);
    near(controller.yaw, 12.25 * Math.PI / 180 - Math.PI);
    near(controller.pitch, 4.125 * Math.PI / 180);
    controller.velocity.forEach((component, index) => near(component, [10, 5, 0][index], 0.001));
    assert.equal(sent.at(-1).name, 'vehicle_move');
    assert.equal(sent.at(-1).params.yaw, 12.25);
  }
});

test('login and respawn retain the signed 64-bit biome seed for every supported wire version', () => {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const { client, registry, receive } = connection(version), seed = -8123456789012345678n;
    const login = { ...registry.loginPacket, hashedSeed: seed, worldState: { ...registry.loginPacket.worldState, hashedSeed: seed } };
    receive('login', login);
    assert.equal(client.state.biomeSeed, seed);
    receive('respawn', version === '1.20.4' ? { dimension: 'minecraft:the_nether', worldName: 'minecraft:the_nether', hashedSeed: seed + 1n, gamemode: 0, previousGamemode: 0, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0, copyMetadata: false }
      : { worldState: { ...login.worldState, name: 'minecraft:the_nether', hashedSeed: seed + 1n }, copyMetadata: 0 });
    assert.equal(client.state.biomeSeed, seed + 1n);
  }
});

test('generated player metadata indexes preserve off-hand use, main arm, and invisibility', () => {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const { client, registry, receive } = connection(version), keys = registry.entitiesByName.player.metadataKeys;
    receive('entity_metadata', { entityId: 9, metadata: [
      { key: keys.indexOf('living_entity_flags'), type: 'byte', value: 3 },
      { key: keys.indexOf('player_main_hand'), type: 'byte', value: 0 },
      { key: keys.indexOf('shared_flags'), type: 'byte', value: 32 },
    ] });
    assert.equal(client.state.usingItem, true); assert.equal(client.state.usingHand, 1);
    assert.equal(client.state.leftHanded, true); assert.equal(client.state.invisible, true);
    receive('entity_metadata', { entityId: 9, metadata: [
      { key: keys.indexOf('living_entity_flags'), type: 'byte', value: 1 },
      { key: keys.indexOf('player_main_hand'), type: 'byte', value: 1 },
      { key: keys.indexOf('shared_flags'), type: 'byte', value: 0 },
    ] });
    assert.equal(client.state.usingHand, 0); assert.equal(client.state.leftHanded, false); assert.equal(client.state.invisible, false);
  }
});
