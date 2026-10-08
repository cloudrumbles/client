import { GatewayTransport } from './transport.js';
import { ProtocolAdapter } from './protocol-compat.js';
import { vehicleStateFromEntity } from './vehicle.js';
import { predictInventoryClick, isFurnaceFuel, bundleView } from './inventory-prediction.js';
import { textComponent, MinecraftChatTypes } from './text.js';
import { MinecraftRecipeBook } from './recipe-book.js';
export { textComponent } from './text.js';

const TAU = Math.PI * 2;
const DEGREES = 180 / Math.PI;
const EMPTY_SLOT = Object.freeze({ present: false });

// Vanilla PositionMoveRotation.calculateAbsolute, with motion in blocks/tick.
// Vec3 rotates pitch before yaw; ROTATE_DELTA rotates the old motion before
// the DELTA_X/Y/Z flags select which packet components to add.
function resolveCorrection(base, data, flags, velocity, modern = true) {
  const yaw = (flags & 8 ? base.yaw : 0) + data.yaw;
  const pitch = Math.max(-90, Math.min(90, (flags & 16 ? base.pitch : 0) + data.pitch));
  let { x: vx, y: vy, z: vz } = velocity;
  if (modern && flags & 256) {
    const rx = (base.pitch - pitch) / DEGREES, ry = (base.yaw - yaw) / DEGREES;
    const cy = Math.cos(rx), sy = Math.sin(rx), cz = Math.cos(ry), sz = Math.sin(ry);
    const rotatedY = vy * cy + vz * sy, rotatedZ = vz * cy - vy * sy;
    [vx, vy, vz] = [vx * cz + rotatedZ * sz, rotatedY, rotatedZ * cz - vx * sz];
  }
  return {
    x: data.x + (flags & 1 ? base.x : 0), y: data.y + (flags & 2 ? base.y : 0), z: data.z + (flags & 4 ? base.z : 0), yaw, pitch,
    velocity: modern ? { x: (flags & 32 ? vx : 0) + (data.dx ?? 0), y: (flags & 64 ? vy : 0) + (data.dy ?? 0), z: (flags & 128 ? vz : 0) + (data.dz ?? 0) }
      : { x: flags & 1 ? vx : 0, y: flags & 2 ? vy : 0, z: flags & 4 ? vz : 0 },
  };
}

export class ChunkReader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = Uint8Array.from(bytes || []);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }
  require(length) { if (this.offset + length > this.bytes.length) throw new Error('Truncated chunk data.'); }
  u8() { this.require(1); return this.bytes[this.offset++]; }
  u16() { this.require(2); const value = this.view.getUint16(this.offset); this.offset += 2; return value; }
  varint() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      value += (byte & 127) * 2 ** (i * 7);
      if (!(byte & 128)) {
        if (value > 0x7fffffff) throw new Error('Negative or overflowing chunk VarInt.');
        return value;
      }
    }
    throw new Error('Chunk VarInt exceeds five bytes.');
  }
}

// Since 1.16, values do not straddle the 64-bit words. A five-bit palette
// stores twelve entries per word and leaves the top four bits unused.
export function decodePalettedContainer(reader, size, kind = 'blocks', implicitLength = false) {
  const encodedBits = reader.u8();
  const maxIndirect = kind === 'biomes' ? 3 : 8;
  const minimum = kind === 'biomes' ? 1 : 4;
  const output = kind === 'biomes' ? new Uint32Array(size) : new Uint16Array(size);
  if (encodedBits === 0) {
    const singleton = reader.varint();
    if (kind !== 'biomes' && singleton > 65535) throw new Error('Block state exceeds supported 1.20.4 range.');
    output.fill(singleton);
    if (!implicitLength && reader.varint() !== 0) throw new Error('Single-value palette has unexpected data.');
    return output;
  }
  const bits = Math.max(encodedBits, minimum);
  if (bits > 16) throw new Error(`Unsupported ${kind} palette width ${bits}.`);
  let palette = null;
  if (bits <= maxIndirect) {
    const count = reader.varint();
    if (!count || count > 2 ** bits) throw new Error('Invalid palette size.');
    palette = new Uint32Array(count);
    for (let i = 0; i < count; i++) palette[i] = reader.varint();
  }
  const perLong = Math.floor(64 / bits);
  const count = implicitLength ? Math.ceil(size / perLong) : reader.varint();
  if (count !== Math.ceil(size / perLong)) throw new Error(`Palette has ${count} words; expected ${Math.ceil(size / perLong)}.`);
  reader.require(count * 8);
  const mask = 2 ** bits - 1;
  let index = 0;
  for (let word = 0; word < count; word++) {
    const high = reader.view.getUint32(reader.offset);
    const low = reader.view.getUint32(reader.offset + 4);
    reader.offset += 8;
    for (let entry = 0; entry < perLong && index < size; entry++, index++) {
      const shift = entry * bits;
      let value;
      if (shift >= 32) value = (high >>> (shift - 32)) & mask;
      else if (shift + bits <= 32) value = (low >>> shift) & mask;
      else value = ((low >>> shift) | (high << (32 - shift))) & mask;
      if (palette) {
        if (value >= palette.length) throw new Error('Chunk references missing palette entry.');
        value = palette[value];
      }
      if (kind !== 'biomes' && value > 65535) throw new Error('Block state exceeds supported 1.20.4 range.');
      output[index] = value;
    }
  }
  return output;
}

export function decodeChunkSections(bytes, { minY = -64, height = 384, implicitPaletteLengths = false } = {}) {
  if (minY % 16 || height % 16 || height <= 0 || height > 4096) throw new Error('Invalid dimension section bounds.');
  const reader = new ChunkReader(bytes);
  const sections = [];
  for (let i = 0; i < height / 16; i++) {
    const nonAirCount = reader.u16();
    if (nonAirCount > 4096) throw new Error('Invalid section block count.');
    const blocks = decodePalettedContainer(reader, 4096, 'blocks', implicitPaletteLengths);
    const biomes = decodePalettedContainer(reader, 64, 'biomes', implicitPaletteLengths);
    sections.push({ sectionY: minY / 16 + i, nonAirCount, blocks, biomes });
  }
  if (reader.offset !== reader.bytes.length) throw new Error(`Unexpected trailing chunk data (${reader.bytes.length - reader.offset} bytes).`);
  return sections;
}

export function simplifyNbt(value) {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(simplifyNbt);
  if (typeof value.type === 'string' && 'value' in value) {
    if (value.type === 'list' && value.value && !Array.isArray(value.value) && 'value' in value.value) return simplifyNbt(value.value.value);
    return simplifyNbt(value.value);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, simplifyNbt(item)]));
}

function asLong(value) {
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value) && value.length === 2) return BigInt.asIntN(64, (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0));
  return BigInt(value || 0);
}

function blockHit(hit) {
  if (!hit) return null;
  const list = Array.isArray(hit) || ArrayBuffer.isView(hit);
  const location = list ? { x: hit[0], y: hit[1], z: hit[2] } : { x: hit.x, y: hit.y, z: hit.z };
  if (!Object.values(location).every(Number.isInteger)) return null;
  let face = list ? undefined : hit.face;
  const previous = list ? [hit[3], hit[4], hit[5]] : hit.previous || hit.prev;
  if (face === undefined && previous) {
    const p = Array.isArray(previous) ? previous : [previous.x, previous.y, previous.z];
    const delta = p.map((v, i) => v - [location.x, location.y, location.z][i]);
    face = delta[1] < 0 ? 0 : delta[1] > 0 ? 1 : delta[2] < 0 ? 2 : delta[2] > 0 ? 3 : delta[0] < 0 ? 4 : 5;
  }
  return { location, face: Number.isInteger(face) && face >= 0 && face <= 5 ? face : 1, source: hit };
}

export class MinecraftSession {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.adapter = new ProtocolAdapter(callbacks.registry?.version?.minecraftVersion || '1.20.4', { items: callbacks.registry?.items });
    this.itemDefinitions = new Map((callbacks.registry?.items || []).map((item) => [item.id, item]));
    this.playerMetadataKeys = callbacks.registry?.entities?.find(entity => entity.name === 'player')?.metadataKeys || ['shared_flags', 'air_supply', 'custom_name', 'custom_name_visible', 'silent', 'no_gravity', 'pose', 'ticks_frozen', 'living_entity_flags', 'health', 'effect_color', 'effect_ambience', 'arrow_count', 'stinger_count', 'sleeping_pos', 'player_absorption'];
    this.transport = callbacks.transport || new GatewayTransport({
      socketFactory: callbacks.socketFactory,
      onMessage: (message) => this.receive(message),
      onClose: ({ reason }) => this.changeState({ status: 'disconnected', reason }),
      onError: (error) => this.event({ type: 'error', message: error.message }),
    });
    this.dimensionTypes = new Map();
    this.columns = new Map();
    this.entities = new Map();
    this.players = new Map();
    this.windows = new Map();
    this.menus = new Map();
    this.itemTags = new Map(); this.quickCraft = null;
    this.entityTags = new Map();
    this.recipes = new Map(); this.recipeProperties = new Map();
    this.chatTypes = new MinecraftChatTypes();
    this.recipeBook = new MinecraftRecipeBook({ normalizeSlot: slot => this.adapter.normalizeSlot(slot), getTags: () => this.itemTags, getFuelIds: () => [...this.itemDefinitions.values()].filter(item => isFurnaceFuel(item, this.itemTags)).map(item => item.id) });
    this.state = { status: 'disconnected', minY: -64, height: 384, gameMode: 0, entityId: null, health: 20, food: 20, airSupply: 300, absorption: 0, selectedSlot: 0, usingItem: false, usingHand: 0, invisible: false, leftHanded: false };
    this.position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, grounded: false };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.pendingRespawn = null; this.defaultSpawn = { x: 0, y: 0, z: 0 };
    this.pendingCorrection = null; this.pendingMotion = null; this.motionRevision = 0;
    this.hasPosition = false;
    this.movementClock = 0;
    this.sequence = 0;
    this.pendingDig = null;
    this.keepAliveManaged = true;
    this.chunksPerTick = Math.max(1, Math.min(16, Number(callbacks.chunksPerTick) || 4));
    this.effects = new Map();
  }

  event(event) { this.callbacks.onEvent?.(event); }
  motion(velocity, additive = false) {
    this.velocity = additive ? { x: this.velocity.x + velocity.x, y: this.velocity.y + velocity.y, z: this.velocity.z + velocity.z } : { ...velocity };
    const revision = ++this.motionRevision;
    this.pendingMotion = { revision, velocity: { ...this.velocity } };
    if (this.pendingRespawn) this.pendingRespawn.velocity = [this.velocity.x * 20, this.velocity.y * 20, this.velocity.z * 20];
    if (this.pendingCorrection) this.pendingCorrection.velocity = [this.velocity.x * 20, this.velocity.y * 20, this.velocity.z * 20];
    return { type: 'player-velocity', id: this.state.entityId, velocity: { ...velocity }, additive, motionRevision: revision };
  }
  acknowledgePosition(teleportId) {
    if (this.pendingCorrection?.teleportId !== teleportId) return;
    const revision = this.pendingCorrection.motionRevision;
    this.pendingCorrection = null;
    if (this.pendingMotion?.revision <= revision) this.pendingMotion = null;
  }
  acknowledgeMotion(revision) { if (this.pendingMotion?.revision === revision) this.pendingMotion = null; }
  changeState(patch) { Object.assign(this.state, patch); this.callbacks.onState?.({ ...this.state }); }
  packet(name, data = {}) {
    const packet = this.adapter.serverbound(name, data, { yaw: this.position.yaw * DEGREES + 180, pitch: -this.position.pitch * DEGREES });
    return this.transport.packet(packet.name, packet.data);
  }

  connect(url, options = {}) {
    this.disconnect();
    this.chatTypes.clear();
    this.recipeBook.clear();
    this.columns.clear(); this.entities.clear(); this.players.clear(); this.windows.clear(); this.menus.clear(); this.itemTags.clear(); this.entityTags.clear(); this.recipes.clear(); this.recipeProperties.clear(); this.quickCraft = null; this.dimensionTypes.clear(); this.effects.clear();
    this.hasPosition = false; this.sequence = 0; this.movementClock = 0;
    this.velocity = { x: 0, y: 0, z: 0 }; this.localVehicle = null;
    this.pendingRespawn = null; this.defaultSpawn = { x: 0, y: 0, z: 0 };
    this.pendingCorrection = null; this.pendingMotion = null; this.motionRevision = 0;
    this.adapter = new ProtocolAdapter(options.version || this.callbacks.registry?.version?.minecraftVersion || '1.20.4', { items: this.callbacks.registry?.items });
    this.changeState({ status: 'connecting', username: options.username, host: options.host, minY: -64, height: 384, gameMode: 0, selectedSlot: 0, health: 20, food: 20, airSupply: 300, absorption: 0, effects: [], attributes: [], equipment: [], vehicleId: null, usingHand: 0, invisible: false, leftHanded: false });
    this.keepAliveManaged = options.keepAliveManaged !== false;
    return this.transport.connect(url, { host: options.host || 'localhost', port: Number(options.port) || 25565, username: options.username || 'Player', auth: options.auth || 'offline', version: this.adapter.version });
  }

  disconnect() {
    this.pendingDig = null;
    this.transport.close();
    if (this.state.status !== 'disconnected') this.changeState({ status: 'disconnected', vehicleId: null, gliding: false, usingItem: false, effects: [] });
  }

  receive(message) {
    if (message.type === 'packet') {
      try { this.handlePacket(message.name, message.data || {}, message.state); }
      catch (error) { this.event({ type: 'error', message: `Cannot decode ${message.name}: ${error.message}`, packet: message.name }); }
      return;
    }
    if (message.type === 'connected') {
      this.changeState({ status: 'connected', username: message.username || this.state.username, uuid: message.uuid, version: message.version });
      this.packet('settings', { locale: 'en_US', viewDistance: 8, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true });
    } else if (message.type === 'connecting') this.changeState({ status: 'connecting' });
    else if (message.type === 'disconnected') this.changeState({ status: 'disconnected', reason: textComponent(message.reason) });
    else this.event(message);
  }

  setDimension(type, name, extra = {}) {
    const dimension = this.dimensionTypes.get(type) || { min_y: type?.includes('overworld') ? -64 : 0, height: type?.includes('overworld') ? 384 : 256, has_skylight: type?.includes('overworld') };
    if (!extra.preserveLevel) {
      for (const column of this.columns.values()) this.callbacks.onUnload?.({ x: column.x, z: column.z });
      this.columns.clear(); this.entities.clear();
    }
    this.hasPosition = false;
    this.changeState({ gliding: false, swimming: false, usingItem: false, usingHand: 0, invisible: false, sleepingPosition: null, pose: 0, ...extra, dimension: name || type, dimensionType: type, minY: dimension.min_y, height: dimension.height, hasSkylight: Boolean(dimension.has_skylight), vehicleId: null, preserveLevel: Boolean(extra.preserveLevel), keepData: extra.keepData || 0, respawnPosition: extra.respawnPosition || null, status: 'loading' });
  }

  handlePacket(name, data, packetState = 'play') {
    ({ name, data, state: packetState } = this.adapter.clientbound(name, data, packetState));
    switch (name) {
      case 'registry_data': {
        const codec = simplifyNbt(data.codec || data.registry || data);
        const entries = codec['minecraft:dimension_type']?.value || codec['minecraft:dimension_type']?.entries || [];
        for (const entry of entries) this.dimensionTypes.set(entry.name, entry.element || entry.value);
        this.chatTypes.loadRegistry(codec);
        this.event({ type: 'registry', codec });
        break;
      }
      case 'tags': {
        const items = data.tags?.find(entry => entry.tagType === 'minecraft:item');
        if (items) this.itemTags = new Map(items.tags.map(tag => [tag.tagName, new Set(tag.entries)]));
        if (items && this.adapter.modern && (this.recipeBook.entries.size || this.recipeBook.stoneCutterRecipes.length)) this.emitRecipes();
        const entities = data.tags?.find(entry => entry.tagType === 'minecraft:entity_type');
        if (entities) this.entityTags = new Map(entities.tags.map(tag => [tag.tagName, new Set(tag.entries)]));
        this.event({ type: 'tags', tags: data.tags }); break;
      }
      case 'advancements': this.event({ type: 'advancements', ...data }); break;
      case 'select_advancement_tab': this.event({ type: 'advancement-tab', id: data.id }); break;
      case 'statistics': this.event({ type: 'statistics', entries: data.entries }); break;
      case 'login':
        if (packetState === 'configuration' || packetState === 'login') break;
        this.setDimension(data.worldType, data.worldName, { entityId: data.entityId, gameMode: data.gameMode & 3, viewDistance: data.viewDistance, isHardcore: data.isHardcore, biomeSeed: asLong(data.hashedSeed) });
        break;
      case 'respawn': {
        // ClientboundRespawnPacket KEEP_ATTRIBUTES=1, KEEP_ENTITY_DATA=2.
        const keep = Number(data.copyMetadata) || 0;
        const retained = keep & 2 ? Object.fromEntries(['airSupply', 'absorption', 'health', 'gliding', 'swimming', 'usingItem', 'usingHand', 'invisible', 'leftHanded', 'sleepingPosition', 'pose', 'sneaking', 'sprinting'].map(key => [key, this.state[key]])) : { airSupply: 300, absorption: 0, health: 20, leftHanded: false, sneaking: false, sprinting: false };
        const attributes = keep & 1 ? this.state.attributes || [] : this.adapter.modern ? (this.state.attributes || []).map(attribute => ({ ...attribute, modifiers: [] })) : [];
        // Older LocalPlayer.resetPos overwrites copied health and pose.
        if (!this.adapter.modern || !(keep & 2)) {
          const health = attributes.find(attribute => /(?:^|[.:])max_health$/.test(attribute.name));
          let value = health?.value ?? 20;
          for (const modifier of health?.modifiers || []) if (modifier.operation === 0 || modifier.operation === 'add') value += modifier.amount;
          const base = value;
          for (const modifier of health?.modifiers || []) if (modifier.operation === 1 || modifier.operation === 'multiply_base') value += base * modifier.amount;
          for (const modifier of health?.modifiers || []) if (modifier.operation === 2 || modifier.operation === 'multiply_total') value *= 1 + modifier.amount;
          retained.health = Math.max(1, Math.min(1024, value)); retained.pose = 0;
        }
        const preserveLevel = (data.worldName || data.dimension) === this.state.dimension;
        const player = this.pendingRespawn || this.pendingCorrection || this.callbacks.getPlayer?.();
        const respawnMotion = this.pendingMotion ? [this.pendingMotion.velocity.x * 20, this.pendingMotion.velocity.y * 20, this.pendingMotion.velocity.z * 20] : Array.isArray(player?.velocity) ? [...player.velocity] : [this.velocity.x * 20, this.velocity.y * 20, this.velocity.z * 20];
        const respawnPosition = keep & 2 && this.adapter.modern ? { yaw: player?.yaw ?? this.position.yaw, pitch: player?.pitch ?? this.position.pitch, velocity: respawnMotion } : null;
        const spawn = this.adapter.modern ? [0, 0, 0] : [this.defaultSpawn.x + 0.5, this.defaultSpawn.y + 1, this.defaultSpawn.z + 0.5];
        this.pendingRespawn = { position: spawn, yaw: respawnPosition?.yaw ?? -TAU, pitch: respawnPosition?.pitch ?? 0, velocity: respawnPosition?.velocity ?? [0, 0, 0] };
        this.pendingCorrection = null; this.pendingMotion = null;
        this.velocity = { x: this.pendingRespawn.velocity[0] / 20, y: this.pendingRespawn.velocity[1] / 20, z: this.pendingRespawn.velocity[2] / 20 };
        const oldWindow = this.state.windowId || 0;
        this.windows.clear(); this.menus.clear(); this.quickCraft = null;
        const inventory = { windowId: 0, stateId: 0, slots: Array.from({ length: 46 }, () => EMPTY_SLOT), cursor: EMPTY_SLOT, selectedSlot: 0 };
        this.windows.set(0, inventory); this.callbacks.onInventory?.({ ...inventory });
        this.event({ type: 'close-window', windowId: oldWindow });
        this.effects.clear();
        const mode = data.gamemode & 3;
        this.setDimension(data.dimension, data.worldName, { ...retained, gameMode: mode, biomeSeed: asLong(data.hashedSeed), windowId: 0, selectedSlot: 0, food: 20, saturation: 5, experience: 0, experienceLevel: 0, totalExperience: 0, equipment: [], canFly: mode === 1 || mode === 3, flying: mode === 3, invulnerable: mode === 1 || mode === 3, walkingSpeed: 0.1, flyingSpeed: 0.05, effects: [], attributes, preserveLevel, keepData: keep, respawnPosition });
        this.pendingDig = null;
        break;
      }
      case 'position': {
        const flags = data.flags || 0;
        const player = this.pendingRespawn || this.pendingCorrection || this.callbacks.getPlayer?.();
        const prior = player?.position ? { x: player.position[0], y: player.position[1], z: player.position[2], yaw: player.yaw, pitch: player.pitch } : this.position;
        const oldVelocity = this.pendingMotion?.velocity || (Array.isArray(player?.velocity) ? { x: player.velocity[0] / 20, y: player.velocity[1] / 20, z: player.velocity[2] / 20 } : this.velocity);
        const mounted = this.adapter.modern && this.state.vehicleId !== null && this.state.vehicleId !== undefined;
        if (!mounted) {
          const resolved = resolveCorrection({ ...prior, yaw: prior.yaw * DEGREES + 180, pitch: -prior.pitch * DEGREES }, data, flags, oldVelocity, this.adapter.modern);
          this.velocity = resolved.velocity;
          this.position = { x: resolved.x, y: resolved.y, z: resolved.z, yaw: (resolved.yaw - 180) / DEGREES, pitch: -resolved.pitch / DEGREES, grounded: false };
        } else this.position = { ...prior, grounded: false };
        this.hasPosition = true;
        this.pendingRespawn = null;
        this.packet('teleport_confirm', { teleportId: data.teleportId });
        this.sendPosition(this.position);
        if (!mounted) {
          this.pendingCorrection = { position: [this.position.x, this.position.y, this.position.z], yaw: this.position.yaw, pitch: this.position.pitch, velocity: [this.velocity.x * 20, this.velocity.y * 20, this.velocity.z * 20], teleportId: data.teleportId, motionRevision: this.motionRevision };
          this.pendingMotion = null;
          this.callbacks.onPosition?.({ ...this.position, velocity: { ...this.velocity }, resetVelocity: false, flags, teleportId: data.teleportId });
        }
        this.changeState({ status: 'playing' });
        if (this.adapter.features.playerLoaded) this.packet('player_loaded', {});
        break;
      }
      case 'map_chunk': {
        const sections = decodeChunkSections(data.chunkData, { ...this.state, implicitPaletteLengths: data.implicitPaletteLengths });
        const column = { x: data.x, z: data.z, sections, heightmaps: simplifyNbt(data.heightmaps), blockEntities: data.blockEntities, light: this.decodeLight(data) };
        this.columns.set(`${data.x},${data.z}`, column);
        this.callbacks.onColumn?.(column);
        for (const section of sections) this.callbacks.onSection?.({ ...section, chunkX: data.x, chunkZ: data.z });
        break;
      }
      case 'unload_chunk': {
        const x = data.chunkX ?? data.x, z = data.chunkZ ?? data.z;
        this.columns.delete(`${x},${z}`);
        this.callbacks.onUnload?.({ x, z });
        break;
      }
      case 'block_change': this.blockUpdate(data.location.x, data.location.y, data.location.z, data.type); break;
      case 'multi_block_change': {
        const { x, y, z } = data.chunkCoordinates;
        for (const packed of data.records) {
          const record = Number(packed);
          this.blockUpdate(x * 16 + ((record >>> 8) & 15), y * 16 + (record & 15), z * 16 + ((record >>> 4) & 15), Math.floor(record / 4096));
        }
        break;
      }
      case 'update_light': {
        const column = this.columns.get(`${data.chunkX},${data.chunkZ}`);
        const light = this.decodeLight(data);
        if (column) {
          for (const kind of ['sky', 'block']) for (const [sectionY, values] of light[kind]) column.light[kind].set(sectionY, values);
        }
        this.event({ type: 'light', x: data.chunkX, z: data.chunkZ, light });
        break;
      }
      case 'chunk_batch_finished': this.packet('chunk_batch_received', { chunksPerTick: this.chunksPerTick }); break;
      case 'keep_alive': if (!this.keepAliveManaged) this.packet('keep_alive', { keepAliveId: data.keepAliveId }); break;
      case 'update_time': {
        const worldAge = asLong(data.age), raw = asLong(data.time);
        const timeOfDay = Number((raw < 0n ? -raw : raw) % 24000n);
        this.callbacks.onTime?.({ worldAge, timeOfDay, daylightCycle: raw >= 0n });
        break;
      }
      case 'update_health':
        this.changeState({ health: data.health, food: data.food, saturation: data.foodSaturation });
        if (data.health <= 0) this.event({ type: 'death' });
        break;
      case 'game_state_change':
        if (data.reason === 'change_game_mode' || data.reason === 3) this.changeState({ gameMode: data.gameMode & 3 });
        else this.event({ type: 'weather', reason: data.reason, value: data.gameMode });
        break;
      case 'abilities': this.changeState({ canFly: Boolean(data.flags & 4), flying: Boolean(data.flags & 2), invulnerable: Boolean(data.flags & 1), flyingSpeed: data.flyingSpeed, walkingSpeed: data.walkingSpeed }); break;
      case 'window_items': {
        const window = { windowId: data.windowId, stateId: data.stateId, slots: data.items, cursor: data.carriedItem || EMPTY_SLOT, selectedSlot: this.state.selectedSlot };
        this.windows.set(data.windowId, window);
        this.syncPlayerInventory(window);
        this.callbacks.onInventory?.({ ...window });
        break;
      }
      case 'set_slot': {
        // -1 updates the carried stack; -2 addresses the player's inventory.
        const windowId = data.windowId === -2 ? 0 : data.windowId;
        if (data.windowId === -1) {
          for (const window of this.windows.values()) window.cursor = data.item;
          const window = this.windows.get(this.state.windowId || 0);
          if (window) this.callbacks.onInventory?.({ ...window });
          break;
        }
        const window = this.windows.get(windowId) || { windowId, stateId: data.stateId, slots: [], cursor: EMPTY_SLOT, selectedSlot: this.state.selectedSlot };
        window.stateId = data.stateId;
        window.slots[data.slot] = data.item;
        this.windows.set(windowId, window);
        this.syncPlayerInventory(window, data.slot);
        this.callbacks.onInventory?.({ ...window });
        break;
      }
      case 'open_window': {
        const menu = { ...data, title: textComponent(data.windowTitle), titleComponent: data.windowTitle };
        this.menus.set(data.windowId, menu); this.quickCraft = null;
        this.changeState({ windowId: data.windowId }); this.event({ type: 'window', ...menu }); break;
      }
      case 'open_horse_window': {
        const entity = this.entities.get(data.entityId), definition = this.callbacks.registry?.entities?.find(entry => entry.id === entity?.entityType);
        const saddleTag = this.entityTags.get('minecraft:can_equip_saddle'), armorTag = this.entityTags.get('minecraft:can_wear_horse_armor');
        const menu = { ...data, inventoryType: 'horse', horseType: definition?.name || entity?.name || 'horse', title: definition?.displayName || 'Mount inventory', modern: this.adapter.modern, saddleEnabled: saddleTag?.has(entity?.entityType), armorEnabled: armorTag?.has(entity?.entityType), inventoryColumns: this.adapter.modern ? data.nbSlots : Math.max(0, (data.nbSlots - 2) / 3) };
        this.menus.set(data.windowId, menu); this.quickCraft = null;
        this.changeState({ windowId: data.windowId }); this.event({ type: 'window', ...menu }); break;
      }
      case 'close_window': this.menus.delete(data.windowId); this.quickCraft = null; this.changeState({ windowId: 0 }); this.event({ type: 'close-window', windowId: data.windowId }); break;
      case 'craft_progress_bar': this.event({ type: 'window-properties', ...data }); break;
      case 'trade_list': this.event({ type: 'trades', ...data }); break;
      case 'declare_recipes': {
        if (this.adapter.modern) {
          this.recipeProperties = new Map((data.recipes || []).map(entry => [entry.name, new Set(entry.items)]));
          this.recipeBook.setStoneCutterRecipes(data.stoneCutterRecipes);
          this.emitRecipes();
          this.event({ type: 'recipe-properties', propertySets: data.recipes, stoneCutterRecipes: data.stoneCutterRecipes });
        } else {
          this.recipes = new Map((data.recipes || []).map(recipe => [recipe.recipeId, recipe]));
          this.event({ type: 'recipes', recipes: data.recipes });
        }
        break;
      }
      case 'recipe_book_add':
        this.recipeBook.add(data.entries, data.replace); this.emitRecipes();
        this.event({ type: 'unlock-recipes', action: data.replace ? 0 : 1, recipes1: data.entries.map(entry => entry.recipe.displayId), recipes2: [] }); break;
      case 'recipe_book_remove':
        this.recipeBook.remove(data.recipeIds); this.emitRecipes();
        this.event({ type: 'unlock-recipes', action: 2, recipes1: data.recipeIds, recipes2: [] }); break;
      case 'recipe_book_settings': this.changeState({ recipeBookSettings: data }); break;
      case 'unlock_recipes': this.event({ type: 'unlock-recipes', ...data }); break;
      case 'boss_bar': case 'clear_titles': case 'set_title_text': case 'set_title_subtitle': case 'set_title_time':
      case 'action_bar': case 'playerlist_header': case 'scoreboard_objective': case 'scoreboard_display_objective':
      case 'scoreboard_score': case 'reset_score': case 'teams':
        this.event({ type: 'hud', name, data }); break;
      case 'held_item_slot': this.changeState({ selectedSlot: data.slot }); this.emitInventory(); break;
      case 'experience': this.changeState({ experience: data.experienceBar, experienceLevel: data.level, totalExperience: data.totalExperience }); break;
      case 'system_chat': this.event({ type: 'chat', text: textComponent(data.content), component: data.content, actionBar: data.isActionBar }); break;
      case 'profileless_chat': {
        const component = this.chatTypes.decorate(data.message, { type: data.type, name: data.name, target: data.target });
        this.event({ type: 'chat', text: textComponent(component), component }); break;
      }
      case 'player_chat': {
        const component = this.chatTypes.decorate(data.unsignedChatContent || { text: data.plainMessage }, { type: data.type, name: data.networkName || { text: this.players.get(data.senderUuid)?.name || data.senderUuid }, target: data.networkTargetName });
        this.event({ type: 'chat', text: textComponent(component), component, sender: data.senderUuid }); break;
      }
      case 'kick_disconnect':
      case 'disconnect': this.changeState({ status: 'disconnected', reason: textComponent(data.reason) }); break;
      case 'death_combat_event': this.event({ type: 'death', text: textComponent(data.message), component: data.message }); break;
      case 'player_info':
        for (const info of data.data || []) {
          const player = { ...this.players.get(info.uuid), ...info, name: info.player?.name || this.players.get(info.uuid)?.name };
          this.players.set(info.uuid, player);
          this.callbacks.onEntity?.({ type: 'player-info', player });
        }
        this.event({ type: 'player-list', players: [...this.players.values()] });
        break;
      case 'player_remove':
        for (const uuid of data.players || []) { this.players.delete(uuid); this.callbacks.onEntity?.({ type: 'player-remove', uuid }); }
        this.event({ type: 'player-list', players: [...this.players.values()] });
        break;
      case 'spawn_entity': {
        const entity = { id: data.entityId, uuid: data.objectUUID, entityType: data.type, objectData: data.objectData, x: data.x, y: data.y, z: data.z, yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, metadata: [], velocity: data.velocity };
        this.entities.set(entity.id, entity);
        this.callbacks.onEntity?.({ type: 'spawn', entity: { ...entity } });
        break;
      }
      case 'rel_entity_move':
      case 'entity_move_look': this.entityUpdate(data.entityId, { dx: data.dX / 4096, dy: data.dY / 4096, dz: data.dZ / 4096, ...(name === 'entity_move_look' ? { yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU } : {}), grounded: data.onGround }); break;
      case 'entity_look': this.entityUpdate(data.entityId, { yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, grounded: data.onGround }); break;
      case 'entity_teleport': {
        const entity = this.entities.get(data.entityId);
        if (!entity) break;
        if (!this.adapter.modern) this.entityUpdate(data.entityId, { x: data.x, y: data.y, z: data.z, yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, grounded: data.onGround, teleport: true });
        else {
          const oldVelocity = { x: (entity.velocity?.x ?? 0) / 8000, y: (entity.velocity?.y ?? 0) / 8000, z: (entity.velocity?.z ?? 0) / 8000 };
          const resolved = resolveCorrection({ ...entity, yaw: entity.yaw * DEGREES, pitch: entity.pitch * DEGREES },
            { ...data, yaw: data.yawDegrees ?? data.yaw / 256 * 360, pitch: data.pitchDegrees ?? data.pitch / 256 * 360 }, data.relativeFlags ?? 0, oldVelocity);
          this.entityUpdate(data.entityId, { x: resolved.x, y: resolved.y, z: resolved.z, yaw: resolved.yaw / DEGREES, pitch: resolved.pitch / DEGREES,
            ...(!data.positionSync ? { velocity: { x: resolved.velocity.x * 8000, y: resolved.velocity.y * 8000, z: resolved.velocity.z * 8000 } } : {}), grounded: data.onGround, teleport: true });
        }
        break;
      }
      case 'vehicle_move': {
        const entity = this.entities.get(this.state.vehicleId);
        if (!entity) break;
        const local = this.callbacks.getPlayer?.()?.vehicle ?? this.localVehicle;
        const inventory = this.windows.get(0)?.slots ?? [], held = [inventory[36 + this.state.selectedSlot], inventory[45]].filter(item => item?.present).map(item => this.itemDefinitions.get(item.itemId)?.name);
        const controlled = local?.id === entity.id ? local.controlled : vehicleStateFromEntity(entity, this.callbacks.registry ?? {}, this.state.entityId, { heldItems: held })?.controlled;
        if (!controlled) break;
        this.entityUpdate(entity.id, { x: data.x, y: data.y, z: data.z, yaw: data.yaw / DEGREES, pitch: data.pitch / DEGREES, teleport: true });
        this.packet('vehicle_move', { ...data, onGround: Boolean(entity.grounded) });
        break;
      }
      case 'entity_head_rotation': this.entityUpdate(data.entityId, { headYaw: data.headYaw / 256 * TAU }); break;
      case 'entity_velocity':
        if (data.entityId === this.state.entityId) {
          const event = this.motion({ x: data.velocity.x / 8000, y: data.velocity.y / 8000, z: data.velocity.z / 8000 });
          this.callbacks.onEntity?.(event); this.event(event);
        }
        else this.entityUpdate(data.entityId, { velocity: data.velocity });
        break;
      case 'entity_update_attributes':
        if (data.entityId === this.state.entityId) {
          const attributes = new Map((this.state.attributes || []).map((attribute) => [attribute.name, attribute]));
          for (const attribute of data.properties) attributes.set(attribute.name, attribute);
          this.changeState({ attributes: [...attributes.values()] });
        }
        else this.entityUpdate(data.entityId, { attributes: data.properties });
        break;
      case 'entity_effect':
        if (data.entityId === this.state.entityId) {
          // 1.20.4 effect registry IDs are zero-based (Haste is 2).
          const names = ['speed', 'slowness', 'haste', 'mining_fatigue'];
          const definition = this.callbacks.registry?.effects?.find(effect => effect.id === data.effectId);
          this.effects.set(data.effectId, { id: data.effectId, name: definition?.name?.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() || names[data.effectId], amplifier: data.amplifier, duration: data.duration });
          this.changeState({ effects: [...this.effects.values()] });
        } else this.callbacks.onEntity?.({ type: 'effect', id: data.entityId, ...data });
        break;
      case 'remove_entity_effect':
        if (data.entityId === this.state.entityId) { this.effects.delete(data.effectId); this.changeState({ effects: [...this.effects.values()] }); }
        else this.callbacks.onEntity?.({ type: 'remove-effect', id: data.entityId, effectId: data.effectId });
        break;
      case 'damage_event':
        if (data.entityId === this.state.entityId) this.event({ type: 'player-damage', ...data });
        else this.callbacks.onEntity?.({ type: 'status', id: data.entityId, status: 2 });
        break;
      case 'set_passengers':
        this.entityUpdate(data.entityId, { passengers: data.passengers });
        if (data.passengers.includes(this.state.entityId)) this.changeState({ vehicleId: data.entityId });
        else if (this.state.vehicleId === data.entityId) this.changeState({ vehicleId: null });
        this.event({ type: 'passengers', ...data });
        break;
      case 'entity_status': this.callbacks.onEntity?.({ type: 'status', id: data.entityId, status: data.entityStatus }); break;
      case 'animation': this.callbacks.onEntity?.({ type: 'animation', id: data.entityId, animation: data.animation }); break;
      case 'collect': this.callbacks.onEntity?.({ type: 'collect', id: data.collectedEntityId, collectorId: data.collectorEntityId, count: data.pickupItemCount }); break;
      case 'entity_metadata': {
        if (data.entityId === this.state.entityId) {
          const patch = {};
          for (const item of data.metadata) {
            const key = this.playerMetadataKeys[item.key];
            if (key === 'air_supply') patch.airSupply = item.value;
            else if (key === 'player_absorption') patch.absorption = item.value;
            else if (key === 'shared_flags') { patch.swimming = Boolean(item.value & 16); patch.gliding = Boolean(item.value & 128); patch.invisible = Boolean(item.value & 32); }
            else if (key === 'pose') patch.pose = item.value;
            else if (key === 'sleeping_pos') patch.sleepingPosition = item.value;
            else if (key === 'living_entity_flags') { patch.usingItem = Boolean(item.value & 1); patch.usingHand = item.value & 2 ? 1 : 0; }
            else if (key === 'player_main_hand') patch.leftHanded = item.value === 0;
          }
          this.changeState(patch);
          break;
        }
        const entity = this.entities.get(data.entityId);
        const metadata = new Map((entity?.metadata || []).map((item) => [item.key, item]));
        for (const item of data.metadata) metadata.set(item.key, item);
        this.entityUpdate(data.entityId, { metadata: [...metadata.values()] });
        break;
      }
      case 'entity_equipment': {
        if (data.entityId === this.state.entityId) {
          const equipment = new Map((this.state.equipment || []).map(item => [item.slot, item]));
          for (const item of data.equipments) equipment.set(item.slot, item);
          this.changeState({ equipment: [...equipment.values()] });
          break;
        }
        const entity = this.entities.get(data.entityId);
        const equipment = new Map((entity?.equipment || []).map((item) => [item.slot, item]));
        for (const item of data.equipments) equipment.set(item.slot, item);
        this.entityUpdate(data.entityId, { equipment: [...equipment.values()] });
        break;
      }
      case 'entity_destroy':
        for (const id of data.entityIds) { this.entities.delete(id); this.callbacks.onEntity?.({ type: 'remove', id }); }
        break;
      case 'block_break_animation': this.event({ type: 'break-progress', ...data }); break;
      case 'acknowledge_player_digging': this.event({ type: 'block-ack', ...data }); break;
      case 'tile_entity_data': case 'block_entity_data':
        this.event({ type: 'block-entity', ...data.location, action: data.action, nbt: simplifyNbt(data.nbtData || data.nbt) }); break;
      case 'open_sign_entity': this.event({ type: 'open-sign', ...data.location, isFrontText: data.isFrontText }); break;
      case 'open_book': this.event({ type: 'open-book', hand: data.hand }); break;
      case 'map': this.event({ type: 'map', ...data }); break;
      case 'block_action':
        this.event({ type: 'block-action', ...data.location, actionId: data.byte1, actionParam: data.byte2, blockId: data.blockId }); break;
      case 'world_particles': this.event({ type: 'particles', data }); break;
      case 'spawn_position': if (data.location) this.defaultSpawn = { ...data.location }; break;
      case 'explosion': {
        const center = data.center || { x: data.x, y: data.y, z: data.z };
        const motion = data.playerKnockback || (!this.adapter.modern ? { x: data.playerMotionX, y: data.playerMotionY, z: data.playerMotionZ } : null);
        if (motion && Object.values(motion).every(Number.isFinite)) {
          const player = this.pendingRespawn || this.pendingCorrection || this.callbacks.getPlayer?.();
          if (!this.pendingMotion && Array.isArray(player?.velocity)) this.velocity = { x: player.velocity[0] / 20, y: player.velocity[1] / 20, z: player.velocity[2] / 20 };
          this.event(this.motion(motion, true));
        }
        const particle = data.explosionParticle || (data.radius < 2 || data.block_interaction_type === 0 ? data.small_explosion_particle : data.large_explosion_particle);
        const particleId = this.callbacks.registry?.particles?.find(entry => entry.name === particle?.type?.replace('minecraft:', ''))?.id;
        if (particleId !== undefined) this.event({ type: 'particles', data: { particleId, ...center, offsetX: 1, offsetY: 0, offsetZ: 0, particleData: 1, particles: 0, longDistance: false, data: particle.data || {} } });
        if (data.sound) this.event({ type: 'sound', name: 'sound_effect', data: { sound: data.sound, x: center.x * 8, y: center.y * 8, z: center.z * 8, soundCategory: 'block', volume: 4, pitch: (1 + (Math.random() - Math.random()) * 0.2) * 0.7 } });
        if (this.adapter.modern) this.event({ type: 'explosion-block-effects', center, radius: data.radius, blockCount: data.blockCount, blockParticles: data.blockParticles });
        else if (data.block_interaction_type === 1 || data.block_interaction_type === 2) for (const offset of data.affectedBlockOffsets || []) this.blockUpdate(Math.floor(center.x) + offset.x, Math.floor(center.y) + offset.y, Math.floor(center.z) + offset.z, 0);
        break;
      }
      case 'world_event': this.event({ type: 'world-event', data }); break;
      case 'sound_effect': case 'entity_sound_effect': this.event({ type: 'sound', name, data }); break;
      case 'stop_sound': this.event({ type: 'stop-sound', data }); break;
      case 'add_resource_pack': case 'resource_pack_send': this.event({ type: 'resource-pack', ...data, packetState }); break;
      case 'remove_resource_pack': this.event({ type: 'remove-resource-pack', ...data, packetState }); break;
      default: break;
    }
  }

  decodeLight(data) {
    const decode = (mask = [], empty = [], arrays = []) => {
      const sections = new Map();
      let index = 0;
      const count = this.state.height / 16 + 2;
      for (let bit = 0; bit < count; bit++) {
        const word = Math.floor(bit / 64), shift = BigInt(bit % 64);
        if ((asLong(mask[word]) >> shift) & 1n) sections.set(this.state.minY / 16 - 1 + bit, Uint8Array.from(arrays[index++] || []));
        else if ((asLong(empty[word]) >> shift) & 1n) sections.set(this.state.minY / 16 - 1 + bit, new Uint8Array(2048));
      }
      return sections;
    };
    return { sky: decode(data.skyLightMask, data.emptySkyLightMask, data.skyLight), block: decode(data.blockLightMask, data.emptyBlockLightMask, data.blockLight) };
  }

  blockUpdate(x, y, z, stateId) {
    const column = this.columns.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
    const section = column?.sections.find((section) => section.sectionY === Math.floor(y / 16));
    if (section) section.blocks[((y & 15) * 16 + (z & 15)) * 16 + (x & 15)] = stateId;
    this.callbacks.onBlock?.({ x, y, z, stateId });
  }

  entityUpdate(id, patch) {
    const entity = this.entities.get(id);
    if (!entity) return;
    if ('dx' in patch) {
      entity.x += patch.dx; entity.y += patch.dy; entity.z += patch.dz;
      const { dx, dy, dz, ...rest } = patch;
      Object.assign(entity, rest);
    } else Object.assign(entity, patch);
    this.callbacks.onEntity?.({ type: 'update', entity: { ...entity }, teleport: patch.teleport === true });
  }

  sendPosition(position) {
    return this.packet('position_look', { x: position.x, y: position.y, z: position.z, yaw: ((position.yaw * DEGREES + 180) % 360 + 360) % 360, pitch: -position.pitch * DEGREES, onGround: Boolean(position.grounded) });
  }

  tick(player, dt, keys = new Set()) {
    if (!this.hasPosition || this.state.status !== 'playing') return;
    if (this.pendingCorrection || this.pendingRespawn || this.pendingMotion) return;
    const position = player.position || [player.x, player.y, player.z];
    this.position = { x: position[0], y: position[1], z: position[2], yaw: player.yaw, pitch: player.pitch, grounded: Boolean(player.grounded) };
    if (Array.isArray(player.velocity) && player.velocity.every(Number.isFinite)) this.velocity = { x: player.velocity[0] / 20, y: player.velocity[1] / 20, z: player.velocity[2] / 20 };
    this.localVehicle = player.vehicle ?? null;
    if (![this.position.x, this.position.y, this.position.z, this.position.yaw, this.position.pitch].every(Number.isFinite)) return;
    this.movementClock += Math.min(Math.max(dt, 0), 0.25);
    if (this.movementClock >= 0.05) {
      this.movementClock %= 0.05;
      if (player.vehicle) this.packet('look', { yaw: this.position.yaw * DEGREES + 180, pitch: -this.position.pitch * DEGREES, onGround: false });
      else this.sendPosition(this.position);
      if (this.adapter.modern) this.sendInput({ forward: keys.has('KeyW'), backward: keys.has('KeyS'), left: keys.has('KeyA'), right: keys.has('KeyD'), jump: keys.has('Space'), shift: keys.has('ShiftLeft') || keys.has('ShiftRight'), sprint: keys.has('ControlLeft') || keys.has('ControlRight') });
    }
  }
  sendInput(patch) { this.inputs = { ...this.inputs, ...patch }; return this.packet('player_input', { inputs: this.inputs }); }
  moveVehicle(vehicle) {
    if (!vehicle || this.state.vehicleId !== vehicle.id || this.state.status !== 'playing') return false;
    const input = vehicle.input;
    this.packet('steer_vehicle', { sideways: input.sideways, forward: input.forward, jump: (input.jump ? 1 : 0) | (input.unmount ? 2 : 0) });
    if (!vehicle.controlled) return true;
    this.packet('vehicle_move', { x: vehicle.position[0], y: vehicle.position[1], z: vehicle.position[2], yaw: vehicle.yaw * DEGREES + 180, pitch: -vehicle.pitch * DEGREES, onGround: Boolean(vehicle.grounded) });
    if (/(?:boat|raft)$/.test(vehicle.type)) this.packet('steer_boat', { leftPaddle: vehicle.paddles[0], rightPaddle: vehicle.paddles[1] });
    this.entityUpdate(vehicle.id, { x: vehicle.position[0], y: vehicle.position[1], z: vehicle.position[2], yaw: vehicle.yaw + Math.PI, pitch: -vehicle.pitch });
    return true;
  }

  dig(hit, { phase = 'start' } = {}) {
    if (this.state.status !== 'playing' || this.state.gameMode === 2 || this.state.gameMode === 3) return false;
    const target = blockHit(hit || this.pendingDig?.source);
    if (!target) return false;
    const status = phase === 'finish' ? 2 : phase === 'cancel' ? 1 : 0;
    if (phase === 'start') this.pendingDig = target;
    else this.pendingDig = null;
    this.packet('arm_animation', { hand: 0 });
    return this.packet('block_dig', { status, location: target.location, face: target.face, sequence: ++this.sequence });
  }

  cancelDig() { if (this.pendingDig) return this.dig(null, { phase: 'cancel' }); return false; }

  place(hit, { hand = 0, cursor = null, insideBlock = false } = {}) {
    if (this.state.status !== 'playing' || this.state.gameMode === 3) return false;
    const target = blockHit(hit);
    if (!target) return this.packet('use_item', { hand, sequence: ++this.sequence });
    const coordinates = cursor || [0.5, 0.5, 0.5];
    this.packet('arm_animation', { hand });
    return this.packet('block_place', { hand, location: target.location, direction: target.face, cursorX: coordinates[0], cursorY: coordinates[1], cursorZ: coordinates[2], insideBlock, sequence: ++this.sequence });
  }

  selectHotbar(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) return false;
    if (!this.packet('held_item_slot', { slotId: slot })) return false;
    this.changeState({ selectedSlot: slot }); this.emitInventory();
    return true;
  }

  emitInventory() { const window = this.windows.get(this.state.windowId || 0); if (window) this.callbacks.onInventory?.({ ...window, selectedSlot: this.state.selectedSlot }); }
  emitRecipes() {
    const recipes = this.recipeBook.snapshot();
    this.recipes = new Map(recipes.map(recipe => [recipe.recipeId, recipe]));
    this.event({ type: 'recipes', recipes, modern: true });
  }

  setCreativeSlot(itemId, count = 64, hotbarSlot = this.state.selectedSlot) {
    if (this.state.gameMode !== 1 || !Number.isInteger(hotbarSlot) || hotbarSlot < 0 || hotbarSlot > 8) return false;
    if (itemId !== null && (!Number.isInteger(itemId) || itemId < 0)) return false;
    const stackSize = this.itemDefinitions.get(itemId)?.stackSize || 64;
    const item = itemId === null ? { present: false } : { present: true, itemId, itemCount: Math.max(1, Math.min(stackSize, count)), nbtData: undefined };
    if (!this.packet('set_creative_slot', { slot: 36 + hotbarSlot, item })) return false;
    const inventory = this.windows.get(0) ?? { windowId: 0, stateId: 0, slots: Array.from({ length: 46 }, () => ({ present: false })), cursor: { present: false } };
    inventory.slots[36 + hotbarSlot] = item;
    this.windows.set(0, inventory);
    this.syncPlayerInventory(inventory, 36 + hotbarSlot);
    this.callbacks.onInventory?.({ ...inventory, selectedSlot: this.state.selectedSlot });
    return true;
  }

  clickWindow(slot, { button = 0, mode = 0, windowId = this.state.windowId || 0, changedSlots, cursorItem } = {}) {
    const window = this.windows.get(windowId);
    if (!window) return false;
    if (mode === 1 || mode === 2) this.selectBundleItem(slot, -1, windowId);
    const prediction = this.predictClick(window, slot, button, mode);
    const changes = changedSlots || prediction.changedSlots, carried = cursorItem || prediction.cursorItem;
    if (!this.packet('window_click', { windowId, stateId: window.stateId, slot, mouseButton: button, mode, changedSlots: changes, cursorItem: carried })) return false;
    // Native accepted clicks need no echo: servers send only mismatches with
    // the client's prediction. Retain stateId and apply later corrections.
    for (const change of changes) if (Number.isInteger(change.location) && change.location >= 0 && change.location < window.slots.length) window.slots[change.location] = change.item;
    window.cursor = carried;
    for (const other of this.windows.values()) other.cursor = carried;
    this.quickCraft = prediction.drag;
    const player = this.windows.get(0);
    if (player) for (const change of prediction.playerChanges || []) player.slots[change.location] = change.item;
    this.syncPlayerInventory(window);
    this.callbacks.onInventory?.({ ...window, selectedSlot: this.state.selectedSlot });
    return true;
  }

  // Predict the packet's expected result using native stack limits. The server
  // can replace these slots/cursor whenever it rejects or corrects the action.
  predictClick(window, slot, button, mode) {
    return predictInventoryClick({ window, slot, button, mode, menu: this.menus.get(window.windowId), definitions: this.itemDefinitions, playerWindow: this.windows.get(0), creative: this.state.gameMode === 1, modern: this.adapter.modern, tags: this.itemTags, recipes: this.recipes, properties: this.recipeProperties, drag: this.quickCraft, selectedSlot: this.state.selectedSlot });
  }

  // Open menus share their last 36 slots with InventoryMenu slots 9..44.
  // Servers do not echo accepted predictions, so both views must update now.
  syncPlayerInventory(window, updatedSlot) {
    if (window.windowId === 0) {
      for (const other of this.windows.values()) if (other.windowId !== 0 && other.slots.length >= 36 && this.menus.get(other.windowId)?.inventoryType !== 'lectern') {
        const base = other.slots.length - 36;
        for (let index = 9; index <= 44; index++) if (updatedSlot === undefined || updatedSlot === index) other.slots[base + index - 9] = window.slots[index] || EMPTY_SLOT;
        this.callbacks.onInventory?.({ ...other });
      }
      return;
    }
    if (window.slots.length < 36 || this.menus.get(window.windowId)?.inventoryType === 'lectern') return;
    const player = this.windows.get(0) || { windowId: 0, stateId: 0, slots: Array.from({ length: 46 }, () => EMPTY_SLOT), cursor: window.cursor };
    const base = window.slots.length - 36;
    for (let index = 0; index < 36; index++) if (updatedSlot === undefined || updatedSlot === base + index) player.slots[9 + index] = window.slots[base + index] || EMPTY_SLOT;
    player.cursor = window.cursor; this.windows.set(0, player);
    this.callbacks.onInventory?.({ ...player, selectedSlot: this.state.selectedSlot });
  }

  closeWindow() { const id = this.state.windowId || 0; this.packet('close_window', { windowId: id }); this.menus.delete(id); this.quickCraft = null; this.changeState({ windowId: 0 }); }
  selectTrade(index) { return Number.isInteger(index) && index >= 0 && this.packet('select_trade', { slot: index }); }
  enchantItem(index, windowId = this.state.windowId || 0) { return this.selectContainerButton(index, windowId); }
  selectContainerButton(index, windowId = this.state.windowId || 0) { return Number.isInteger(index) && index >= 0 && index < 128 && this.packet('enchant_item', { windowId, enchantment: index }); }
  craftRecipe(recipe, { windowId = this.state.windowId || 0, makeAll = false } = {}) { return (this.adapter.modern ? Number.isInteger(recipe) && recipe >= 0 : typeof recipe === 'string' && recipe.length <= 256) && this.packet('craft_recipe_request', { windowId, recipe, makeAll: Boolean(makeAll) }); }
  selectBundleItem(slot, selectedItemIndex, windowId = this.state.windowId || 0) {
    const window = this.windows.get(windowId), stack = window?.slots[slot];
    if (!this.adapter.modern || !Number.isInteger(slot) || slot < 0 || !stack || !Number.isInteger(selectedItemIndex)) return false;
    const view = bundleView(stack, this.itemDefinitions, { componentId: this.adapter.bundleComponentId });
    if (!view || selectedItemIndex < -1 || selectedItemIndex >= view.shown) return false;
    if (!this.packet('select_bundle_item', { slotId: slot, selectedItemIndex })) return false;
    stack.bundleSelectedItem = stack.bundleSelectedItem === selectedItemIndex ? -1 : selectedItemIndex;
    this.syncPlayerInventory(window, slot); this.callbacks.onInventory?.({ ...window, selectedSlot: this.state.selectedSlot });
    return true;
  }
  renameItem(name) { return typeof name === 'string' && name.length <= 50 && this.packet('name_item', { name }); }
  respawn() { return this.packet('client_command', { actionId: 'perform_respawn' }); }
  sneak(value) { this.state.sneaking = Boolean(value); return this.adapter.modern ? this.sendInput({ shift: Boolean(value) }) : this.packet('entity_action', { entityId: this.state.entityId, actionId: value ? 'start_sneaking' : 'stop_sneaking', jumpBoost: 0 }); }
  sprint(value) { return this.packet('entity_action', { entityId: this.state.entityId, actionId: value ? 'start_sprinting' : 'stop_sprinting', jumpBoost: 0 }); }
  setFlying(value) {
    if (value && !this.state.canFly) return false;
    if (!this.packet('abilities', { flags: value ? 2 : 0 })) return false;
    this.changeState({ flying: Boolean(value) });
    return true;
  }
  releaseItem() { return this.packet('block_dig', { status: 5, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++this.sequence }); }
  dropItem(stack = false) { return this.packet('block_dig', { status: stack ? 3 : 4, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++this.sequence }); }
  swapHands() { return this.packet('block_dig', { status: 6, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++this.sequence }); }
  attackEntity(id) {
    if (this.state.status !== 'playing' || this.state.gameMode === 3 || !this.entities.has(id)) return false;
    this.packet('arm_animation', { hand: 0 });
    return this.packet('use_entity', { target: id, mouse: 1, sneaking: Boolean(this.state.sneaking) });
  }
  interactEntity(id, { hand = 0, point = null } = {}) {
    if (this.state.status !== 'playing' || !this.entities.has(id)) return false;
    return this.packet('use_entity', { target: id, mouse: point ? 2 : 0, ...(point ? { x: point[0], y: point[1], z: point[2] } : {}), hand, sneaking: Boolean(this.state.sneaking) });
  }
  chat(text) {
    text = String(text).trim();
    if (!text || text.length > 256 || this.state.status !== 'playing') return false;
    return this.transport.send({ type: 'chat', text });
  }
}
