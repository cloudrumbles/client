// Schema changes are normalized after decoding with the matching wire codec.
// Registry IDs always stay native to the selected Minecraft version.
import { normalizeParticleOptions } from './particle-options.js';
export const BROWSER_PROTOCOL_VERSIONS = Object.freeze(['1.20.4', '1.21.11', '26.1']);
const MODERN = new Set(['1.21.11', '26.1']);
const MODES = ['survival', 'creative', 'adventure', 'spectator'];
const RELATIVES = ['x', 'y', 'z', 'yaw', 'pitch', 'dx', 'dy', 'dz', 'yawDelta'];

function flagsToNumber(flags) {
  if (typeof flags === 'number') return flags;
  return RELATIVES.reduce((bits, key, index) => bits | (flags?.[key] ? 1 << index : 0), 0);
}

function simplify(value) {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(simplify);
  if (typeof value.type === 'string' && 'value' in value) {
    if (value.type === 'list' && value.value && !Array.isArray(value.value) && 'value' in value.value) return simplify(value.value.value);
    return simplify(value.value);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, simplify(item)]));
}

function gameMode(value) { return typeof value === 'string' ? Math.max(0, MODES.indexOf(value)) : value & 3; }
function angleByte(degrees) { return Math.round(degrees * 256 / 360); }
function legacyInventorySlot(slot) { return slot < 9 ? slot + 36 : slot < 36 ? slot : slot < 40 ? 44 - slot : slot === 40 ? 45 : slot; }

function dimensionInteger(value, name) {
  // Pumpkin's extracted dimension codec can encode these integers as NBT Long.
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) value = BigInt.asIntN(64, (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0));
  if (typeof value === 'bigint') value = Number(value);
  if (!Number.isSafeInteger(value)) throw new Error(`The dimension ${name} must be an exact integer.`);
  return value;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0x82f63b78 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32c(bytes) { let crc = -1; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ -1) >>> 0; }
function littleInt(value) { return [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]; }
function hashInteger(value) { return crc32c([8, ...littleInt(value)]); }
function hashResourceLocation(value) {
  const bytes = [12, ...littleInt(value.length)];
  for (let index = 0; index < value.length; index++) bytes.push(value.charCodeAt(index) & 255, value.charCodeAt(index) >>> 8);
  return crc32c(bytes);
}
function hashMap(entries) {
  if (entries.some(entry => entry[1] === null)) return null;
  const pairs = entries.map(([key, value]) => [hashResourceLocation(key), value >>> 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return crc32c([2, ...pairs.flatMap(([key, value]) => [...littleInt(key), ...littleInt(value)]), 3]);
}
function hashList(hashes) { return hashes.some(hash => hash === null) ? null : crc32c([4, ...hashes.flatMap(littleInt), 5]); }

/** Stateful configuration registries plus common packet/stack schema changes. */
export class ProtocolAdapter {
  constructor(version = '1.20.4', { items = [] } = {}) {
    if (!BROWSER_PROTOCOL_VERSIONS.includes(version)) throw new Error(`Java ${version} has no browser protocol adapter.`);
    this.version = version; this.modern = MODERN.has(version); this.registries = new Map();
    this.itemNames = new Map(items.map(item => [item.id, item.name.includes(':') ? item.name : `minecraft:${item.name}`]));
    this.bundleComponentId = version === '26.1' ? 50 : version === '1.21.11' ? 48 : null;
    this.inputState = { forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false };
    this.features = Object.freeze({ implicitPaletteLengths: this.modern, componentSlots: this.modern, deltaTeleports: this.modern, playerLoaded: this.modern });
  }

  registryName(id, index) { return this.registries.get(id)?.[index]?.key; }

  normalizeSlot(slot, depth = 0) {
    if (!this.modern || !slot) return slot || { present: false };
    if (depth > 16) throw new Error('Item components exceed the nesting limit.');
    if (!slot.itemCount) return { present: false, itemCount: 0 };
    const components = (slot.components || []).flatMap(entry => {
      if (entry.type !== 'bundle_contents') return entry;
      const contents = (entry.data?.contents || []).map(value => {
        if (this.version === '26.1' && (value.itemId === 0 || value.itemCount === 0)) throw new Error('Bundle item templates must be non-empty.');
        return this.normalizeSlot(value, depth + 1);
      });
      if (!contents.length && /(?:^|[:_])bundle$/.test(this.itemNames.get(slot.itemId) || '')) return [];
      return [{ ...entry, data: { ...entry.data, contents } }];
    }), legacy = {};
    for (const component of components) {
      const value = component.data;
      if (component.type === 'custom_data') Object.assign(legacy, simplify(value));
      else if (component.type === 'damage') legacy.Damage = value;
      else if (component.type === 'custom_name') legacy.display = { ...(legacy.display || {}), Name: JSON.stringify(simplify(value)) };
      else if (component.type === 'enchantments' || component.type === 'stored_enchantments') {
        const entries = value?.enchantments || [];
        legacy[component.type === 'enchantments' ? 'Enchantments' : 'StoredEnchantments'] = entries.map(entry => ({ id: this.registryName('minecraft:enchantment', entry.id) || `minecraft:unknown_${entry.id}`, lvl: entry.level }));
      }
    }
    return { ...slot, components, addedComponentCount: components.length, present: true, nbtData: Object.keys(legacy).length ? legacy : undefined };
  }

  protocolSlot(slot) {
    if (!this.modern) return slot;
    if (!slot || slot.present === false || !(slot.itemCount > 0)) return { itemCount: 0 };
    const components = slot.components || [], removeComponents = slot.removeComponents || [];
    return { itemCount: slot.itemCount, itemId: slot.itemId, addedComponentCount: components.length, removedComponentCount: removeComponents.length, components, removeComponents };
  }

  // Pumpkin's DataComponentImpl uses vanilla HashOps CRC32C for these values.
  // Other component predictions are omitted until their actual codec is ported.
  componentHash(component, depth = 0) {
    if (depth > 16) return null;
    const type = String(component.type).replace('minecraft:', '');
    if (['damage', 'max_stack_size', 'max_damage', 'repair_cost', 'map_id'].includes(type) && Number.isInteger(component.data)) return hashInteger(component.data) | 0;
    if (type === 'bundle_contents') {
      const items = component.data?.contents;
      if (!Array.isArray(items) || items.length > 128) return null;
      const hash = hashList(items.map(item => this.itemStackHash(item, depth + 1)));
      return hash === null ? null : hash | 0;
    }
    if (type === 'enchantments' || type === 'stored_enchantments') {
      const entries = [];
      for (const entry of component.data?.enchantments || []) {
        const name = this.registryName('minecraft:enchantment', entry.id);
        if (!name) return null;
        entries.push([name, hashInteger(entry.level)]);
      }
      return hashMap(entries) | 0;
    }
    return null;
  }

  itemStackHash(stack, depth = 0) {
    if (depth > 16 || !stack || stack.present === false || !(stack.itemCount > 0)) return null;
    const name = this.itemNames.get(stack.itemId);
    if (!name || !Number.isInteger(stack.itemCount) || stack.itemCount > 99) return null;
    const entries = [['id', hashResourceLocation(name)]];
    if (this.version !== '26.1' || stack.itemCount !== 1) entries.push(['count', hashInteger(stack.itemCount)]);
    const patch = [];
    for (const value of stack.components || []) {
      const type = String(value.type).replace('minecraft:', '');
      patch.push([`minecraft:${type}`, this.componentHash(value, depth + 1)]);
    }
    for (const value of stack.removeComponents || []) patch.push([`!minecraft:${String(value?.type || value).replace('minecraft:', '')}`, crc32c([2, 3])]);
    if (patch.length) entries.push(['components', hashMap(patch)]);
    return hashMap(entries);
  }

  hashedSlot(slot) {
    if (!slot || slot.present === false || !(slot.itemCount > 0)) return null;
    const components = [];
    for (const component of slot.components || []) {
      const hash = Number.isInteger(component.hash) ? component.hash : this.componentHash(component);
      if (hash === null) return null;
      components.push({ type: component.type, hash });
    }
    return { itemId: slot.itemId, itemCount: slot.itemCount, components, removeComponents: slot.removeComponents || [] };
  }

  clientbound(name, data, state = 'play') {
    if (!this.modern) return { name, data, state };
    if (name === 'registry_data' && Array.isArray(data.entries)) {
      const entries = data.entries.map((entry, id) => {
        let value = simplify(entry.value);
        if (data.id === 'minecraft:dimension_type' && value) {
          value = { ...value };
          for (const key of ['min_y', 'height', 'logical_height']) if (key in value) value[key] = dimensionInteger(value[key], key);
        }
        return { id, key: entry.key, value };
      });
      this.registries.set(data.id, entries);
      data = { ...data, codec: { [data.id]: { value: entries.map(entry => ({ id: entry.id, name: entry.key, element: entry.value })) } } };
    } else if ((name === 'login' || name === 'respawn') && data.worldState) {
      const world = data.worldState, type = this.registryName('minecraft:dimension_type', world.dimension) || world.name;
      data = { ...data, worldType: type, dimension: type, worldName: world.name, gameMode: gameMode(world.gamemode), gamemode: gameMode(world.gamemode), hashedSeed: world.hashedSeed, portalCooldown: world.portalCooldown, seaLevel: world.seaLevel, isDebug: world.isDebug, isFlat: world.isFlat };
    } else if (name === 'position') data = { ...data, flags: flagsToNumber(data.flags) };
    else if (name === 'map_chunk') data = { ...data, implicitPaletteLengths: true };
    else if (name === 'update_time' && data.tickDayTime === false) {
      // The old session represents a paused day clock using a negative value.
      // Paused time zero uses -24000, which still has the same visual phase.
      const time = Array.isArray(data.time) ? (BigInt(data.time[0]) << 32n) | BigInt(data.time[1] >>> 0) : BigInt(data.time);
      data = { ...data, time: time === 0n ? -24000n : -(time < 0n ? -time : time) };
    } else if (name === 'world_particles') {
      const particle = normalizeParticleOptions(data.particle, slot => this.normalizeSlot(slot));
      data = { ...data, particleName: particle?.type, particleData: data.velocityOffset, particles: data.amount, data: particle?.data };
    } else if (name === 'explosion') data = { ...data,
      explosionParticle: normalizeParticleOptions(data.explosionParticle, slot => this.normalizeSlot(slot)),
      blockParticles: (data.blockParticles || []).map(entry => ({ ...entry, data: { ...entry.data, particle: normalizeParticleOptions(entry.data.particle, slot => this.normalizeSlot(slot)) } })) };
    else if (name === 'window_items') data = { ...data, items: data.items.map(slot => this.normalizeSlot(slot)), carriedItem: this.normalizeSlot(data.carriedItem) };
    else if (name === 'set_slot') data = { ...data, item: this.normalizeSlot(data.item) };
    else if (name === 'set_cursor_item') { name = 'set_slot'; data = { windowId: -1, stateId: 0, slot: -1, item: this.normalizeSlot(data.contents) }; }
    else if (name === 'set_player_inventory') { name = 'set_slot'; data = { windowId: -2, stateId: 0, slot: legacyInventorySlot(data.slotId), item: this.normalizeSlot(data.contents) }; }
    else if (name === 'entity_equipment') data = { ...data, equipments: data.equipments.map(entry => ({ ...entry, item: this.normalizeSlot(entry.item) })) };
    else if (name === 'entity_metadata') data = { ...data, metadata: data.metadata.map(entry => entry.type === 'item_stack' || entry.type === 'slot' ? { ...entry, value: this.normalizeSlot(entry.value) } : entry) };
    else if (name === 'entity_update_attributes') data = { ...data, properties: data.properties.map(entry => ({ ...entry, name: entry.key || entry.name })) };
    else if (name === 'entity_velocity' || name === 'spawn_entity') data = { ...data, velocity: data.velocity ? { x: data.velocity.x * 8000, y: data.velocity.y * 8000, z: data.velocity.z * 8000 } : data.velocity };
    else if (name === 'sync_entity_position' || name === 'entity_teleport') {
      const positionSync = name === 'sync_entity_position'; name = 'entity_teleport';
      data = { ...data, positionSync, yawDegrees: data.yaw, pitchDegrees: data.pitch, yaw: angleByte(data.yaw), pitch: angleByte(data.pitch), relativeFlags: flagsToNumber(data.flags) };
    }
    return { name, data, state };
  }

  serverbound(name, data, { yaw = 0, pitch = 0 } = {}) {
    if (!this.modern) return { name, data };
    if (['position', 'position_look', 'look', 'flying'].includes(name)) data = { ...data, flags: { onGround: Boolean(data.onGround), hasHorizontalCollision: Boolean(data.hasHorizontalCollision) } };
    else if (name === 'player_input') { this.inputState = { ...this.inputState, ...data.inputs }; data = { inputs: { ...this.inputState } }; }
    else if (name === 'steer_vehicle') {
      this.inputState = { ...this.inputState, forward: data.forward > 0, backward: data.forward < 0, left: data.sideways > 0, right: data.sideways < 0, jump: Boolean(data.jump & 1), shift: Boolean(data.jump & 2) };
      name = 'player_input'; data = { inputs: { ...this.inputState } };
    } else if (name === 'entity_action' && ['start_sneaking', 'stop_sneaking', 0, 1].includes(data.actionId)) {
      this.inputState.shift = data.actionId === 'start_sneaking' || data.actionId === 0;
      name = 'player_input'; data = { inputs: { ...this.inputState } };
    } else if (name === 'vehicle_move') data = { ...data, onGround: Boolean(data.onGround) };
    else if (name === 'settings') data = { ...data, particleStatus: data.particleStatus || 'all' };
    else if (name === 'use_item') data = { ...data, rotation: { x: yaw, y: pitch } };
    else if (name === 'block_place') data = { ...data, worldBorderHit: Boolean(data.worldBorderHit) };
    else if (name === 'set_creative_slot') data = { ...data, item: this.protocolSlot(data.item) };
    else if (name === 'craft_recipe_request') data = { windowId: data.windowId, recipeId: data.recipeId ?? data.recipe, makeAll: Boolean(data.makeAll) };
    else if (name === 'window_click') data = { ...data, changedSlots: data.changedSlots.map(entry => ({ ...entry, item: this.hashedSlot(entry.item) })), cursorItem: this.hashedSlot(data.cursorItem) };
    return { name, data };
  }
}
