import { test } from 'node:test';
import assert from 'node:assert/strict';
import mc from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { ChunkReader, decodeChunkSections, decodePalettedContainer, MinecraftSession, simplifyNbt, textComponent } from '../src/minecraft.js';
import { GatewayTransport, encodeGatewayValue, decodeGatewayValue } from '../src/transport.js';

const version = '1.20.4';
const data = minecraftData(version);
const stone = data.blocksByName.stone.defaultState;
const clientbound = mc.createSerializer({ state: 'play', isServer: true, version });
const clientread = mc.createDeserializer({ state: 'play', isServer: false, version });
const serverbound = mc.createSerializer({ state: 'play', isServer: false, version });
const serverread = mc.createDeserializer({ state: 'play', isServer: true, version });
const fixture = (name, params) => clientread.parsePacketBuffer(clientbound.createPacketBuffer({ name, params })).data;
const outbound = (name, params) => serverread.parsePacketBuffer(serverbound.createPacketBuffer({ name, params })).data;

function varint(value) {
  const bytes = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}

function palette(bits, values, entries = null) {
  if (bits === 0) return Uint8Array.from([0, ...varint(values[0]), 0]);
  const bytes = [bits];
  if (entries) { bytes.push(...varint(entries.length)); for (const entry of entries) bytes.push(...varint(entry)); }
  const perLong = Math.floor(64 / bits), length = Math.ceil(values.length / perLong);
  bytes.push(...varint(length));
  for (let i = 0; i < length; i++) {
    let word = 0n;
    for (let j = 0; j < perLong && i * perLong + j < values.length; j++) word |= BigInt(values[i * perLong + j]) << BigInt(bits * j);
    for (let b = 7; b >= 0; b--) bytes.push(Number((word >> BigInt(b * 8)) & 255n));
  }
  return Uint8Array.from(bytes);
}

function section(blockData, biome = 1, count = 4096) { return Uint8Array.from([count >>> 8, count & 255, ...blockData, ...palette(0, [biome])]); }
function columns(sections) { return Uint8Array.from(sections.flatMap((bytes) => Array.from(bytes))); }

function session(callbacks = {}) {
  const sent = [], events = [];
  const transport = { packet(name, params) { sent.push(outbound(name, params)); return true; }, send(message) { events.push(message); return true; }, close() {}, async connect() {} };
  const client = new MinecraftSession({ ...callbacks, transport });
  return { client, sent, events };
}
function receive(client, name, params) { const packet = fixture(name, params); client.receive({ type: 'packet', name: packet.name, data: packet.params, state: 'play' }); }
function position(client) { receive(client, 'position', { x: -33.5, y: -24, z: 81.5, yaw: 180, pitch: -15, flags: 0, teleportId: 7 }); }
function login(client) {
  receive(client, 'login', { entityId: 9, isHardcore: false, worldNames: ['minecraft:overworld'], maxPlayers: 20, viewDistance: 8, simulationDistance: 8, reducedDebugInfo: false, enableRespawnScreen: true, doLimitedCrafting: false, worldType: 'minecraft:overworld', worldName: 'minecraft:overworld', hashedSeed: 0n, gameMode: 1, previousGameMode: -1, isDebug: false, isFlat: false, death: undefined, portalCooldown: 0 });
}

test('gateway values preserve nested byte buffers and signed 64-bit values in portable JSON', () => {
  const input = { seed: -9223372036854775808n, packet: { chunkData: Uint8Array.of(0, 1, 128, 255) }, mask: [0n, 18446744073709551615n] };
  const encoded = JSON.stringify(encodeGatewayValue(input));
  assert.equal(encoded.includes('__bytes'), true);
  assert.deepEqual(decodeGatewayValue(JSON.parse(encoded)), input);
  assert.deepEqual(decodeGatewayValue({ type: 'Buffer', data: [1, 2, 255] }), Uint8Array.of(1, 2, 255));
});

test('palettes decode single-value, indirect and direct containers without crossing 64-bit padding', () => {
  const singleton = decodePalettedContainer(new ChunkReader(palette(0, [stone])), 4096);
  assert.equal(singleton[4095], stone);
  const entries = Array.from({ length: 32 }, (_, i) => i === 31 ? data.blocksByName.water.defaultState : i);
  const values = Array.from({ length: 4096 }, (_, i) => (i * 7) % 32);
  const indirect = decodePalettedContainer(new ChunkReader(palette(5, values, entries)), 4096);
  for (const index of [0, 5, 6, 11, 12, 13, 341, 4095]) assert.equal(indirect[index], entries[values[index]], `index ${index}`);
  const directValues = Array.from({ length: 4096 }, (_, i) => (i * 73) % 26000);
  const direct = decodePalettedContainer(new ChunkReader(palette(15, directValues)), 4096);
  assert.deepEqual(Array.from(direct), directValues);
  const biomeValues = Array.from({ length: 64 }, (_, i) => i % 8);
  assert.deepEqual(Array.from(decodePalettedContainer(new ChunkReader(palette(3, biomeValues, Array.from({ length: 8 }, (_, i) => i + 10))), 64, 'biomes')), biomeValues.map((i) => i + 10));
});

test('chunk sections retain negative section Y and native y,z,x state order', () => {
  const values = Array(4096).fill(0); values[(15 * 16 + 3) * 16 + 7] = stone;
  const result = decodeChunkSections(columns([section(palette(15, values), 5, 1), section(palette(0, [0]), 6, 0)]), { minY: -64, height: 32 });
  assert.equal(result[0].sectionY, -4); assert.equal(result[1].sectionY, -3);
  assert.equal(result[0].blocks[(15 * 16 + 3) * 16 + 7], stone);
  assert.equal(result[0].biomes[63], 5);
  assert.throws(() => decodeChunkSections(Uint8Array.of(0, 0), { minY: -64, height: 16 }), /Truncated/);
  assert.throws(() => decodePalettedContainer(new ChunkReader(Uint8Array.of(0, 1, 1)), 4096), /unexpected data/);
  assert.throws(() => decodePalettedContainer(new ChunkReader(Uint8Array.of(4, 1, 0, 0)), 4096), /expected/);
});

test('configuration registry determines dimension bounds before actual login', () => {
  const states = [];
  const { client } = session({ onState: (state) => states.push(state) });
  const nbt = { type: 'compound', value: { 'minecraft:dimension_type': { type: 'compound', value: { value: { type: 'list', value: { type: 'compound', value: [{ name: { type: 'string', value: 'minecraft:overworld' }, id: { type: 'int', value: 0 }, element: { type: 'compound', value: { min_y: { type: 'int', value: -64 }, height: { type: 'int', value: 384 }, has_skylight: { type: 'byte', value: 1 } } } }] } } } } } };
  const serializer = mc.createSerializer({ state: 'configuration', isServer: true, version });
  const reader = mc.createDeserializer({ state: 'configuration', isServer: false, version });
  const packet = reader.parsePacketBuffer(serializer.createPacketBuffer({ name: 'registry_data', params: { codec: nbt } })).data;
  client.receive({ type: 'packet', name: packet.name, data: packet.params, state: 'configuration' });
  login(client);
  assert.equal(client.state.minY, -64); assert.equal(client.state.height, 384); assert.equal(client.state.hasSkylight, true);
  assert.equal(client.state.gameMode, 1); assert.equal(client.state.entityId, 9);
  assert.equal(states.at(-1).status, 'loading');
});

test('real teleport packets apply relative flags, acknowledge and send correct camera angles', () => {
  const positions = [];
  const { client, sent } = session({ onPosition: (p) => positions.push(p) });
  position(client);
  assert.deepEqual(sent[0], { name: 'teleport_confirm', params: { teleportId: 7 } });
  assert.equal(sent[1].params.yaw, 180); assert.equal(sent[1].params.pitch, -15);
  receive(client, 'position', { x: 2, y: 3, z: -4, yaw: 90, pitch: 5, flags: 31, teleportId: 8 });
  assert.equal(positions[1].x, -31.5); assert.equal(positions[1].y, -21); assert.equal(positions[1].z, 77.5);
  assert.ok(Math.abs(positions[1].yaw - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(positions[1].pitch - 10 * Math.PI / 180) < 1e-6);
  client.acknowledgePosition(positions[1].teleportId);
  const before = sent.length;
  const player = { position: [-30, -21, 78], yaw: Math.PI / 2, pitch: -0.2, grounded: true };
  client.tick(player, 0.025); assert.equal(sent.length, before);
  client.tick(player, 0.025); assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).params.yaw, 270); assert.equal(sent.at(-1).params.onGround, true);
});

test('real chunk, block update, lighting and unload packets preserve server state IDs', () => {
  const loaded = [], changed = [], unloaded = [];
  const { client, sent } = session({ onSection: (s) => loaded.push(s), onBlock: (b) => changed.push(b), onUnload: (c) => unloaded.push(c) });
  client.state.minY = -64; client.state.height = 16;
  const chunkData = section(palette(0, [stone]), 1);
  receive(client, 'map_chunk', { x: -2, z: 3, heightmaps: { type: 'compound', value: {} }, chunkData, blockEntities: [], skyLightMask: [2n], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [2n], skyLight: [Array(2048).fill(255)], blockLight: [] });
  assert.equal(loaded[0].chunkX, -2); assert.equal(loaded[0].sectionY, -4);
  assert.equal(loaded[0].blocks[4095], stone);
  assert.equal(client.columns.get('-2,3').light.sky.get(-4)[0], 255);
  assert.equal(client.columns.get('-2,3').light.block.get(-4)[0], 0);
  receive(client, 'update_light', { chunkX: -2, chunkZ: 3, skyLightMask: [], blockLightMask: [2n], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [Array(2048).fill(15)] });
  assert.equal(client.columns.get('-2,3').light.sky.get(-4)[0], 255, 'partial lighting updates retain sky data');
  assert.equal(client.columns.get('-2,3').light.block.get(-4)[0], 15);
  receive(client, 'block_change', { location: { x: -31, y: -63, z: 49 }, type: 0 });
  assert.deepEqual(changed[0], { x: -31, y: -63, z: 49, stateId: 0 });
  assert.equal(loaded[0].blocks[(1 * 16 + 1) * 16 + 1], 0);
  receive(client, 'multi_block_change', { chunkCoordinates: { x: -2, y: -4, z: 3 }, records: [stone * 4096 + (15 << 8) + (2 << 4) + 5] });
  assert.deepEqual(changed[1], { x: -17, y: -59, z: 50, stateId: stone });
  receive(client, 'chunk_batch_finished', { batchSize: 1 });
  assert.deepEqual(sent.at(-1), { name: 'chunk_batch_received', params: { chunksPerTick: 4 } });
  receive(client, 'unload_chunk', { chunkX: -2, chunkZ: 3 });
  assert.deepEqual(unloaded[0], { x: -2, z: 3 }); assert.equal(client.columns.size, 0);
});

test('digging, placement, hotbar and creative slots serialize valid authoritative actions', () => {
  const changed = [];
  const { client, sent } = session({ onBlock: (block) => changed.push(block) });
  position(client); client.state.gameMode = 0;
  const hit = [-31, -63, 49, -32, -63, 49, stone];
  client.dig(hit); assert.equal(sent.at(-1).name, 'block_dig'); assert.equal(sent.at(-1).params.status, 0); assert.equal(sent.at(-1).params.face, 4);
  client.dig(hit, { phase: 'finish' }); assert.equal(sent.at(-1).params.status, 2);
  client.dig(hit); client.cancelDig(); assert.equal(sent.at(-1).params.status, 1);
  client.place(hit); assert.equal(sent.at(-1).name, 'block_place'); assert.equal(sent.at(-1).params.direction, 4);
  assert.deepEqual(sent.at(-1).params.location, { x: -31, y: -63, z: 49 });
  assert.equal(changed.length, 0, 'actions must wait for authoritative block packets');
  assert.equal(client.setCreativeSlot(data.itemsByName.stone.id), false);
  client.state.gameMode = 1; assert.equal(client.setCreativeSlot(data.itemsByName.stone.id), true);
  assert.equal(sent.at(-1).params.slot, 36); assert.equal(sent.at(-1).params.item.itemId, data.itemsByName.stone.id);
  client.selectHotbar(8); assert.deepEqual(sent.at(-1), { name: 'held_item_slot', params: { slotId: 8 } });
  client.respawn(); assert.equal(sent.at(-1).params.actionId, 'perform_respawn');
  client.sneak(true); assert.equal(sent.at(-1).params.actionId, 'start_sneaking');
  assert.equal(client.setFlying(true), false);
  receive(client, 'abilities', { flags: 5, flyingSpeed: 0.05, walkingSpeed: 0.1 });
  assert.equal(client.setFlying(true), true); assert.equal(sent.at(-1).params.flags, 2); assert.equal(client.state.flying, true);
  client.releaseItem(); assert.equal(sent.at(-1).params.status, 5);
  client.dropItem(); assert.equal(sent.at(-1).params.status, 4);
  client.dropItem(true); assert.equal(sent.at(-1).params.status, 3);
  client.swapHands(); assert.equal(sent.at(-1).params.status, 6);
});

test('server inventory, health, time and NBT chat update independently of gameplay actions', () => {
  const inventories = [], times = [], events = [];
  const { client, sent, events: gateway } = session({ onInventory: (i) => inventories.push(i), onTime: (t) => times.push(t), onEvent: (e) => events.push(e) });
  position(client);
  const slots = Array.from({ length: 46 }, () => ({ present: false })); slots[36] = { present: true, itemId: data.itemsByName.stone.id, itemCount: 32, nbtData: undefined };
  receive(client, 'window_items', { windowId: 0, stateId: 4, items: slots, carriedItem: { present: false } });
  assert.equal(inventories[0].slots[36].itemCount, 32);
  client.clickWindow(36); assert.equal(sent.at(-1).params.stateId, 4); assert.equal(sent.at(-1).params.slot, 36);
  assert.equal(sent.at(-1).params.changedSlots[0].item.present, false);
  assert.equal(sent.at(-1).params.cursorItem.itemCount, 32);
  assert.equal(client.windows.get(0).slots[36].present, false, 'accepted predictions need no server echo');
  assert.equal(client.windows.get(0).cursor.itemCount, 32);
  assert.equal(client.windows.get(0).stateId, 4, 'client prediction preserves the server transaction revision');
  receive(client, 'set_slot', { windowId: 0, stateId: 5, slot: 36, item: { present: true, itemId: data.itemsByName.stone.id, itemCount: 32, nbtData: undefined } });
  receive(client, 'set_slot', { windowId: -1, stateId: 5, slot: -1, item: { present: false } });
  assert.equal(client.windows.get(0).slots[36].itemCount, 32, 'server rejection restores the authoritative stack');
  assert.equal(client.windows.get(0).cursor.present, false);
  receive(client, 'set_slot', { windowId: 0, stateId: 5, slot: 36, item: { present: false } }); assert.equal(inventories.at(-1).slots[36].present, false);
  receive(client, 'update_health', { health: 8, food: 13, foodSaturation: 2 }); assert.equal(client.state.health, 8); assert.equal(client.state.food, 13);
  receive(client, 'update_time', { age: 1234567890123n, time: -6000n }); assert.equal(times[0].timeOfDay, 6000); assert.equal(times[0].daylightCycle, false);
  receive(client, 'system_chat', { content: { type: 'compound', value: { text: { type: 'string', value: 'Hello ' }, extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'world' } }] } } } }, isActionBar: false });
  assert.equal(events.at(-1).text, 'Hello world');
  client.chat('/time set day'); assert.deepEqual(gateway.at(-1), { type: 'chat', text: '/time set day' });
  assert.equal(textComponent({ translate: 'chat.type.text', with: [{ text: 'Alex' }, { text: 'Hi' }] }), '<Alex> Hi');
  assert.deepEqual(simplifyNbt({ type: 'list', value: { type: 'int', value: [1, 2] } }), [1, 2]);
});

test('inventory right-click applies accepted half-stack prediction and chains without an echo', () => {
  const { client, sent } = session();
  const itemId = data.itemsByName.stone.id;
  receive(client, 'window_items', { windowId: 0, stateId: 10, items: Array.from({ length: 46 }, (_, slot) => slot === 36 ? { present: true, itemId, itemCount: 31, nbtData: undefined } : { present: false }), carriedItem: { present: false } });
  client.clickWindow(36, { button: 1 });
  assert.equal(sent.at(-1).params.cursorItem.itemCount, 16);
  assert.equal(sent.at(-1).params.changedSlots[0].item.itemCount, 15);
  assert.equal(client.windows.get(0).slots[36].itemCount, 15);
  client.clickWindow(37, { button: 1 });
  assert.equal(sent.at(-1).params.cursorItem.itemCount, 15);
  assert.equal(sent.at(-1).params.changedSlots[0].item.itemCount, 1);
  assert.equal(client.windows.get(0).slots[37].itemCount, 1);
  assert.equal(client.windows.get(0).cursor.itemCount, 15);
});

test('real entity packets maintain relative movement and removals', () => {
  const entities = [];
  const { client } = session({ onEntity: (e) => entities.push(e) });
  receive(client, 'spawn_entity', { entityId: 44, objectUUID: '12345678-1234-1234-1234-123456789012', type: data.entitiesByName.pig.id, x: -32, y: 65, z: 48, pitch: 0, yaw: 64, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
  receive(client, 'rel_entity_move', { entityId: 44, dX: 2048, dY: 4096, dZ: -1024, onGround: true });
  assert.equal(client.entities.get(44).x, -31.5); assert.equal(client.entities.get(44).y, 66); assert.equal(client.entities.get(44).z, 47.75);
  receive(client, 'entity_destroy', { entityIds: [44] }); assert.equal(client.entities.size, 0); assert.deepEqual(entities.at(-1), { type: 'remove', id: 44 });
});

test('entity interaction and knockback serialize and preserve the server authority', () => {
  const entities = [];
  const { client, sent } = session({ onEntity: (e) => entities.push(e) });
  position(client); client.state.entityId = 9;
  receive(client, 'spawn_entity', { entityId: 44, objectUUID: '12345678-1234-1234-1234-123456789012', type: data.entitiesByName.pig.id, x: -32, y: 65, z: 48, pitch: 0, yaw: 64, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
  client.attackEntity(44); assert.equal(sent.at(-1).params.mouse, 1); assert.equal(sent.at(-1).params.target, 44);
  client.interactEntity(44); assert.equal(sent.at(-1).params.mouse, 0); assert.equal(sent.at(-1).params.hand, 0);
  client.interactEntity(44, { point: [0.2, 0.8, 0.1] }); assert.equal(sent.at(-1).params.mouse, 2); assert.ok(Math.abs(sent.at(-1).params.y - 0.8) < 1e-6);
  receive(client, 'entity_velocity', { entityId: 9, velocity: { x: 4000, y: 2400, z: -800 } });
  assert.deepEqual(entities.at(-1), { type: 'player-velocity', id: 9, velocity: { x: 0.5, y: 0.3, z: -0.1 }, additive: false, motionRevision: 1 });
  const before = sent.length;
  receive(client, 'keep_alive', { keepAliveId: 123456789n }); assert.equal(sent.length, before, 'gateway handles keepalives');
  client.keepAliveManaged = false; receive(client, 'keep_alive', { keepAliveId: 123456789n }); assert.equal(sent.at(-1).name, 'keep_alive');
});

test('real status effects, attributes, experience and clock packets update the local player', () => {
  const events = [], times = [];
  const { client } = session({ onEvent: (event) => events.push(event), onTime: (time) => times.push(time) });
  login(client); position(client);
  receive(client, 'entity_effect', { entityId: 9, effectId: 2, amplifier: 1, duration: 1200, hideParticles: 0, factorCodec: undefined });
  assert.deepEqual(client.state.effects, [{ id: 2, name: 'haste', amplifier: 1, duration: 1200 }]);
  receive(client, 'entity_effect', { entityId: 9, effectId: 3, amplifier: 0, duration: 600, hideParticles: 0, factorCodec: undefined });
  assert.equal(client.state.effects.length, 2);
  receive(client, 'remove_entity_effect', { entityId: 9, effectId: 2 });
  assert.equal(client.state.effects.length, 1); assert.equal(client.state.effects[0].name, 'mining_fatigue');
  receive(client, 'entity_update_attributes', { entityId: 9, properties: [{ name: 'minecraft:generic.movement_speed', value: 0.1, modifiers: [] }] });
  receive(client, 'entity_update_attributes', { entityId: 9, properties: [{ name: 'minecraft:generic.max_health', value: 20, modifiers: [] }] });
  assert.equal(client.state.attributes.length, 2, 'partial attribute packets retain earlier values');
  receive(client, 'experience', { experienceBar: 0.5, level: 7, totalExperience: 100 });
  assert.equal(client.state.experienceLevel, 7); assert.equal(client.state.experience, 0.5);
  receive(client, 'damage_event', { entityId: 9, sourceTypeId: 1, sourceCauseId: 0, sourceDirectId: 0, sourcePosition: undefined });
  assert.equal(events.at(-1).type, 'player-damage');
  receive(client, 'update_time', { age: 9999999999999n, time: 30000n });
  assert.equal(times.at(-1).timeOfDay, 6000); assert.equal(times.at(-1).worldAge, 9999999999999n); assert.equal(times.at(-1).daylightCycle, true);
});

test('transport sends exactly one supported-version connection request and isolates retired sockets', async () => {
  class Socket extends EventTarget {
    constructor() { super(); this.readyState = 0; this.sent = []; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  }
  const sockets = [], messages = [];
  const transport = new GatewayTransport({ socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; }, onMessage: (m) => messages.push(m) });
  const pending = transport.connect('ws://localhost:5174', { host: 'example.org', username: 'Alex', auth: 'offline', version: '1.21.11' });
  sockets[0].open(); await pending;
  assert.equal(sockets[0].sent.length, 1); assert.equal(sockets[0].sent[0].version, '1.21.11');
  transport.close(); const retired = new MessageEvent('message', { data: JSON.stringify({ type: 'connected' }) }); sockets[0].dispatchEvent(retired); assert.equal(messages.length, 0);
});
