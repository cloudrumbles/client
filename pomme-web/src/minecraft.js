import { GatewayTransport, encodeGatewayValue } from './transport.js';

const TAU = Math.PI * 2;
const DEGREES = 180 / Math.PI;
const EMPTY_SLOT = Object.freeze({ present: false });
const slotJson = (value) => JSON.stringify(encodeGatewayValue(value));

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
export function decodePalettedContainer(reader, size, kind = 'blocks') {
  const encodedBits = reader.u8();
  const maxIndirect = kind === 'biomes' ? 3 : 8;
  const minimum = kind === 'biomes' ? 1 : 4;
  const output = kind === 'biomes' ? new Uint32Array(size) : new Uint16Array(size);
  if (encodedBits === 0) {
    const singleton = reader.varint();
    if (kind !== 'biomes' && singleton > 65535) throw new Error('Block state exceeds supported 1.20.4 range.');
    output.fill(singleton);
    if (reader.varint() !== 0) throw new Error('Single-value palette has unexpected data.');
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
  const count = reader.varint();
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

export function decodeChunkSections(bytes, { minY = -64, height = 384 } = {}) {
  if (minY % 16 || height % 16 || height <= 0 || height > 4096) throw new Error('Invalid dimension section bounds.');
  const reader = new ChunkReader(bytes);
  const sections = [];
  for (let i = 0; i < height / 16; i++) {
    const nonAirCount = reader.u16();
    if (nonAirCount > 4096) throw new Error('Invalid section block count.');
    const blocks = decodePalettedContainer(reader, 4096, 'blocks');
    const biomes = decodePalettedContainer(reader, 64, 'biomes');
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

export function textComponent(value) {
  value = simplifyNbt(value);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.startsWith('{') || value.startsWith('[')) { try { return textComponent(JSON.parse(value)); } catch {} }
    return value;
  }
  if (Array.isArray(value)) return value.map(textComponent).join('');
  if (typeof value !== 'object') return String(value);
  let result = value.text || '';
  if (value.translate) {
    const args = (value.with || []).map(textComponent);
    if (value.translate === 'chat.type.text') result += `<${args[0] || ''}> ${args[1] || ''}`;
    else if (value.translate === 'chat.type.announcement') result += `[${args[0] || ''}] ${args[1] || ''}`;
    else result += `${value.fallback || value.translate}${args.length ? ` ${args.join(' ')}` : ''}`;
  }
  if (value.extra) result += textComponent(value.extra);
  return result;
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
    this.itemDefinitions = new Map((callbacks.registry?.items || []).map((item) => [item.id, item]));
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
    this.state = { status: 'disconnected', minY: -64, height: 384, gameMode: 0, entityId: null, health: 20, food: 20, selectedSlot: 0 };
    this.position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, grounded: false };
    this.hasPosition = false;
    this.movementClock = 0;
    this.sequence = 0;
    this.pendingDig = null;
    this.keepAliveManaged = true;
    this.chunksPerTick = Math.max(1, Math.min(16, Number(callbacks.chunksPerTick) || 4));
    this.effects = new Map();
  }

  event(event) { this.callbacks.onEvent?.(event); }
  changeState(patch) { Object.assign(this.state, patch); this.callbacks.onState?.({ ...this.state }); }
  packet(name, data = {}) { return this.transport.packet(name, data); }

  connect(url, options = {}) {
    this.disconnect();
    this.columns.clear(); this.entities.clear(); this.players.clear(); this.windows.clear(); this.dimensionTypes.clear(); this.effects.clear();
    this.hasPosition = false; this.sequence = 0; this.movementClock = 0;
    this.changeState({ status: 'connecting', username: options.username, host: options.host, minY: -64, height: 384, gameMode: 0, selectedSlot: 0, health: 20, food: 20, effects: [], attributes: [] });
    this.keepAliveManaged = options.keepAliveManaged !== false;
    return this.transport.connect(url, { host: options.host || 'localhost', port: Number(options.port) || 25565, username: options.username || 'Player', auth: options.auth || 'offline', version: '1.20.4' });
  }

  disconnect() {
    this.pendingDig = null;
    this.transport.close();
    if (this.state.status !== 'disconnected') this.changeState({ status: 'disconnected' });
  }

  receive(message) {
    if (message.type === 'packet') {
      try { this.handlePacket(message.name, message.data || {}, message.state); }
      catch (error) { this.event({ type: 'error', message: `Cannot decode ${message.name}: ${error.message}`, packet: message.name }); }
      return;
    }
    if (message.type === 'connected') {
      this.changeState({ status: 'connected', username: message.username || this.state.username, version: message.version });
      this.packet('settings', { locale: 'en_US', viewDistance: 8, chatFlags: 0, chatColors: true, skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true });
    } else if (message.type === 'connecting') this.changeState({ status: 'connecting' });
    else if (message.type === 'disconnected') this.changeState({ status: 'disconnected', reason: textComponent(message.reason) });
    else this.event(message);
  }

  setDimension(type, name, extra = {}) {
    const dimension = this.dimensionTypes.get(type) || { min_y: type?.includes('overworld') ? -64 : 0, height: type?.includes('overworld') ? 384 : 256, has_skylight: type?.includes('overworld') };
    for (const column of this.columns.values()) this.callbacks.onUnload?.({ x: column.x, z: column.z });
    this.columns.clear(); this.entities.clear(); this.hasPosition = false;
    this.changeState({ ...extra, dimension: name || type, dimensionType: type, minY: dimension.min_y, height: dimension.height, hasSkylight: Boolean(dimension.has_skylight), status: 'loading' });
  }

  handlePacket(name, data, packetState = 'play') {
    switch (name) {
      case 'registry_data': {
        const codec = simplifyNbt(data.codec || data.registry || data);
        const entries = codec['minecraft:dimension_type']?.value || codec['minecraft:dimension_type']?.entries || [];
        for (const entry of entries) this.dimensionTypes.set(entry.name, entry.element || entry.value);
        this.event({ type: 'registry', codec });
        break;
      }
      case 'login':
        if (packetState === 'configuration' || packetState === 'login') break;
        this.setDimension(data.worldType, data.worldName, { entityId: data.entityId, gameMode: data.gameMode & 3, viewDistance: data.viewDistance, isHardcore: data.isHardcore });
        break;
      case 'respawn':
        this.effects.clear();
        this.setDimension(data.dimension, data.worldName, { gameMode: data.gamemode & 3 });
        this.changeState({ effects: [], attributes: [] });
        this.pendingDig = null;
        break;
      case 'position': {
        const flags = data.flags || 0;
        const prior = this.position;
        const serverYaw = flags & 8 ? (prior.yaw * DEGREES + 180) + data.yaw : data.yaw;
        const serverPitch = flags & 16 ? -prior.pitch * DEGREES + data.pitch : data.pitch;
        this.position = {
          x: data.x + (flags & 1 ? prior.x : 0), y: data.y + (flags & 2 ? prior.y : 0), z: data.z + (flags & 4 ? prior.z : 0),
          yaw: (serverYaw - 180) / DEGREES, pitch: -serverPitch / DEGREES, grounded: false,
        };
        this.hasPosition = true;
        this.packet('teleport_confirm', { teleportId: data.teleportId });
        this.sendPosition(this.position);
        this.callbacks.onPosition?.({ ...this.position, flags, teleportId: data.teleportId });
        this.changeState({ status: 'playing' });
        break;
      }
      case 'map_chunk': {
        const sections = decodeChunkSections(data.chunkData, this.state);
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
        this.callbacks.onInventory?.({ ...window });
        break;
      }
      case 'open_window': this.changeState({ windowId: data.windowId }); this.event({ type: 'window', ...data, title: textComponent(data.windowTitle) }); break;
      case 'close_window': this.changeState({ windowId: 0 }); this.event({ type: 'close-window', windowId: data.windowId }); break;
      case 'held_item_slot': this.changeState({ selectedSlot: data.slot }); this.emitInventory(); break;
      case 'experience': this.changeState({ experience: data.experienceBar, experienceLevel: data.level, totalExperience: data.totalExperience }); break;
      case 'system_chat': this.event({ type: 'chat', text: textComponent(data.content), actionBar: data.isActionBar }); break;
      case 'profileless_chat': this.event({ type: 'chat', text: `${textComponent(data.name)}: ${textComponent(data.message)}` }); break;
      case 'player_chat': this.event({ type: 'chat', text: data.unsignedChatContent ? textComponent(data.unsignedChatContent) : `<${textComponent(data.networkName) || this.players.get(data.senderUuid)?.name || data.senderUuid}> ${data.plainMessage}`, sender: data.senderUuid }); break;
      case 'kick_disconnect':
      case 'disconnect': this.changeState({ status: 'disconnected', reason: textComponent(data.reason) }); break;
      case 'death_combat_event': this.event({ type: 'death', text: textComponent(data.message) }); break;
      case 'player_info':
        for (const info of data.data || []) {
          const player = { ...this.players.get(info.uuid), ...info, name: info.player?.name || this.players.get(info.uuid)?.name };
          this.players.set(info.uuid, player);
          this.callbacks.onEntity?.({ type: 'player-info', player });
        }
        break;
      case 'player_remove':
        for (const uuid of data.players || []) { this.players.delete(uuid); this.callbacks.onEntity?.({ type: 'player-remove', uuid }); }
        break;
      case 'spawn_entity': {
        const entity = { id: data.entityId, uuid: data.objectUUID, entityType: data.type, x: data.x, y: data.y, z: data.z, yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, metadata: [], velocity: data.velocity };
        this.entities.set(entity.id, entity);
        this.callbacks.onEntity?.({ type: 'spawn', entity: { ...entity } });
        break;
      }
      case 'rel_entity_move':
      case 'entity_move_look': this.entityUpdate(data.entityId, { dx: data.dX / 4096, dy: data.dY / 4096, dz: data.dZ / 4096, ...(name === 'entity_move_look' ? { yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU } : {}), grounded: data.onGround }); break;
      case 'entity_look': this.entityUpdate(data.entityId, { yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, grounded: data.onGround }); break;
      case 'entity_teleport': this.entityUpdate(data.entityId, { x: data.x, y: data.y, z: data.z, yaw: data.yaw / 256 * TAU, pitch: data.pitch / 256 * TAU, grounded: data.onGround }); break;
      case 'entity_head_rotation': this.entityUpdate(data.entityId, { headYaw: data.headYaw / 256 * TAU }); break;
      case 'entity_velocity':
        if (data.entityId === this.state.entityId) {
          const event = { type: 'player-velocity', id: data.entityId, velocity: { x: data.velocity.x / 8000, y: data.velocity.y / 8000, z: data.velocity.z / 8000 } };
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
          this.effects.set(data.effectId, { id: data.effectId, name: names[data.effectId], amplifier: data.amplifier, duration: data.duration });
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
      case 'set_passengers': this.entityUpdate(data.entityId, { passengers: data.passengers }); break;
      case 'entity_status': this.callbacks.onEntity?.({ type: 'status', id: data.entityId, status: data.entityStatus }); break;
      case 'animation': this.callbacks.onEntity?.({ type: 'animation', id: data.entityId, animation: data.animation }); break;
      case 'collect': this.callbacks.onEntity?.({ type: 'collect', id: data.collectedEntityId, collectorId: data.collectorEntityId, count: data.pickupItemCount }); break;
      case 'entity_metadata': {
        const entity = this.entities.get(data.entityId);
        const metadata = new Map((entity?.metadata || []).map((item) => [item.key, item]));
        for (const item of data.metadata) metadata.set(item.key, item);
        this.entityUpdate(data.entityId, { metadata: [...metadata.values()] });
        break;
      }
      case 'entity_equipment': {
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
      case 'resource_pack_send': this.event({ type: 'resource-pack', ...data }); break;
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
    this.callbacks.onEntity?.({ type: 'update', entity: { ...entity } });
  }

  sendPosition(position) {
    return this.packet('position_look', { x: position.x, y: position.y, z: position.z, yaw: ((position.yaw * DEGREES + 180) % 360 + 360) % 360, pitch: -position.pitch * DEGREES, onGround: Boolean(position.grounded) });
  }

  tick(player, dt) {
    if (!this.hasPosition || this.state.status !== 'playing') return;
    const position = player.position || [player.x, player.y, player.z];
    this.position = { x: position[0], y: position[1], z: position[2], yaw: player.yaw, pitch: player.pitch, grounded: Boolean(player.grounded) };
    if (![this.position.x, this.position.y, this.position.z, this.position.yaw, this.position.pitch].every(Number.isFinite)) return;
    this.movementClock += Math.min(Math.max(dt, 0), 0.25);
    if (this.movementClock >= 0.05) { this.movementClock %= 0.05; this.sendPosition(this.position); }
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

  setCreativeSlot(itemId, count = 64, hotbarSlot = this.state.selectedSlot) {
    if (this.state.gameMode !== 1 || !Number.isInteger(hotbarSlot) || hotbarSlot < 0 || hotbarSlot > 8) return false;
    if (itemId !== null && (!Number.isInteger(itemId) || itemId < 0)) return false;
    const stackSize = this.itemDefinitions.get(itemId)?.stackSize || 64;
    const item = itemId === null ? { present: false } : { present: true, itemId, itemCount: Math.max(1, Math.min(stackSize, count)), nbtData: undefined };
    return this.packet('set_creative_slot', { slot: 36 + hotbarSlot, item });
  }

  clickWindow(slot, { button = 0, mode = 0, windowId = this.state.windowId || 0, changedSlots, cursorItem } = {}) {
    const window = this.windows.get(windowId);
    if (!window) return false;
    const prediction = this.predictClick(window, slot, button, mode);
    return this.packet('window_click', { windowId, stateId: window.stateId, slot, mouseButton: button, mode, changedSlots: changedSlots || prediction.changedSlots, cursorItem: cursorItem || prediction.cursorItem });
  }

  // Predict the packet's expected result from confirmed stacks, while retaining
  // the confirmed inventory until the server returns window_items/set_slot.
  predictClick(window, slot, button, mode) {
    const carried = window.cursor?.present ? { ...window.cursor } : { present: false };
    const clicked = window.slots[slot]?.present ? { ...window.slots[slot] } : { present: false };
    const result = { changedSlots: [], cursorItem: carried };
    if (mode !== 0 || (button !== 0 && button !== 1)) return result;
    if (slot === -999) {
      if (carried.present) result.cursorItem = button === 0 || carried.itemCount === 1 ? { present: false } : { ...carried, itemCount: carried.itemCount - 1 };
      return result;
    }
    if (slot < 0 || slot >= window.slots.length) return result;
    let target = clicked;
    const same = carried.present && clicked.present && carried.itemId === clicked.itemId && slotJson(carried.nbtData ?? null) === slotJson(clicked.nbtData ?? null);
    if (!carried.present && clicked.present) {
      const amount = button === 1 ? Math.ceil(clicked.itemCount / 2) : clicked.itemCount;
      result.cursorItem = { ...clicked, itemCount: amount };
      target = amount === clicked.itemCount ? { present: false } : { ...clicked, itemCount: clicked.itemCount - amount };
    } else if (carried.present && (!clicked.present || same)) {
      const maximum = this.itemDefinitions.get(carried.itemId)?.stackSize || 64;
      const previous = clicked.present ? clicked.itemCount : 0;
      const amount = Math.min(maximum - previous, button === 1 ? 1 : carried.itemCount);
      if (amount > 0) {
        target = { ...carried, itemCount: previous + amount };
        result.cursorItem = amount === carried.itemCount ? { present: false } : { ...carried, itemCount: carried.itemCount - amount };
      }
    } else if (carried.present && clicked.present) {
      target = carried;
      result.cursorItem = clicked;
    }
    if (slotJson(target) !== slotJson(clicked)) result.changedSlots.push({ location: slot, item: target });
    return result;
  }

  closeWindow() { const id = this.state.windowId || 0; this.packet('close_window', { windowId: id }); this.changeState({ windowId: 0 }); }
  respawn() { return this.packet('client_command', { actionId: 'perform_respawn' }); }
  sneak(value) { this.state.sneaking = Boolean(value); return this.packet('entity_action', { entityId: this.state.entityId, actionId: value ? 'start_sneaking' : 'stop_sneaking', jumpBoost: 0 }); }
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
