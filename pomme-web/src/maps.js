import { simplifyNbt, textComponent } from './minecraft.js';

// Java 1.20.4 MapColor's 64 material slots and two-bit brightness encoding.
// These are color values, not textures; imported resource packs supply the
// decoration sprites, background and font. Slots 62 and 63 resolve to NONE.
export const MAP_COLORS = Object.freeze([
  0, 8368696, 16247203, 0xc7c7c7, 0xff0000, 0xa0a0ff, 0xa7a7a7, 31744,
  0xffffff, 10791096, 9923917, 0x707070, 0x4040ff, 9402184, 0xfffcf5, 14188339,
  11685080, 6724056, 0xe5e533, 8375321, 15892389, 0x4c4c4c, 0x999999, 5013401,
  8339378, 3361970, 6704179, 6717235, 0x993333, 0x191919, 16445005, 6085589,
  4882687, 55610, 8476209, 0x700200, 13742497, 10441252, 9787244, 7367818,
  12223780, 6780213, 10505550, 0x392923, 8874850, 0x575c5c, 8014168, 4996700,
  4993571, 5001770, 9321518, 2430480, 12398641, 9715553, 6035741, 1474182,
  3837580, 5647422, 1356933, 0x646464, 14200723, 8365974, 0, 0,
]);
const BRIGHTNESS = [180, 220, 255, 135];
export const MAP_DECORATIONS = Object.freeze([
  ['player', false], ['frame', true], ['red_marker', false], ['blue_marker', false],
  ['target_x', true], ['target_point', true], ['player_off_map', false], ['player_off_limits', false],
  ['mansion', true], ['monument', true], ['banner_white', true], ['banner_orange', true],
  ['banner_magenta', true], ['banner_light_blue', true], ['banner_yellow', true], ['banner_lime', true],
  ['banner_pink', true], ['banner_gray', true], ['banner_light_gray', true], ['banner_cyan', true],
  ['banner_purple', true], ['banner_blue', true], ['banner_brown', true], ['banner_green', true],
  ['banner_red', true], ['banner_black', true], ['red_x', true], ['village_desert', true],
  ['village_plains', true], ['village_savanna', true], ['village_snowy', true], ['village_taiga', true],
  ['jungle_temple', true], ['swamp_hut', true], ['trial_chambers', true],
].map(([name, frame]) => Object.freeze({ name, frame })));
const SIZE = 128, PIXELS = SIZE * SIZE, DB_NAME = 'pomme-minecraft-maps', DB_VERSION = 1;
const mapBytes = entry => PIXELS + entry.icons.reduce((bytes, icon) => bytes + 32 + icon.name.length * 2, 0);
const validId = value => Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const validWorld = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Map cache transaction failed.'));
});

export function mapColorRGBA(packed) {
  const value = Number(packed) & 255, color = MAP_COLORS[value >>> 2], brightness = BRIGHTNESS[value & 3];
  if (!color) return [0, 0, 0, 0];
  return [Math.floor((color >>> 16 & 255) * brightness / 255), Math.floor((color >>> 8 & 255) * brightness / 255), Math.floor((color & 255) * brightness / 255), 255];
}

export function mapItemId(slot, registry) {
  if (!slot || slot.present === false) return null;
  const definition = registry?.items instanceof Map ? registry.items.get(slot.itemId) : registry?.items?.find(item => item.id === slot.itemId);
  if (!definition || definition.name.replace(/^minecraft:/, '') !== 'filled_map') return null;
  const component = slot.components?.find(entry => entry.type === 'map_id' || entry.type === 'minecraft:map_id');
  const value = component ? component.data?.id ?? component.data : simplifyNbt(slot.nbtData)?.map;
  return validId(value) ? value : null;
}

function normalizedIcons(value, count) {
  if (!Array.isArray(value) || value.length > 1024) throw new Error('Maps accept at most 1024 decorations.');
  let nameBytes = 0;
  return value.map(icon => {
    if (!icon || !Number.isInteger(icon.type) || ![icon.x, icon.z ?? icon.y, icon.direction ?? icon.rot ?? 0].every(Number.isInteger)) throw new Error('Invalid map decoration.');
    const x = icon.x, y = icon.z ?? icon.y;
    if (x < -128 || x > 127 || y < -128 || y > 127) throw new Error('Map decoration coordinates must be signed bytes.');
    // MapDecoration.Type.byIcon clamps to the selected version's registry.
    const name = textComponent(icon.displayName ?? icon.name).slice(0, 1024); nameBytes += name.length * 2;
    if (nameBytes > 32768) throw new Error('Map decoration labels exceed their byte budget.');
    return { type: Math.max(0, Math.min(count - 1, icon.type)), x, y, rotation: (icon.direction ?? icon.rot ?? 0) & 15, name };
  });
}

function blendPixel(target, offset, source, sourceOffset, opacity = 1) {
  const alpha = source[sourceOffset + 3] / 255 * opacity;
  if (alpha <= 0) return;
  const before = target[offset + 3] / 255, result = alpha + before * (1 - alpha);
  for (let channel = 0; channel < 3; channel++) target[offset + channel] = Math.round((source[sourceOffset + channel] * alpha + target[offset + channel] * before * (1 - alpha)) / result);
  target[offset + 3] = Math.round(result * 255);
}

/** A map's terrain texture is uploaded only after an incoming patch. Icons and
 * labels are baked into held/frame variants so unchanged maps incur no CPU
 * redraw or extra draw calls. The authoritative 128×128 color bytes persist. */
export class MinecraftMaps {
  constructor({ renderer = null, registry = {}, worldKey = 'local', indexedDB = globalThis.indexedDB,
    maxMaps = 64, maxStoredMaps = 256, maxStoredBytes = 8 * 1024 * 1024, onChange = () => {}, onStatus = () => {} } = {}) {
    if (!validWorld(worldKey)) throw new Error('Maps require a bounded stable world identity.');
    if (!Number.isInteger(maxMaps) || maxMaps < 1 || maxMaps > 4096 || !Number.isInteger(maxStoredMaps) || maxStoredMaps < 0 || maxStoredMaps > 4096) throw new Error('Invalid map cache budgets.');
    if (!Number.isInteger(maxStoredBytes) || maxStoredBytes < 0 || maxStoredBytes > 64 * 1024 * 1024) throw new Error('Invalid map cache byte budget.');
    Object.assign(this, { renderer, registry, worldKey, maxMaps, maxStoredMaps, maxStoredBytes, onChange, onStatus });
    this.factory = indexedDB; this.atlas = null; this.maps = new Map(); this.catalog = new Map(); this.queue = Promise.resolve();
    this.clock = Date.now(); this.epoch = 0; this.closed = false; this.database = null; this.textureCache = new Map(); this.freeTiles = [];
    this.itemRegistry = { items: new Map((registry.items || []).map(item => [item.id, item])) };
    this.counters = { updates: 0, uploads: 0, persisted: 0, rejected: 0, evictions: 0, cacheErrors: 0 };
    this.initializing = null; this.catalogLoaded = !indexedDB || maxStoredMaps === 0 || maxStoredBytes === 0;
    this.pendingWrites = new Map(); this.writeScheduled = false;
    this.decorationCount = registry.version?.minecraftVersion === '1.20.4' || !registry.version ? 34 : 35;
  }

  ready() {
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }

  async initialize() {
    if (this.closed || !this.factory || this.maxStoredMaps === 0 || this.maxStoredBytes === 0) return this;
    try {
      const request = this.factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('maps', { keyPath: 'key' }); store.createIndex('worldKey', 'worldKey'); };
      const database = await requestResult(request);
      if (this.closed) { database.close(); return this; }
      this.database = database; database.onversionchange = () => database.close();
      await this.loadCatalog();
    } catch (error) { this.cacheFailure(error); }
    this.catalogLoaded = true;
    for (const entry of this.maps.values()) delete entry.pendingMask;
    for (const record of this.catalog.values()) delete record.pendingMask;
    for (const record of this.pendingWrites.values()) delete record.pendingMask;
    return this;
  }

  cacheFailure(error) {
    this.counters.cacheErrors++; this.database?.close(); this.database = null;
    this.onStatus(`Map cache is memory-only: ${error.message}`);
  }

  async loadCatalog() {
    const epoch = this.epoch, worldKey = this.worldKey;
    if (!this.database) return;
    const transaction = this.database.transaction('maps', 'readonly'), done = transactionDone(transaction);
    const records = await requestResult(transaction.objectStore('maps').getAll()); await done;
    if (epoch !== this.epoch || this.closed) return;
    for (const record of records) {
      if (record.worldKey === worldKey && validId(record.id) && record.colors instanceof Uint8Array && record.colors.length === PIXELS && Array.isArray(record.icons) && record.icons.length <= 1024 && record.icons.every(icon => Number.isInteger(icon.type) && icon.type >= 0 && icon.type < this.decorationCount && Number.isInteger(icon.x) && Number.isInteger(icon.y) && Number.isInteger(icon.rotation) && typeof icon.name === 'string' && icon.name.length <= 1024)) {
        // A packet can arrive while IndexedDB opens. Merge just its changed
        // pixels over the saved texture so a small patch also preserves all
        // previously explored areas that the server has not retransmitted.
        const pending = this.catalog.get(record.id);
        if (pending?.pendingMask) {
          const colors = record.colors.slice(); for (let index = 0; index < PIXELS; index++) if (pending.pendingMask[index]) colors[index] = pending.colors[index];
          pending.colors = colors;
          if (!pending.pendingIcons) pending.icons = record.icons.map(icon => ({ ...icon }));
          if (!pending.pendingScale) pending.scale = record.scale;
          if (!pending.pendingLocked) pending.locked = record.locked;
          const write = this.pendingWrites.get(pending.key); if (write) Object.assign(write, pending);
        } else if (!pending) this.catalog.set(record.id, record);
        const resident = this.maps.get(record.id);
        if (resident && (resident.pendingMask || !resident.known)) {
          const merged = pending || record; resident.colors = merged.colors.slice(); resident.icons = merged.icons.map(icon => ({ ...icon })); resident.scale = merged.scale; resident.locked = merged.locked; resident.known = true; resident.revision++; resident.images.clear(); this.onChange(record.id);
        }
        this.clock = Math.max(this.clock, record.accessedAt || 0);
      }
    }
    this.trimCatalog();
    await this.trimDisk(records);
  }

  enqueue(operation) {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result.catch(error => this.cacheFailure(error)); return result;
  }

  entry(id) {
    let entry = this.maps.get(id);
    if (!entry) {
      const record = this.catalog.get(id);
      entry = { id, scale: record?.scale ?? 0, locked: record?.locked ?? false, colors: record?.colors.slice() ?? new Uint8Array(PIXELS),
        icons: record?.icons?.map(icon => ({ ...icon })) ?? [], known: Boolean(record), revision: 0, accessedAt: ++this.clock, variants: new Map(), images: new Map(),
        ...(!this.catalogLoaded ? { pendingMask: record?.pendingMask?.slice() ?? new Uint8Array(PIXELS), pendingIcons: record?.pendingIcons ?? false, pendingScale: record?.pendingScale ?? false, pendingLocked: record?.pendingLocked ?? false } : {}) };
      this.maps.set(id, entry); this.trimMemory(id);
    }
    entry.accessedAt = ++this.clock; return entry;
  }

  trimMemory(retain) {
    while (this.maps.size > this.maxMaps) {
      const candidate = [...this.maps.values()].filter(entry => entry.id !== retain).sort((a, b) => a.accessedAt - b.accessedAt)[0];
      if (!candidate) break;
      for (const variant of candidate.variants.values()) if (variant.tile !== undefined) this.freeTiles.push(variant.tile);
      this.maps.delete(candidate.id); this.counters.evictions++;
    }
  }

  consume(packet) {
    if (this.closed) return false;
    try {
      const id = packet?.itemDamage ?? packet?.mapId;
      if (!validId(id)) throw new Error('Invalid map ID.');
      const columns = packet.columns ?? 0, rows = columns ? packet.rows : 0, x = columns ? packet.x : 0, y = columns ? packet.y : 0;
      if (![columns, rows, x, y].every(Number.isInteger) || columns < 0 || columns > SIZE || rows < 0 || rows > SIZE || x < 0 || y < 0 || x + columns > SIZE || y + rows > SIZE || (columns && rows === 0)) throw new Error('Invalid map patch rectangle.');
      const data = columns ? packet.data : null;
      if (columns && (!(data instanceof Uint8Array) || data.length !== columns * rows)) throw new Error('Invalid map patch byte length.');
      const icons = packet.icons !== null && packet.icons !== undefined ? normalizedIcons(packet.icons, this.decorationCount) : null;
      if (packet.scale !== undefined && (!Number.isInteger(packet.scale) || packet.scale < 0 || packet.scale > 4)) throw new Error('Map scale must be between 0 and 4.');
      // Validate the entire update before changing resident or persisted state.
      const entry = this.entry(id); entry.scale = packet.scale ?? entry.scale; entry.locked = packet.locked ?? entry.locked;
      if (icons) entry.icons = icons;
      if (entry.pendingMask) { entry.pendingIcons ||= icons !== null; entry.pendingScale ||= packet.scale !== undefined; entry.pendingLocked ||= packet.locked !== undefined; }
      if (columns) for (let row = 0; row < rows; row++) { const offset = (y + row) * SIZE + x; entry.colors.set(data.subarray(row * columns, (row + 1) * columns), offset); entry.pendingMask?.fill(1, offset, offset + columns); }
      entry.known = true; entry.revision++; entry.images.clear(); this.counters.updates++;
      const snapshot = this.snapshot(entry);
      // Keep recent authoritative bytes available even after resident eviction.
      this.catalog.set(id, snapshot); this.trimCatalog();
      // Coalesce rapid map patches instead of retaining one full snapshot per
      // packet while the browser's disk writer is busy.
      this.pendingWrites.set(snapshot.key, snapshot);
      while (this.pendingWrites.size > Math.max(this.maxMaps, this.maxStoredMaps)) this.pendingWrites.delete(this.pendingWrites.keys().next().value);
      if (!this.writeScheduled) {
        this.writeScheduled = true;
        this.enqueue(async () => {
          try {
            await this.ready();
            while (this.pendingWrites.size) {
              const [key, record] = this.pendingWrites.entries().next().value; this.pendingWrites.delete(key);
              if (this.database && this.maxStoredMaps && this.maxStoredBytes) await this.persist(record);
            }
          } finally { this.writeScheduled = false; }
        });
      }
      this.onChange(id); return true;
    } catch (error) { this.counters.rejected++; this.onStatus(error.message); return false; }
  }

  snapshot(entry) {
    return { id: entry.id, worldKey: this.worldKey, key: `${this.worldKey}\0${entry.id}`, scale: entry.scale, locked: entry.locked,
      colors: entry.colors.slice(), icons: entry.icons.map(icon => ({ ...icon })), accessedAt: entry.accessedAt,
      ...(entry.pendingMask ? { pendingMask: entry.pendingMask.slice(), pendingIcons: entry.pendingIcons, pendingScale: entry.pendingScale, pendingLocked: entry.pendingLocked } : {}) };
  }

  trimCatalog() {
    const limit = Math.max(PIXELS * this.maxMaps, this.maxStoredBytes);
    let bytes = [...this.catalog.values()].reduce((sum, entry) => sum + mapBytes(entry), 0);
    while (this.catalog.size > Math.max(this.maxMaps, this.maxStoredMaps) || bytes > limit) {
      const oldest = [...this.catalog.values()].sort((a, b) => a.accessedAt - b.accessedAt)[0]; this.catalog.delete(oldest.id);
      bytes -= mapBytes(oldest);
    }
  }

  async persist(record) {
    const database = this.database; if (!database) return;
    const transaction = database.transaction('maps', 'readwrite'), done = transactionDone(transaction);
    transaction.objectStore('maps').put(record); await done; this.counters.persisted++;
    const read = database.transaction('maps', 'readonly'), readDone = transactionDone(read);
    const records = await requestResult(read.objectStore('maps').getAll()); await readDone; await this.trimDisk(records);
  }

  async trimDisk(records) {
    if (!this.database) return;
    let bytes = records.reduce((sum, record) => sum + (record.colors instanceof Uint8Array && Array.isArray(record.icons) ? mapBytes(record) : this.maxStoredBytes + 1), 0), count = records.length;
    const remove = [];
    for (const record of records.sort((a, b) => (a.accessedAt || 0) - (b.accessedAt || 0))) {
      if (count <= this.maxStoredMaps && bytes <= this.maxStoredBytes) break;
      remove.push(record); count--; bytes -= record.colors instanceof Uint8Array && Array.isArray(record.icons) ? mapBytes(record) : this.maxStoredBytes + 1;
    }
    if (!remove.length) return;
    const transaction = this.database.transaction('maps', 'readwrite'), done = transactionDone(transaction), store = transaction.objectStore('maps');
    for (const record of remove) { store.delete(record.key); if (record.worldKey === this.worldKey && !this.maps.has(record.id)) this.catalog.delete(record.id); }
    await done;
  }

  setAssets(atlas) {
    this.atlas = atlas; this.textureCache.clear(); this.freeTiles.length = 0;
    for (const entry of this.maps.values()) { entry.variants.clear(); entry.images.clear(); }
  }

  texture(id) {
    if (this.textureCache.has(id)) return this.textureCache.get(id);
    const tile = this.atlas?.tiles?.find(tile => tile.id === id);
    if (!tile || !(this.atlas.pixelsRGBA instanceof Uint8Array)) return null;
    const pixels = new Uint8Array(tile.width * tile.height * 4);
    for (let y = 0; y < tile.height; y++) pixels.set(this.atlas.pixelsRGBA.subarray(((tile.y + y) * this.atlas.width + tile.x) * 4, ((tile.y + y) * this.atlas.width + tile.x + tile.width) * 4), y * tile.width * 4);
    const result = { width: tile.width, height: tile.height, pixels }; this.textureCache.set(id, result); return result;
  }

  decorationTexture(type) {
    const descriptor = MAP_DECORATIONS[type], names = this.atlas?.tileByName;
    const tile = names?.get(`minecraft:gui/sprites/map/decorations/${descriptor.name}`);
    if (tile !== undefined) return this.texture(tile);
    const sheet = this.texture(names?.get('minecraft:map/map_icons')); if (!sheet) return null;
    const width = sheet.width / 16, height = sheet.height / 16;
    if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
    const pixels = new Uint8Array(width * height * 4), x = type % 16 * width, y = Math.floor(type / 16) * height;
    for (let row = 0; row < height; row++) pixels.set(sheet.pixels.subarray(((y + row) * sheet.width + x) * 4, ((y + row) * sheet.width + x + width) * 4), row * width * 4);
    return { width, height, pixels };
  }

  drawDecoration(pixels, icon) {
    const sprite = this.decorationTexture(icon.type); if (!sprite) return;
    const angle = icon.rotation * Math.PI / 8, cosine = Math.cos(angle), sine = Math.sin(angle), cx = icon.x / 2 + 64, cy = icon.y / 2 + 64;
    for (let y = Math.max(0, Math.floor(cy - 7)); y < Math.min(SIZE, Math.ceil(cy + 7)); y++) for (let x = Math.max(0, Math.floor(cx - 7)); x < Math.min(SIZE, Math.ceil(cx + 7)); x++) {
      const dx = x + .5 - cx, dy = y + .5 - cy, localX = cosine * dx + sine * dy, localY = -sine * dx + cosine * dy;
      // MapRenderer rotates a scale(4) quad, translated (-.125, .125).
      const u = (localX + 4.5) / 8, v = (4.5 - localY) / 8;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const source = (Math.min(sprite.height - 1, Math.floor(v * sprite.height)) * sprite.width + Math.min(sprite.width - 1, Math.floor(u * sprite.width))) * 4;
      blendPixel(pixels, (y * SIZE + x) * 4, sprite.pixels, source);
    }
  }

  drawLabel(pixels, icon) {
    const glyphs = this.atlas?.fontGlyphs; if (!icon.name || !glyphs) return;
    const characters = Array.from(icon.name), width = characters.reduce((sum, character) => sum + (glyphs.get(character)?.advance ?? glyphs.get('?')?.advance ?? 6), 0);
    if (!width) return;
    const scale = Math.min(25 / width, 2 / 3), left = icon.x / 2 + 64 - width * scale / 2, top = icon.y / 2 + 68;
    const black = new Uint8Array([0, 0, 0, 128]);
    for (let y = Math.max(0, Math.floor(top - scale)); y < Math.min(SIZE, Math.ceil(top + 9 * scale)); y++) for (let x = Math.max(0, Math.floor(left - scale)); x < Math.min(SIZE, Math.ceil(left + (width + 1) * scale)); x++) blendPixel(pixels, (y * SIZE + x) * 4, black, 0);
    let cursor = left;
    for (const character of characters) {
      const glyph = glyphs.get(character) ?? glyphs.get('?');
      const sheet = glyph && this.texture(glyph.tile);
      if (glyph && sheet && glyph.width > 0) {
        const y0 = top + (7 - glyph.ascent) * scale, x1 = cursor + glyph.width * scale, y1 = y0 + glyph.height * scale;
        for (let y = Math.max(0, Math.floor(y0)); y < Math.min(SIZE, Math.ceil(y1)); y++) for (let x = Math.max(0, Math.floor(cursor)); x < Math.min(SIZE, Math.ceil(x1)); x++) {
          const u = (x + .5 - cursor) / (x1 - cursor), v = (y + .5 - y0) / (y1 - y0);
          if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
          const tx = Math.floor((glyph.uv[0] + u * (glyph.uv[2] - glyph.uv[0])) * sheet.width), ty = Math.floor((glyph.uv[1] + v * (glyph.uv[3] - glyph.uv[1])) * sheet.height);
          blendPixel(pixels, (y * SIZE + x) * 4, sheet.pixels, (ty * sheet.width + tx) * 4);
        }
      }
      cursor += (glyph?.advance ?? 6) * scale;
    }
  }

  compose(entry, frame) {
    const pixels = new Uint8Array(PIXELS * 4);
    for (let i = 0; i < PIXELS; i++) pixels.set(mapColorRGBA(entry.colors[i]), i * 4);
    for (const icon of entry.icons) {
      if (frame && !MAP_DECORATIONS[icon.type]?.frame) continue;
      this.drawDecoration(pixels, icon); this.drawLabel(pixels, icon);
    }
    return pixels;
  }

  tileForItem(slot, { frame = false } = {}) {
    const id = mapItemId(slot, this.itemRegistry);
    if (id === null || this.closed || !this.renderer?.appendAtlasTile || !this.renderer?.updateAtlasTile) return null;
    const entry = this.entry(id), key = frame ? 'frame' : 'held';
    let variant = entry.variants.get(key);
    if (!variant || variant.revision !== entry.revision) {
      const pixelsRGBA = this.compose(entry, frame);
      try {
        let tile = variant?.tile ?? this.freeTiles.pop();
        if (tile !== undefined) this.renderer.updateAtlasTile(tile, { pixelsRGBA, width: SIZE, height: SIZE });
        else tile = this.renderer.appendAtlasTile({ pixelsRGBA, width: SIZE, height: SIZE }, { name: `minecraft:map/${id}/${key}` }).id;
        variant = { tile, revision: entry.revision }; entry.variants.set(key, variant); this.counters.uploads++;
      } catch (error) { this.onStatus(error.message); return null; }
    }
    const backgroundTile = this.atlas?.tileByName?.get(`minecraft:map/map_background${entry.known ? '_checkerboard' : ''}`) ?? this.atlas?.tileByName?.get('minecraft:map/map_background');
    return { tile: variant.tile, width: SIZE, height: SIZE, uv: [0, 0, 1, 1], backgroundTile, id, revision: entry.revision, scale: entry.scale, locked: entry.locked };
  }

  imageForItem(slot, { frame = false } = {}) {
    const id = mapItemId(slot, this.itemRegistry);
    if (id === null || !globalThis.document || !this.maps.has(id) && !this.catalog.has(id)) return null;
    const entry = this.entry(id), key = frame ? 'frame' : 'held'; if (entry.images.has(key)) return entry.images.get(key);
    const canvas = document.createElement('canvas'); canvas.width = SIZE; canvas.height = SIZE;
    const context = canvas.getContext('2d'); if (!context) return null;
    context.putImageData(new ImageData(new Uint8ClampedArray(this.compose(entry, frame)), SIZE, SIZE), 0, 0);
    const image = canvas.toDataURL('image/png'); entry.images.set(key, image); return image;
  }

  async setWorldKey(worldKey) {
    if (!validWorld(worldKey)) throw new Error('Maps require a bounded stable world identity.');
    if (worldKey === this.worldKey) return this.ready();
    await this.flush(); this.clear(); this.worldKey = worldKey; this.catalogLoaded = !this.database; await this.ready(); await this.loadCatalog(); this.catalogLoaded = true;
    for (const entry of this.maps.values()) delete entry.pendingMask;
    for (const record of this.catalog.values()) delete record.pendingMask;
    for (const record of this.pendingWrites.values()) delete record.pendingMask;
    return this;
  }

  clear() {
    this.epoch++;
    for (const entry of this.maps.values()) for (const variant of entry.variants.values()) if (variant.tile !== undefined) this.freeTiles.push(variant.tile);
    this.maps.clear(); this.catalog.clear(); this.onChange(null);
  }

  async flush() { await this.ready(); await this.queue; }
  async close() { await this.flush(); this.closed = true; this.clear(); this.database?.close(); this.database = null; }
  stats() {
    const entries = [...this.maps.values(), ...this.catalog.values()];
    const memoryBytes = entries.reduce((sum, entry) => sum + mapBytes(entry), 0) + [...this.textureCache.values()].reduce((sum, texture) => sum + texture.pixels.byteLength, 0) + [...this.pendingWrites.values()].reduce((sum, entry) => sum + mapBytes(entry), 0);
    return { ...this.counters, maps: this.maps.size, cachedMaps: this.catalog.size, memoryBytes,
      gpuMaps: [...this.maps.values()].reduce((sum, entry) => sum + entry.variants.size, 0), freeTiles: this.freeTiles.length, persistent: Boolean(this.database), worldKey: this.worldKey };
  }
}
