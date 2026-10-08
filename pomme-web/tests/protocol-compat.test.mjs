import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { ProtocolAdapter } from '../src/protocol-compat.js';

const version = '1.21.11';
const writer = minecraftProtocol.createSerializer({ state: 'play', isServer: false, version });
const reader = minecraftProtocol.createDeserializer({ state: 'play', isServer: true, version });
function outbound(adapter, name, data, options) {
  const packet = adapter.serverbound(name, data, options);
  return reader.parsePacketBuffer(writer.createPacketBuffer({ name: packet.name, params: packet.data })).data.params;
}

test('modern configuration registries resolve numeric spawn dimensions without remapping block IDs', () => {
  const adapter = new ProtocolAdapter(version);
  const dimension = { type: 'compound', value: { min_y: { type: 'int', value: -64 }, height: { type: 'int', value: 384 }, has_skylight: { type: 'byte', value: 1 } } };
  const registry = adapter.clientbound('registry_data', { id: 'minecraft:dimension_type', entries: [{ key: 'minecraft:overworld', value: dimension }] }, 'configuration');
  assert.deepEqual(registry.data.codec['minecraft:dimension_type'].value[0].element, { min_y: -64, height: 384, has_skylight: 1 });
  const pumpkinDimension = { type: 'compound', value: { min_y: { type: 'long', value: [-1, -64] }, height: { type: 'long', value: [0, 384] }, logical_height: { type: 'long', value: [0, 384] } } };
  const pumpkinRegistry = adapter.clientbound('registry_data', { id: 'minecraft:dimension_type', entries: [{ key: 'minecraft:overworld', value: pumpkinDimension }] }, 'configuration');
  assert.deepEqual(pumpkinRegistry.data.codec['minecraft:dimension_type'].value[0].element, { min_y: -64, height: 384, logical_height: 384 });
  const login = adapter.clientbound('login', minecraftData(version).loginPacket);
  assert.equal(login.data.worldType, 'minecraft:overworld');
  assert.equal(login.data.gameMode, 0);
  const blocks = new Uint8Array([1, 2, 3]);
  const chunk = adapter.clientbound('map_chunk', { chunkData: blocks });
  assert.strictEqual(chunk.data.chunkData, blocks);
  assert.equal(chunk.data.implicitPaletteLengths, true);
  assert.throws(() => new ProtocolAdapter('26.3'), /no browser protocol adapter/);
});

test('modern movement flags, use-item rotation and creative stacks serialize through the actual protocol codec', () => {
  const adapter = new ProtocolAdapter(version);
  const position = outbound(adapter, 'position_look', { x: 8, y: 70, z: -8, yaw: 90, pitch: -15, onGround: true });
  assert.equal(position.flags.onGround, true);
  assert.equal(position.flags.hasHorizontalCollision, false);
  assert.equal(position.x, 8);
  const use = outbound(adapter, 'use_item', { hand: 0, sequence: 5 }, { yaw: 180, pitch: -30 });
  assert.deepEqual(use.rotation, { x: 180, y: -30 });
  const placed = outbound(adapter, 'block_place', { hand: 0, sequence: 6, location: { x: 8, y: 69, z: -8 }, direction: 1, cursorX: 0.5, cursorY: 1, cursorZ: 0.5, insideBlock: false });
  assert.equal(placed.worldBorderHit, false);
  const creative = outbound(adapter, 'set_creative_slot', { slot: 36, item: { present: true, itemCount: 64, itemId: 1, nbtData: undefined } });
  assert.equal(creative.item.itemCount, 64);
  assert.equal(creative.item.addedComponentCount, 0);
  assert.equal(outbound(adapter, 'set_creative_slot', { slot: 36, item: { present: false } }).item.itemCount, 0);
});

test('component stacks retain server data and use source-backed hashes for inventory prediction', () => {
  const adapter = new ProtocolAdapter(version);
  adapter.clientbound('registry_data', { id: 'minecraft:enchantment', entries: [{ key: 'minecraft:sharpness', value: {} }] }, 'configuration');
  // Independent expected values from Pumpkin's HashOps-compatible Rust tests.
  assert.equal(adapter.componentHash({ type: 'max_stack_size', data: 99 }), -1632321551);
  assert.equal(adapter.componentHash({ type: 'enchantments', data: { enchantments: [{ id: 0, level: 2 }] } }), -1580618251);
  const stack = adapter.normalizeSlot({ itemId: 1, itemCount: 12, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'damage', data: 3 }], removeComponents: [] });
  assert.equal(stack.present, true);
  assert.equal(stack.nbtData.Damage, 3);
  assert.deepEqual(adapter.protocolSlot(stack).components, stack.components);
  const click = outbound(adapter, 'window_click', { windowId: 0, stateId: 1, slot: 36, mouseButton: 0, mode: 0, changedSlots: [{ location: 36, item: { present: false } }], cursorItem: stack });
  assert.equal(click.changedSlots[0].item, undefined);
  assert.equal(click.cursorItem.itemCount, 12);
  assert.equal(click.cursorItem.components[0].hash, -499649379);
  assert.equal(adapter.hashedSlot({ ...stack, components: [{ type: 'custom_name', data: { type: 'string', value: 'Named item' } }] }), null);
});

test('modern inventory indices, frozen day clocks and entity position sync preserve native semantics', () => {
  const adapter = new ProtocolAdapter(version);
  const item = { itemId: 1, itemCount: 2, components: [], removeComponents: [] };
  assert.equal(adapter.clientbound('set_player_inventory', { slotId: 0, contents: item }).data.slot, 36);
  assert.equal(adapter.clientbound('set_player_inventory', { slotId: 36, contents: item }).data.slot, 8);
  assert.equal(adapter.clientbound('set_player_inventory', { slotId: 40, contents: item }).data.slot, 45);
  assert.equal(adapter.clientbound('set_cursor_item', { contents: item }).data.windowId, -1);
  assert.equal(adapter.clientbound('update_time', { age: 100n, time: 0n, tickDayTime: false }).data.time, -24000n);
  assert.equal(adapter.clientbound('position', { flags: { x: true, yaw: true, dz: true } }).data.flags, 137);
  const teleport = adapter.clientbound('sync_entity_position', { entityId: 4, x: -1, y: 65, z: 5, yaw: -90, pitch: 45, onGround: true });
  assert.equal(teleport.name, 'entity_teleport');
  assert.equal(teleport.data.yaw, -64);
  assert.equal(teleport.data.pitch, 32);
  const velocity = adapter.clientbound('entity_velocity', { entityId: 4, velocity: { x: 0.25, y: 0.125, z: 0 } });
  assert.deepEqual(velocity.data.velocity, { x: 2000, y: 1000, z: 0 });
  const legacy = new ProtocolAdapter('1.20.4'), data = { item: { present: true, itemCount: 5, itemId: 1 } };
  assert.strictEqual(legacy.clientbound('set_slot', data).data, data);
});
