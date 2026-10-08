import { unzipSync } from '../vendor/fflate.js';

export const SOUND_CATEGORIES = Object.freeze(['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui']);
// Pumpkin's generated WorldEvent IDs and the native game's sound registry.
export const WORLD_EVENT_SOUNDS = Object.freeze({
  1000: ['block.dispenser.dispense', 'block'], 1001: ['block.dispenser.fail', 'block'], 1002: ['block.dispenser.launch', 'block'],
  1004: ['entity.firework_rocket.launch', 'neutral'], 1009: ['block.fire.extinguish', 'block'],
  1015: ['entity.ghast.warn', 'hostile'], 1016: ['entity.ghast.shoot', 'hostile'], 1017: ['entity.ender_dragon.shoot', 'hostile'], 1018: ['entity.blaze.shoot', 'hostile'],
  1019: ['entity.zombie.attack_wooden_door', 'hostile'], 1020: ['entity.zombie.attack_iron_door', 'hostile'], 1021: ['entity.zombie.break_wooden_door', 'hostile'],
  1022: ['entity.wither.break_block', 'hostile'], 1023: ['entity.wither.spawn', 'hostile'], 1024: ['entity.wither.shoot', 'hostile'], 1025: ['entity.bat.takeoff', 'neutral'],
  1026: ['entity.zombie.infect', 'hostile'], 1027: ['entity.zombie_villager.converted', 'hostile'], 1028: ['entity.ender_dragon.death', 'hostile'],
  1029: ['block.anvil.destroy', 'block'], 1030: ['block.anvil.use', 'block'], 1031: ['block.anvil.land', 'block'], 1032: ['block.portal.travel', 'player'],
  1033: ['block.chorus_flower.grow', 'block'], 1034: ['block.chorus_flower.death', 'block'], 1035: ['block.brewing_stand.brew', 'block'],
  1038: ['block.end_portal.spawn', 'block'], 1039: ['entity.phantom.bite', 'hostile'], 1040: ['entity.zombie.converted_to_drowned', 'hostile'],
  1041: ['entity.husk.converted_to_zombie', 'hostile'], 1042: ['block.grindstone.use', 'block'], 1043: ['item.book.page_turn', 'block'], 1044: ['block.smithing_table.use', 'block'],
  1045: ['block.pointed_dripstone.land', 'block'], 1046: ['block.pointed_dripstone.drip_lava_into_cauldron', 'block'], 1047: ['block.pointed_dripstone.drip_water_into_cauldron', 'block'],
  1048: ['entity.skeleton.converted_to_stray', 'hostile'], 1501: ['block.lava.extinguish', 'block'], 1502: ['block.redstone_torch.burnout', 'block'],
  1503: ['block.end_portal_frame.fill', 'block'],
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const key = (name, namespace = 'minecraft') => {
  if (typeof name !== 'string') throw new Error('Sound resource name must be a string');
  const qualified = name.includes(':') ? name : `${namespace}:${name}`;
  if (qualified.length > 256 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(qualified) || qualified.split(':')[1].split('/').includes('..')) throw new Error('Invalid sound resource');
  return qualified;
};
const categoryName = value => typeof value === 'number' ? SOUND_CATEGORIES[value] ?? 'master' : SOUND_CATEGORIES.includes(value) ? value : 'master';
const bytesOf = value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : null;
const numeric = (value, fallback, name, min = 0, max = 1_000_000) => {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`Invalid sound ${name}`);
  return result;
};

/** Java Random's 48-bit sequence, also used by the native sound selector. */
export class SoundRandom {
  constructor(seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) {
    this.seed = (BigInt(seed) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  }
  next(bits) { this.seed = (this.seed * 0x5deece66dn + 11n) & ((1n << 48n) - 1n); return Number(this.seed >> BigInt(48 - bits)); }
  nextInt(bound) {
    if (!Number.isInteger(bound) || bound < 1 || bound > 0x7fffffff) return null;
    if ((bound & (bound - 1)) === 0) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    for (;;) { const bits = this.next(31), value = bits % bound; if (bits - value + bound - 1 <= 0x7fffffff) return value; }
  }
}

/** Resource-pack sound registrations, weighted event redirects, and subtitles. */
export class SoundLibrary {
  constructor({ maxBytes = 256 * 1024 * 1024, maxFileBytes = 16 * 1024 * 1024, maxEvents = 32768 } = {}) {
    this.files = new Map(); this.events = new Map(); this.bytes = 0; this.unavailableEvents = 0;
    this.maxBytes = maxBytes; this.maxFileBytes = maxFileBytes; this.maxEvents = maxEvents;
  }
  applyPack(input, { replaceAll = false } = {}) {
    const files = input instanceof Map ? input : new Map(Object.entries(input ?? {}));
    const nextFiles = replaceAll ? new Map() : new Map(this.files), nextEvents = replaceAll ? new Map() : new Map(this.events);
    for (const [path, value] of files) {
      const match = /^assets\/([a-z0-9_.-]+)\/sounds\/(.+)\.ogg$/.exec(path);
      if (!match) continue;
      const name = key(`${match[1]}:${match[2]}`), bytes = bytesOf(value);
      if (!bytes || bytes.length > this.maxFileBytes) throw new Error(`Sound ${name} exceeds the file limit`);
      nextFiles.set(name, bytes);
    }
    const totalBytes = [...nextFiles.values()].reduce((total, value) => total + value.length, 0);
    if (totalBytes > this.maxBytes) throw new Error('Sound assets exceed the memory limit');
    for (const [path, bytes] of files) {
      const match = /^assets\/([a-z0-9_.-]+)\/sounds\.json$/.exec(path);
      if (!match) continue;
      if (!bytesOf(bytes) || bytes.length > 4 * 1024 * 1024) throw new Error('Sound registry exceeds the JSON limit');
      const registrations = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!registrations || typeof registrations !== 'object' || Array.isArray(registrations)) throw new Error('Invalid sounds.json registry');
      for (const [name, definition] of Object.entries(registrations)) {
        const qualified = key(name, match[1]);
        if (!definition || typeof definition !== 'object' || Array.isArray(definition) || definition.replace !== undefined && typeof definition.replace !== 'boolean') throw new Error(`Invalid sound event ${qualified}`);
        if (definition.subtitle !== undefined && typeof definition.subtitle !== 'string') throw new Error('Invalid sound subtitle');
        const sounds = definition.sounds ?? [];
        if (!Array.isArray(sounds) || sounds.length > 4096) throw new Error('Sound variants exceed the limit');
        const entries = sounds.map(raw => {
          const entry = typeof raw === 'string' ? { name: raw } : raw;
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid sound variant');
          const type = entry.type ?? 'file';
          if (!['file', 'event'].includes(type)) throw new Error('Invalid sound variant type');
          const weight = numeric(entry.weight, 1, 'weight', 1, 1_000_000);
          if (!Number.isInteger(weight)) throw new Error('Sound weight must be an integer');
          for (const flag of ['stream', 'preload']) if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') throw new Error(`Invalid sound ${flag}`);
          return { name: key(entry.name, match[1]), type, weight, volume: numeric(entry.volume, 1, 'volume', Number.MIN_VALUE, 64), pitch: numeric(entry.pitch, 1, 'pitch', Number.MIN_VALUE, 64), stream: entry.stream === true, attenuationDistance: numeric(entry.attenuation_distance, 16, 'attenuation distance', 0, 1024) };
        });
        const previous = nextEvents.get(qualified);
        const combined = definition.replace || !previous ? entries : [...previous.entries, ...entries];
        if (combined.length > 8192) throw new Error('Stacked sound variants exceed the limit');
        nextEvents.set(qualified, { entries: combined, subtitle: definition.subtitle ?? previous?.subtitle });
      }
    }
    if (nextEvents.size > this.maxEvents) throw new Error('Sound event count exceeds the limit');
    this.files = nextFiles; this.events = nextEvents; this.bytes = totalBytes;
    this.unavailableEvents = [...this.events.keys()].filter(name => !this.weight(name)).length;
    return this.stats();
  }
  weight(name, stack = new Set()) {
    if (stack.size >= 32 || stack.has(name)) return 0;
    const event = this.events.get(name); if (!event) return 0;
    const next = new Set(stack).add(name);
    return event.entries.reduce((total, entry) => Math.min(0x7fffffff, total + (entry.type === 'event' ? this.weight(entry.name, next) : this.files.has(entry.name) ? entry.weight : 0)), 0);
  }
  choose(name, seed, { random = new SoundRandom(seed), stack = new Set() } = {}) {
    name = key(name);
    if (stack.size >= 32 || stack.has(name)) return null;
    const event = this.events.get(name); if (!event) return null;
    const next = new Set(stack).add(name);
    const weights = event.entries.map(entry => entry.type === 'event' ? this.weight(entry.name, next) : this.files.has(entry.name) ? entry.weight : 0);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let pick = random.nextInt(total); if (pick === null) return null;
    for (let index = 0; index < weights.length; index++) {
      if (pick >= weights[index]) { pick -= weights[index]; continue; }
      const entry = event.entries[index];
      if (entry.type === 'file') return { ...entry, bytes: this.files.get(entry.name), event: name, subtitle: event.subtitle };
      const selected = this.choose(entry.name, seed, { random, stack: next });
      return selected ? { ...selected, volume: selected.volume * entry.volume, pitch: selected.pitch * entry.pitch, stream: selected.stream || entry.stream, event: name, subtitle: event.subtitle ?? selected.subtitle } : null;
    }
    return null;
  }
  stats() { return { events: this.events.size, files: this.files.size, compressedBytes: this.bytes, unavailableEvents: this.unavailableEvents }; }
}

/** Only explicit user ZIPs are read; Java's client JAR does not contain OGGs. */
export async function loadAudioPack(input, { maxBytes = 256 * 1024 * 1024, maxFileBytes = 16 * 1024 * 1024 } = {}) {
  const bytes = bytesOf(input) ?? new Uint8Array(await input.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('Audio pack exceeds the archive limit');
  let inflated = 0;
  const archive = unzipSync(bytes, { filter(entry) {
    if (!/(?:^|\/)assets\/[a-z0-9_.-]+\/(?:sounds\.json|sounds\/.+\.ogg)$/.test(entry.name)) return false;
    if (entry.name.split('/').includes('..') || entry.originalSize > maxFileBytes || (inflated += entry.originalSize) > maxBytes) throw new Error('Audio archive exceeds safe asset limits');
    return true;
  } });
  return new Map(Object.entries(archive).map(([path, value]) => [path.slice(path.indexOf('assets/')), value]));
}

export function resolveSoundPacket(name, packet, registry) {
  let event, range, position, entityId;
  if (name === 'sound_effect') {
    const holder = packet.sound;
    if (Number.isInteger(holder?.soundId)) event = registry.sounds?.find(sound => sound.id === holder.soundId)?.name;
    else { event = holder?.data?.soundName; range = holder?.data?.fixedRange; }
    position = [packet.x / 8, packet.y / 8, packet.z / 8];
  } else if (name === 'entity_sound_effect') {
    if (packet.soundId > 0) event = registry.sounds?.find(sound => sound.id === packet.soundId - 1)?.name;
    else { event = packet.soundEvent?.resource; range = packet.soundEvent?.range; }
    entityId = packet.entityId;
  } else if (name === 'named_sound_effect') {
    event = packet.soundName; position = [packet.x / 8, packet.y / 8, packet.z / 8];
  } else return null;
  if (!event || position && !position.every(Number.isFinite)) return null;
  return { event: key(event), category: categoryName(packet.soundCategory), position, entityId, volume: clamp(Number(packet.volume) || 0, 0, 64), pitch: clamp(Number(packet.pitch) || 1, 0.01, 64), range: Number.isFinite(range) ? Math.max(0, range) : undefined, seed: packet.seed };
}

/** Bounded Web Audio playback, with entity-following positions and stream music. */
export class MinecraftAudio {
  get registry() { return this._registry; }
  set registry(value) { this._registry = value ?? {}; this.blockDefinitions = [...(this._registry.blocks ?? [])].sort((a, b) => a.minStateId - b.minStateId); this.local = null; }
  constructor({ registry = {}, contextFactory = () => new (globalThis.AudioContext ?? globalThis.webkitAudioContext)(), elementFactory = () => new Audio(), getEntityPosition = () => null, onSubtitle = () => {}, maxVoices = 48, maxDecodedBytes = 64 * 1024 * 1024, now = () => performance.now() / 1000 } = {}) {
    this.registry = registry; this.contextFactory = contextFactory; this.elementFactory = elementFactory; this.getEntityPosition = getEntityPosition; this.onSubtitle = onSubtitle; this.now = now;
    this.maxVoices = maxVoices; this.maxDecodedBytes = maxDecodedBytes;
    this.library = new SoundLibrary(); this.context = null; this.master = null; this.categoryNodes = new Map(); this.volumes = new Map(SOUND_CATEGORIES.map(name => [name, 1]));
    this.voices = new Map(); this.pendingPlays = new Set(); this.decoded = new Map(); this.decoding = new Map(); this.queue = []; this.nextVoiceId = 0; this.generation = 0; this.decodeActive = 0;
    this.listener = { eye: [0, 0, 0], direction: [0, 0, -1], up: [0, 1, 0] }; this.unlocked = false; this.closed = false;
    this.counts = { played: 0, dropped: 0, missing: 0, decodeErrors: 0, decodedBytes: 0, streamed: 0, lastError: null };
    this.musicMode = 'none'; this.musicAt = Infinity; this.musicVoice = null; this.musicEpoch = 0;
    this.local = null; this.records = new Map(); this.recordEpoch = new Map();
  }
  applyPack(files, options) {
    const result = this.library.applyPack(files, options);
    this.stop(); this.generation++; this.decoded.clear(); this.counts.decodedBytes = 0; this.decoding.clear();
    if (this.musicMode !== 'none') this.musicAt = this.now();
    return result;
  }
  async unlock() {
    if (this.closed) return false;
    try {
      if (!this.context) {
        this.context = this.contextFactory(); this.master = this.context.createGain(); this.master.gain.value = this.volumes.get('master'); this.master.connect(this.context.destination);
        for (const name of SOUND_CATEGORIES.filter(value => value !== 'master')) { const node = this.context.createGain(); node.gain.value = this.volumes.get(name); node.connect(this.master); this.categoryNodes.set(name, node); }
      }
      await this.context.resume(); this.unlocked = this.context.state === 'running';
      if (!this.unlocked) return false;
      this.updateListener(this.listener);
      const pending = this.queue.splice(0); for (const request of pending) if (this.now() - request.at < 2) void this.play(request.event, request.options);
      return true;
    } catch (error) { this.counts.lastError = error.message; return false; }
  }
  setVolume(category, value) {
    category = categoryName(category); if (!Number.isFinite(value)) return;
    value = clamp(value, 0, 1); this.volumes.set(category, value);
    const node = category === 'master' ? this.master : this.categoryNodes.get(category);
    if (node) node.gain.setValueAtTime(value, this.context.currentTime);
  }
  updateListener({ eye = this.listener.eye, direction = this.listener.direction, up = [0, 1, 0] } = {}) {
    if (![...eye, ...direction, ...up].every(Number.isFinite)) return;
    this.listener = { eye: [...eye], direction: [...direction], up: [...up] };
    const listener = this.context?.listener; if (!listener) return;
    const time = this.context.currentTime;
    if (listener.positionX) {
      for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]]) { listener[`position${axis}`].setValueAtTime(eye[index], time); listener[`forward${axis}`].setValueAtTime(direction[index], time); listener[`up${axis}`].setValueAtTime(up[index], time); }
    } else { listener.setPosition(...eye); listener.setOrientation(...direction, ...up); }
  }
  async decode(variant, generation) {
    if (this.decoded.has(variant.name)) { const buffer = this.decoded.get(variant.name); this.decoded.delete(variant.name); this.decoded.set(variant.name, buffer); return buffer; }
    if (this.decoding.has(variant.name)) return this.decoding.get(variant.name);
    if (this.decodeActive >= 4) { this.counts.dropped++; return null; }
    this.decodeActive++;
    const pending = this.context.decodeAudioData(variant.bytes.slice().buffer).then(buffer => {
      if (generation !== this.generation || this.closed) return null;
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      for (const [name, previous] of this.decoded) {
        if (this.counts.decodedBytes + bytes <= this.maxDecodedBytes) break;
        if ([...this.voices.values()].some(voice => voice.bufferName === name)) continue;
        this.decoded.delete(name); this.counts.decodedBytes -= previous.length * previous.numberOfChannels * 4;
      }
      if (this.counts.decodedBytes + bytes > this.maxDecodedBytes) { this.counts.dropped++; return null; }
      this.decoded.set(variant.name, buffer); this.counts.decodedBytes += bytes; return buffer;
    }).catch(error => { this.counts.decodeErrors++; this.counts.lastError = error.message; return null; }).finally(() => { this.decodeActive--; if (this.decoding.get(variant.name) === pending) this.decoding.delete(variant.name); });
    this.decoding.set(variant.name, pending); return pending;
  }
  playPacket(name, packet) { const sound = resolveSoundPacket(name, packet, this.registry); return sound ? this.play(sound.event, sound) : Promise.resolve(null); }
  blockDefinition(stateId) {
    let low = 0, high = this.blockDefinitions.length - 1;
    while (low <= high) { const middle = low + high >> 1, block = this.blockDefinitions[middle]; if (stateId < block.minStateId) high = middle - 1; else if (stateId > block.maxStateId) low = middle + 1; else return block; }
    return null;
  }
  blockAction({ kind, x, y, z, stateId, seed } = {}) {
    const block = this.blockDefinition(stateId);
    if (!block || ['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name) || ![x, y, z].every(Number.isFinite)) return Promise.resolve(null);
    const sound = this.registry.blockSounds?.[block.name];
    if (!sound) return Promise.resolve(null);
    let event, volume, pitch;
    if (kind === 'hit') { event = sound[0]; volume = (sound[2] + 1) / 8; pitch = sound[3] * 0.5; }
    else if (kind === 'break') { event = sound[1]; volume = (sound[2] + 1) / 2; pitch = sound[3] * 0.8; }
    else if (kind === 'step' || kind === 'place') {
      event = sound[0]?.replace(/\.hit$/, `.${kind}`); volume = kind === 'step' ? sound[2] * 0.15 : (sound[2] + 1) / 2; pitch = kind === 'step' ? sound[3] : sound[3] * 0.8;
      if (!event || !this.library.events.has(key(event))) return Promise.resolve(null);
    } else return Promise.resolve(null);
    return event ? this.play(event, { category: 'block', position: [x + 0.5, y + 0.5, z + 0.5], volume, pitch, seed }) : Promise.resolve(null);
  }
  async worldEvent(packet = {}) {
    const location = packet.location;
    if (!location || ![location.x, location.y, location.z].every(Number.isFinite)) return null;
    if (packet.effectId === 2001) return this.blockAction({ kind: 'break', ...location, stateId: packet.data });
    const position = [location.x + 0.5, location.y + 0.5, location.z + 0.5];
    if (packet.effectId === 1010 || packet.effectId === 1011) {
      const recordKey = `${location.x},${location.y},${location.z}`, epoch = (this.recordEpoch.get(recordKey) ?? 0) + 1;
      if (!this.recordEpoch.has(recordKey) && this.recordEpoch.size >= this.maxVoices * 4) { const oldest = this.recordEpoch.keys().next().value; this.recordEpoch.delete(oldest); this.finish(this.voices.get(this.records.get(oldest)), true); }
      this.recordEpoch.set(recordKey, epoch);
      this.finish(this.voices.get(this.records.get(recordKey)), true); this.records.delete(recordKey);
      if (packet.effectId === 1011 || packet.data === 0) return null;
      // The 1.20.4 level event carries the music-disc item ID. Later protocol
      // versions carry a jukebox-song registry ID and need another mapping.
      const item = this.registry.items?.find(item => item.id === packet.data);
      if (!item?.name?.startsWith('music_disc_')) return null;
      const id = await this.play(`music_disc.${item.name.slice(11)}`, { category: 'record', position, range: 64, volume: 4 });
      if (id && this.recordEpoch.get(recordKey) === epoch && this.voices.has(id)) this.records.set(recordKey, id);
      else this.finish(this.voices.get(id), true);
      return id;
    }
    const sound = WORLD_EVENT_SOUNDS[packet.effectId];
    if (!sound) return null;
    return this.play(sound[0], { category: sound[1], position: packet.global ? null : position, volume: packet.effectId === 1031 ? 0.3 : 1, pitch: [1001, 1002].includes(packet.effectId) ? 1.2 : 1 });
  }
  localTick(dt, { player, world, session, keys } = {}) {
    if (!player || !Number.isFinite(dt) || dt < 0 || !player.position?.every(Number.isFinite)) { this.local = null; return; }
    const position = player.position, source = world?.generation ?? world ?? player.core;
    if (!this.local || this.local.player !== player || this.local.source !== source) { this.local = { player, source, position: [...position], grounded: player.grounded, fluid: player.fluid, eyesInWater: player.eyesInWater, distance: 0, nextStep: 1, fallDistance: player.fallDistance ?? 0 }; return; }
    const local = this.local, displacement = position.map((value, axis) => value - local.position[axis]), travelled = Math.hypot(...displacement);
    if (travelled > 8 || player.waitingForTerrain || player.noclip || session?.state?.gameMode === 3) { local.position = [...position]; local.grounded = player.grounded; local.fluid = player.fluid; local.fallDistance = 0; local.distance = 0; local.nextStep = 1; return; }
    const core = world?.core ?? player.core;
    const x = Math.floor(position[0]), y = Math.floor(position[1] - 0.2), z = Math.floor(position[2]);
    let stateId = core?.block_get?.(x, y, z) ?? 0, stepY = y;
    if (['air', 'cave_air', 'void_air'].includes(this.blockDefinition(stateId)?.name)) {
      const below = core?.block_get?.(x, y - 1, z) ?? 0;
      if (/fence|wall/.test(this.blockDefinition(below)?.name ?? '')) { stateId = below; stepY--; }
    }
    const horizontal = Math.hypot(displacement[0], displacement[2]), velocity = (player.velocity ?? [0, 0, 0]).map(value => value / 20);
    if (player.fluid === 'water' && local.fluid !== 'water') {
      const volume = Math.min(1, Math.hypot(velocity[0] * Math.sqrt(0.2), velocity[1], velocity[2] * Math.sqrt(0.2)) * 0.2);
      if (volume > 0.01) void this.play(volume > 0.25 ? 'entity.player.splash.high_speed' : 'entity.player.splash', { category: 'player', position: [...position], volume });
    }
    if (player.eyesInWater !== local.eyesInWater) void this.play(player.eyesInWater ? 'ambient.underwater.enter' : 'ambient.underwater.exit', { category: 'ambient', volume: 1 });
    if (player.grounded && !local.grounded && local.fallDistance > 3 && !player.fly && player.fluid !== 'water') void this.play(local.fallDistance > 4 ? 'entity.player.big_fall' : 'entity.player.small_fall', { category: 'player', position: [...position], volume: 1 });
    local.fallDistance = player.grounded ? 0 : Math.max(local.fallDistance, player.fallDistance ?? 0);
    if (!player.fly && !player.sneaking && travelled > 0.0001 && (player.grounded || player.climbing || player.fluid === 'water')) {
      local.distance += (player.fluid === 'water' || player.climbing ? travelled : horizontal) * 0.6;
      if (local.distance > local.nextStep) {
        local.nextStep = local.distance + 1;
        if (player.fluid === 'water') {
          const volume = Math.min(1, Math.hypot(velocity[0] * Math.sqrt(0.2), velocity[1], velocity[2] * Math.sqrt(0.2)) * 0.35);
          if (volume > 0.001) void this.play('entity.generic.swim', { category: 'player', position: [...position], volume });
        } else {
          const above = core?.block_get?.(x, stepY + 1, z) ?? 0, aboveBlock = this.blockDefinition(above);
          void this.blockAction({ kind: 'step', x, y: aboveBlock?.name === 'snow' ? stepY + 1 : stepY, z, stateId: aboveBlock?.name === 'snow' ? above : stateId });
        }
      }
    }
    local.position = [...position]; local.grounded = player.grounded; local.fluid = player.fluid; local.eyesInWater = player.eyesInWater;
  }
  async play(event, options = {}) {
    if (this.closed) return null;
    event = key(event);
    if (!this.unlocked || this.context?.state !== 'running') {
      if (this.queue.length >= 16) { this.queue.shift(); this.counts.dropped++; }
      this.queue.push({ event, options, at: this.now() }); return null;
    }
    let variant;
    try { variant = this.library.choose(event, options.seed); } catch { this.counts.dropped++; return null; }
    if (!variant) { this.counts.missing++; return null; }
    const category = categoryName(options.category), volume = clamp((options.volume ?? 1) * variant.volume, 0, 1), pitch = clamp((options.pitch ?? 1) * variant.pitch, 0.01, 64);
    let position = options.position;
    if (options.entityId !== undefined) position = this.getEntityPosition(options.entityId);
    if (options.entityId !== undefined && !position || position && (!Array.isArray(position) || !position.every(Number.isFinite))) return null;
    const range = options.range ?? Math.max((options.volume ?? 1) * variant.volume, 1) * variant.attenuationDistance;
    if (variant.subtitle) this.onSubtitle({ key: variant.subtitle, event, position, range });
    if (!volume || !this.volumes.get('master') || !this.volumes.get(category)) return null;
    if (position && Math.hypot(...position.map((coordinate, axis) => coordinate - this.listener.eye[axis])) > range) return null;
    const request = { event, category, cancelled: false }; this.pendingPlays.add(request);
    const generation = this.generation;
    const buffer = variant.stream ? null : await this.decode(variant, generation);
    this.pendingPlays.delete(request);
    if (request.cancelled || generation !== this.generation || this.closed || !variant.stream && !buffer) return null;
    if (this.voices.size >= this.maxVoices) { const oldest = this.voices.values().next().value; this.finish(oldest, true); this.counts.dropped++; }
    const gain = this.context.createGain(); gain.gain.value = volume;
    let source, element, url;
    if (variant.stream) {
      try {
        element = this.elementFactory(); url = URL.createObjectURL(new Blob([variant.bytes], { type: 'audio/ogg' })); element.src = url; element.preload = 'auto'; element.playbackRate = pitch; element.loop = options.loop === true;
        source = this.context.createMediaElementSource(element);
      } catch (error) { if (url) URL.revokeObjectURL(url); this.counts.lastError = error.message; return null; }
    } else { source = this.context.createBufferSource(); source.buffer = buffer; source.playbackRate.value = pitch; source.loop = options.loop === true; }
    source.connect(gain);
    const voice = { id: ++this.nextVoiceId, event, category, source, gain, entityId: options.entityId, position, range, volume, element, url, bufferName: variant.stream ? null : variant.name, started: this.now(), generation };
    if (position) {
      const panner = this.context.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'linear'; panner.refDistance = 0; panner.maxDistance = Math.max(0.001, range); panner.rolloffFactor = 1;
      gain.connect(panner); panner.connect(this.categoryNodes.get(category) ?? this.master); voice.panner = panner; this.positionVoice(voice, position);
    } else gain.connect(this.categoryNodes.get(category) ?? this.master);
    this.voices.set(voice.id, voice);
    if (element) {
      element.onended = () => this.finish(voice); element.onerror = () => { this.counts.decodeErrors++; this.counts.lastError = 'The browser cannot decode this OGG stream'; this.finish(voice, true); };
      try { await element.play(); this.counts.streamed++; } catch (error) { this.counts.lastError = error.message; this.finish(voice, true); return null; }
    } else { source.onended = () => this.finish(voice); source.start(); }
    this.counts.played++; return voice.id;
  }
  positionVoice(voice, position) {
    voice.position = [...position];
    const node = voice.panner, time = this.context.currentTime;
    if (node.positionX) { node.positionX.setValueAtTime(position[0], time); node.positionY.setValueAtTime(position[1], time); node.positionZ.setValueAtTime(position[2], time); }
    else node.setPosition(...position);
  }
  finish(voice, stop = false) {
    if (!voice || !this.voices.delete(voice.id)) return;
    if (voice.element) { voice.element.onended = null; voice.element.onerror = null; voice.element.pause(); voice.element.removeAttribute('src'); voice.element.load(); URL.revokeObjectURL(voice.url); }
    else { voice.source.onended = null; if (stop) { try { voice.source.stop(); } catch {} } }
    voice.source.disconnect(); voice.gain.disconnect(); voice.panner?.disconnect();
    for (const [name, id] of this.records) if (id === voice.id) this.records.delete(name);
    if (voice.id === this.musicVoice) { this.musicVoice = null; this.musicAt = this.now() + (this.musicMode === 'menu' ? 20 + Math.random() * 20 : 600 + Math.random() * 600); }
  }
  stop({ category, event } = {}) {
    const source = category === undefined ? undefined : categoryName(category), name = event === undefined ? undefined : key(event);
    this.queue = this.queue.filter(request => (source !== undefined && categoryName(request.options.category) !== source) || (name !== undefined && request.event !== name));
    for (const request of this.pendingPlays) if ((source === undefined || request.category === source) && (name === undefined || request.event === name)) request.cancelled = true;
    for (const voice of [...this.voices.values()]) if ((source === undefined || voice.category === source) && (name === undefined || voice.event === name)) this.finish(voice, true);
  }
  stopPacket(packet) { this.stop({ category: packet.flags & 1 ? packet.source : undefined, event: packet.flags & 2 ? packet.sound : undefined }); }
  setMusicMode(mode = 'none') {
    if (mode === this.musicMode) return;
    this.musicEpoch++;
    if (this.musicVoice !== null) this.finish(this.voices.get(this.musicVoice), true);
    this.musicMode = mode; this.musicVoice = null; this.musicAt = mode === 'none' ? Infinity : this.now();
  }
  tick() {
    if (this.closed) return;
    for (const voice of [...this.voices.values()]) if (voice.entityId !== undefined) { const position = this.getEntityPosition(voice.entityId); if (position) this.positionVoice(voice, position); else this.finish(voice, true); }
    if (this.unlocked && this.musicMode !== 'none' && this.musicVoice === null && this.now() >= this.musicAt) {
      const event = { menu: 'music.menu', creative: 'music.creative', game: 'music.game', underwater: 'music.under_water', nether: 'music.nether.nether_wastes', end: 'music.end' }[this.musicMode] ?? this.musicMode;
      const epoch = this.musicEpoch;
      this.musicAt = this.now() + 60;
      void this.play(event, { category: 'music' }).then(id => { if (this.musicMode !== 'none' && epoch === this.musicEpoch && this.voices.has(id)) this.musicVoice = id; else this.finish(this.voices.get(id), true); });
    }
  }
  stats() { return { ...this.counts, ...this.library.stats(), voices: this.voices.size, queued: this.queue.length, decodeActive: this.decodeActive, unlocked: this.unlocked, musicMode: this.musicMode, musicVoice: this.musicVoice, maxVoices: this.maxVoices, maxDecodedBytes: this.maxDecodedBytes }; }
  destroy() { if (this.closed) return; this.stop(); this.closed = true; this.generation++; this.decoded.clear(); this.decoding.clear(); this.counts.decodedBytes = 0; for (const node of this.categoryNodes.values()) node.disconnect(); this.master?.disconnect(); void this.context?.close(); }
}
