import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { MinecraftSession } from '../src/minecraft.js';
import { MinecraftEffects } from '../src/effects.js';
import { ServerGameplay } from '../src/gameplay.js';
import { containerLayout } from '../src/container-ui.js';
import { sameStack, stackLimit } from '../src/inventory-prediction.js';

function connection(version, callbacks = {}) {
  const data = minecraftData(version), events = [], inventories = [], sent = [], positions = [];
  const writer = minecraftProtocol.createSerializer({ state: 'play', isServer: true, version });
  const reader = minecraftProtocol.createDeserializer({ state: 'play', isServer: false, version });
  const outbound = minecraftProtocol.createSerializer({ state: 'play', isServer: false, version });
  const outboundReader = minecraftProtocol.createDeserializer({ state: 'play', isServer: true, version });
  const client = new MinecraftSession({ registry: { version: data.version, items: data.itemsArray, entities: data.entitiesArray, particles: data.particlesArray },
    onEvent: event => events.push(event), onInventory: inventory => inventories.push(inventory), onPosition: position => positions.push(position), ...callbacks,
    transport: { packet(name, params) { sent.push(outboundReader.parsePacketBuffer(outbound.createPacketBuffer({ name, params })).data); return true; }, close() {} } });
  Object.assign(client.state, { entityId: 9, status: 'playing' });
  const receive = (name, params, rawLastByte) => {
    // The codec's inline registry holder writer advances over its zero marker;
    // use zeroed storage so its intended wire output does not depend on heap data.
    const packet = { name, params }, bytes = Buffer.alloc(writer.proto.sizeOf(packet, writer.mainType));
    writer.proto.write(packet, bytes, 0, writer.mainType);
    if (rawLastByte !== undefined) bytes[bytes.length - 1] = rawLastByte;
    const parsed = reader.parsePacketBuffer(bytes).data;
    // Official 1.20.4 RespawnPacket is u8, despite minecraft-data's bool.
    if (name === 'respawn' && version === '1.20.4') parsed.params.copyMetadata = bytes.at(-1);
    client.receive({ type: 'packet', name: parsed.name, data: parsed.params });
    assert.equal(events.find(event => event.type === 'error'), undefined);
  };
  const stack = (name, itemCount = 1, extra = {}) => ({ present: true, itemId: data.itemsByName[name].id, itemCount, ...extra });
  const slots = (length, entries = {}) => Array.from({ length }, (_, index) => entries[index] || { present: false });
  const content = (windowId, items, cursor = { present: false }) => receive('window_items', { windowId, stateId: 4, items: items.map(item => client.adapter.protocolSlot(item)), carriedItem: client.adapter.protocolSlot(cursor) });
  return { client, data, events, inventories, sent, positions, receive, stack, slots, content };
}

for (const version of ['1.20.4', '1.21.11', '26.1']) {
  test(`${version} explosion wire produces additive motion, directed particles and native sound holder`, () => {
    const { client, data, receive, events } = connection(version, { getPlayer: () => ({ velocity: [20, 40, 60] }) });
    const sound = { data: { soundName: 'minecraft:entity.generic.explode' } }, center = { x: -0.75, y: 64.25, z: 1.5 };
    receive('explosion', version === '1.20.4' ? { ...center, radius: 4, affectedBlockOffsets: [{ x: 1, y: 0, z: -1 }], playerMotionX: 0.5, playerMotionY: -0.25, playerMotionZ: 1, block_interaction_type: 1, small_explosion_particle: { type: 'explosion' }, large_explosion_particle: { type: 'explosion_emitter' }, sound }
      : { center, radius: 4, blockCount: 20, playerKnockback: { x: 0.5, y: -0.25, z: 1 }, explosionParticle: { type: 'explosion_emitter' }, sound, blockParticles: [{ data: { particle: { type: 'smoke' }, scaling: 0.5, speed: 1 }, weight: 3 }] });
    assert.deepEqual(client.velocity, { x: 1.5, y: 1.75, z: 4 });
    const motion = events.find(event => event.type === 'player-velocity'); assert.equal(motion.additive, true);
    const gameplay = { player: { velocity: [20, 40, 60] } }; ServerGameplay.prototype.event.call(gameplay, motion);
    assert.deepEqual(gameplay.player.velocity, [30, 35, 80]);
    const particle = events.find(event => event.type === 'particles').data;
    assert.equal(data.particlesArray.find(entry => entry.id === particle.particleId).name, 'explosion_emitter');
    assert.equal(particle.particles, 0); assert.deepEqual([particle.offsetX, particle.offsetY, particle.offsetZ], [1, 0, 0]);
    const audio = events.find(event => event.type === 'sound').data;
    assert.equal(audio.sound.data.soundName, 'minecraft:entity.generic.explode'); assert.equal(audio.volume, 4);
    assert.deepEqual([audio.x / 8, audio.y / 8, audio.z / 8], Object.values(center)); assert.ok(audio.pitch >= 0.56 && audio.pitch <= 0.84);
    assert.equal(events.some(event => event.type === 'explosion-block-effects'), version !== '1.20.4');
  });

  test(`${version} horse menu wire columns, slot groups and shift transfer use mount storage`, () => {
    const { client, data, receive, events, stack, slots, content } = connection(version);
    client.entities.set(44, { id: 44, entityType: data.entitiesByName.donkey.id });
    receive('open_horse_window', { windowId: 2, nbSlots: version === '1.20.4' ? 17 : 5, entityId: 44 });
    assert.equal(client.state.windowId, 2);
    const menu = events.find(event => event.type === 'window'); assert.equal(menu.horseType, 'donkey'); assert.equal(menu.inventoryColumns, 5);
    content(2, slots(53, { 17: stack('stone', 32) }));
    const layout = containerLayout(2, menu.inventoryType, 53, menu);
    assert.equal(layout.containerSlots, 17); assert.equal(layout.groups.find(group => group.name === 'Mount storage').slots.length, 15);
    client.clickWindow(17, { mode: 1 });
    assert.equal(client.windows.get(2).slots[2].itemCount, 32); assert.equal(client.windows.get(2).slots[17].present, false);
    assert.equal(client.windows.get(0).slots[9].present, false, 'accepted container prediction updates shared player inventory');
  });

  test(`${version} respawn independently retains metadata/attributes and preserves same-dimension chunks`, () => {
    const { client, data, receive } = connection(version, { getPlayer: () => ({ velocity: [1, 2, 3], yaw: 0.25, pitch: -0.5 }) });
    for (let mask = 0; mask <= 3; mask++) {
      Object.assign(client.state, { dimension: 'minecraft:overworld', attributes: [{ name: 'minecraft:generic.max_health', value: 24, modifiers: [{ amount: 2 }] }], health: 13, invisible: true, gliding: true, usingItem: true, usingHand: 1, effects: [{ name: 'speed' }] });
      Object.assign(client.state, { food: 4, saturation: 1, experience: 0.5, experienceLevel: 12, totalExperience: 200, equipment: [{ slot: 0 }], selectedSlot: 7, windowId: 2, canFly: true, flying: true });
      client.windows.set(0, { windowId: 0, slots: [{ present: true, itemId: 1, itemCount: 10 }] }); client.windows.set(2, { windowId: 2, slots: [] });
      client.columns.set('0,0', { x: 0, z: 0, sections: [] }); client.entities.set(44, { id: 44 });
      receive('respawn', version === '1.20.4' ? { dimension: 'minecraft:overworld', worldName: 'minecraft:overworld', hashedSeed: 0n, gamemode: 0, previousGamemode: 0, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0, copyMetadata: false }
        : { worldState: { ...data.loginPacket.worldState, name: 'minecraft:overworld' }, copyMetadata: mask }, version === '1.20.4' ? mask : undefined);
      assert.equal(client.state.keepData, mask); assert.equal(client.state.preserveLevel, true);
      assert.equal(client.columns.size, 1); assert.equal(client.entities.has(44), true);
      assert.equal(client.state.invisible, Boolean(mask & 2)); assert.equal(client.state.usingHand, mask & 2 ? 1 : 0);
      assert.equal(client.state.health, version === '1.20.4' ? mask & 1 ? 24 : 20 : mask & 2 ? 13 : 24); assert.deepEqual(client.state.effects, []);
      assert.equal(client.state.attributes.length, mask & 1 || version !== '1.20.4' ? 1 : 0);
      if (version !== '1.20.4') assert.equal(client.state.attributes[0].modifiers.length, mask & 1 ? 1 : 0);
      assert.equal(Boolean(client.state.respawnPosition), Boolean(mask & 2) && version !== '1.20.4');
      assert.equal(client.state.food, 20); assert.equal(client.state.saturation, 5); assert.equal(client.state.experienceLevel, 0); assert.equal(client.state.selectedSlot, 0); assert.deepEqual(client.state.equipment, []);
      assert.equal(client.windows.size, 1); assert.equal(client.windows.get(0).slots.length, 46); assert.ok(client.windows.get(0).slots.every(item => !item.present));
      assert.equal(client.state.canFly, false); assert.equal(client.state.flying, false);
    }
  });

  test(`${version} accepted quick move/hotbar swap/throw/collect predictions synchronize shared player slots`, () => {
    const { client, receive, stack, slots, content, sent } = connection(version);
    receive('open_window', { windowId: 1, inventoryType: 0, windowTitle: version === '1.20.4' ? '{"text":"Chest"}' : { type: 'compound', value: { text: { type: 'string', value: 'Chest' } } } });
    content(1, slots(45, { 0: stack('stone', 60), 36: stack('stone', 8), 9: stack('dirt', 4) }));
    client.clickWindow(0, { mode: 1 });
    assert.equal(client.windows.get(1).slots[36].itemCount, 64); assert.equal(client.windows.get(1).slots[44].itemCount, 4);
    assert.equal(client.windows.get(0).slots[36].itemCount, 64); assert.equal(client.windows.get(0).slots[44].itemCount, 4);
    client.clickWindow(9, { mode: 2, button: 0 });
    assert.equal(client.windows.get(1).slots[9].itemCount, 64); assert.equal(client.windows.get(0).slots[36].itemCount, 4);
    client.clickWindow(36, { mode: 4, button: 0 }); assert.equal(client.windows.get(0).slots[36].itemCount, 3);
    client.clickWindow(44); client.clickWindow(0, { mode: 6 });
    assert.equal(client.windows.get(1).cursor.itemCount, 64); assert.equal(client.windows.get(1).slots[9].itemCount, 4);
    assert.equal(sent.at(-1).params.stateId, 4, 'prediction never invents a server state revision');
    receive('set_slot', { windowId: 1, stateId: 5, slot: 9, item: client.adapter.protocolSlot(stack('stone', 10)) });
    assert.equal(client.windows.get(0).slots[9].itemCount, 10); assert.equal(client.windows.get(0).slots[36].itemCount, 3, 'correction touches only the server slot');
  });

  test(`${version} creative clone and two-slot quick craft preserve conservation and reset rejected drag`, () => {
    const { client, stack, slots, content } = connection(version); client.state.gameMode = 1;
    content(0, slots(46, { 36: stack('stone', 2) })); client.clickWindow(36, { mode: 3 });
    assert.equal(client.windows.get(0).cursor.itemCount, 64);
    client.clickWindow(-999, { mode: 5, button: 0 }); client.clickWindow(9, { mode: 5, button: 1 }); client.clickWindow(10, { mode: 5, button: 1 }); client.clickWindow(-999, { mode: 5, button: 2 });
    assert.equal(client.windows.get(0).slots[9].itemCount, 32); assert.equal(client.windows.get(0).slots[10].itemCount, 32); assert.equal(client.windows.get(0).cursor.present, false);
    client.clickWindow(9); client.clickWindow(-999, { mode: 5, button: 0 }); client.clickWindow(10, { mode: 4 });
    assert.equal(client.quickCraft, null); assert.equal(client.windows.get(0).slots[10].itemCount, 32, 'non-drag action cancels active quick craft without performing it');
  });

  test(`${version} first queued post-respawn correction samples the new player instead of stale physics`, () => {
    const stale = { position: [100, 80, 200], yaw: 0.25, pitch: -0.5, velocity: [20, 40, 60] };
    for (const keep of [0, 2]) {
      const { client, data, receive, positions } = connection(version, { getPlayer: () => stale });
      receive('respawn', version === '1.20.4' ? { dimension: 'minecraft:overworld', worldName: 'minecraft:overworld', hashedSeed: 0n, gamemode: 0, previousGamemode: 0, isDebug: false, isFlat: false, portalCooldown: 0, copyMetadata: false }
        : { worldState: data.loginPacket.worldState, copyMetadata: keep }, version === '1.20.4' ? keep : undefined);
      receive('position', version === '1.20.4' ? { teleportId: 10 + keep, x: 5, y: 70, z: 5, yaw: 0, pitch: 0, flags: 24 }
        : { teleportId: 10 + keep, x: 5, y: 70, z: 5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { yaw: true, pitch: true, dx: true, dy: true, dz: true } });
      const correction = positions.at(-1), retains = keep === 2 && version !== '1.20.4';
      assert.ok(Math.abs(correction.yaw - (retains ? 0.25 : -Math.PI * 2)) < 1e-10);
      assert.ok(Math.abs(correction.pitch - (retains ? -0.5 : 0)) < 1e-10);
      assert.deepEqual(correction.velocity, retains ? { x: 1, y: 2, z: 3 } : { x: 0, y: 0, z: 0 });
    }
  });
}

test('batched modern corrections and knockback resolve against the latest queued pose and motion', () => {
  const stale = { position: [10, 64, 30], yaw: -Math.PI, pitch: 0, velocity: [20, 40, 60] };
  const { client, receive, positions, sent } = connection('1.21.11', { getPlayer: () => stale });
  receive('position', { teleportId: 1, x: 20, y: 70, z: 40, dx: 2, dy: 3, dz: 4, yaw: 0, pitch: 0, flags: {} });
  const relative = { x: true, y: true, z: true, dx: true, dy: true, dz: true };
  receive('position', { teleportId: 2, x: 1, y: 0, z: 2, dx: 0.5, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: relative });
  assert.deepEqual([positions.at(-1).x, positions.at(-1).y, positions.at(-1).z], [21, 70, 42]);
  assert.deepEqual(positions.at(-1).velocity, { x: 2.5, y: 3, z: 4 });
  receive('explosion', { center: { x: 20, y: 70, z: 40 }, radius: 1, blockCount: 0, playerKnockback: { x: 0.5, y: 0, z: 0 }, explosionParticle: { type: 'explosion' }, sound: { soundId: 0 }, blockParticles: [] });
  client.acknowledgePosition(1); assert.equal(client.pendingCorrection.teleportId, 2, 'stale application cannot acknowledge the newer correction');
  Object.assign(stale, { position: [21, 70, 42], yaw: positions.at(-1).yaw, pitch: positions.at(-1).pitch, velocity: [50, 60, 80] });
  client.acknowledgePosition(2); assert.equal(client.pendingMotion.revision, 1, 'position application cannot clear later queued knockback');
  receive('position', { teleportId: 3, x: 1, y: 2, z: 3, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: relative });
  assert.deepEqual(positions.at(-1).velocity, { x: 3, y: 3, z: 4 });
  assert.deepEqual([positions.at(-1).x, positions.at(-1).y, positions.at(-1).z], [22, 72, 45]);
  client.acknowledgePosition(3);
  client.tick(stale, 0.05); assert.equal(sent.at(-1).name, 'player_input', 'applied corrections release local movement');
});

for (const version of ['1.21.11', '26.1']) test(`${version} correction followed by KEEP_ENTITY_DATA respawn copies unapplied logical motion and angles`, () => {
  const stale = { position: [10, 64, 30], yaw: 0, pitch: 0, velocity: [0, 0, 0] };
  const { client, data, receive, positions } = connection(version, { getPlayer: () => stale });
  client.state.dimension = 'minecraft:overworld';
  receive('position', { teleportId: 1, x: 20, y: 70, z: 40, dx: 1, dy: 2, dz: 3, yaw: 270, pitch: 30, flags: {} });
  receive('explosion', { center: { x: 20, y: 70, z: 40 }, radius: 1, blockCount: 0, playerKnockback: { x: 0.5, y: 0, z: 0 }, explosionParticle: { type: 'explosion' }, sound: { soundId: 0 }, blockParticles: [] });
  receive('respawn', { worldState: { ...data.loginPacket.worldState, name: 'minecraft:overworld' }, copyMetadata: 2 });
  assert.ok(Math.abs(client.state.respawnPosition.yaw - Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(client.state.respawnPosition.pitch + Math.PI / 6) < 1e-10);
  assert.deepEqual(client.state.respawnPosition.velocity, [30, 40, 60]);
  receive('position', { teleportId: 2, x: 2, y: 80, z: 2, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { yaw: true, pitch: true, dx: true, dy: true, dz: true } });
  assert.ok(Math.abs(positions.at(-1).yaw - Math.PI / 2) < 1e-10);
  assert.ok(Math.abs(positions.at(-1).pitch + Math.PI / 6) < 1e-10);
  assert.deepEqual(positions.at(-1).velocity, { x: 1.5, y: 2, z: 3 });
});

test('component equality ignores patch order, separates damage, and honors native max_stack_size', () => {
  const definitions = new Map([[1, { stackSize: 64 }]]);
  const a = { present: true, itemId: 1, itemCount: 4, components: [{ type: 'max_stack_size', data: 16 }, { type: 'damage', data: 2 }] };
  assert.equal(sameStack(a, { ...a, itemCount: 9, components: [...a.components].reverse() }), true);
  assert.equal(sameStack(a, { ...a, components: [{ type: 'max_stack_size', data: 16 }, { type: 'damage', data: 3 }] }), false);
  assert.equal(stackLimit(a, definitions), 16);
});

test('modern explosion sprays use one bounded weighted batch, scaled radial velocity, and native air checks', () => {
  let state = 1234; const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 2 ** 32);
  const effects = new MinecraftEffects({ random, maxParticles: 2048, isAir: x => x >= 0 });
  const event = { type: 'explosion-block-effects', center: { x: 0, y: 10, z: 0 }, radius: 4, blockCount: 1000, blockParticles: [{ weight: 1, data: { particle: { type: 'smoke' }, scaling: 0.5, speed: 1 } }] };
  effects.event(event); effects.event({ ...event, center: { x: 50, y: 10, z: 0 } });
  effects.tick(0.05);
  assert.ok(effects.particles.length > 200 && effects.particles.length <= 512);
  assert.ok(effects.particles.every(particle => particle.position[0] >= 0));
  assert.ok(effects.particles.every(particle => Math.min(Math.hypot(particle.previous[0], particle.previous[1] - 10, particle.previous[2]), Math.hypot(particle.previous[0] - 50, particle.previous[1] - 10, particle.previous[2])) <= 2));
  const spawned = effects.counts.spawned; effects.tick(0.05); assert.equal(effects.counts.spawned, spawned, 'tracker clears after its next native tick');
  effects.event(event); effects.clear(); assert.equal(effects.explosions.length, 0);
});
