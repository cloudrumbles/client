import { decompressSync, unzlibSync, gunzipSync } from '../vendor/fflate.js';
import { decodeNBT } from './nbt.js';

const NS = name => name.includes(':') ? name : `minecraft:${name}`;
const keyFor = (name, properties) => `${NS(name)}[${Object.entries(properties ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(',')}]`;

/** Decode native state IDs using minecraft-data's mixed-radix state definitions. */
export function registryStates(registry) {
  const byKey = new Map(), byId = new Map();
  const blocks = Array.isArray(registry) ? registry : (registry?.blocks ?? []);
  for (const block of blocks) {
    const min = block.minStateId ?? block.minStateID ?? block.id;
    const max = block.maxStateId ?? block.maxStateID ?? min;
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 65535) throw new Error('Invalid native block state range');
    for (let id = min; id <= max; id++) {
      let remainder = id - min;
      const properties = Object.create(null);
      for (let i = (block.states?.length ?? 0) - 1; i >= 0; i--) {
        const state = block.states[i];
        const values = state.values ?? (state.type === 'bool' ? ['true', 'false'] : Array.from({ length: state.num_values }, (_, n) => `${n}`));
        if (!values.length) throw new Error('Invalid registry state values');
        properties[state.name] = `${values[remainder % values.length]}`;
        remainder = Math.floor(remainder / values.length);
      }
      const entry = { id, name: NS(block.name), properties, block };
      byId.set(id, entry); byKey.set(keyFor(entry.name, properties), id);
    }
  }
  return { byId, byKey, collisionShapes: registry?.collisionShapes ?? registry?.blockCollisionShapes, lookup(name, properties) { return byKey.get(keyFor(name, properties)); } };
}

async function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input?.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  throw new TypeError('Expected region bytes or a local File');
}

/** Modern Anvil's padded packed-long array: each long holds floor(64 / bits) entries. */
export function decodeSectionStates(blockStates, stateRegistry, diagnostics = { unknownStates: [] }) {
  const palette = blockStates?.palette;
  if (!Array.isArray(palette) || !palette.length || palette.length > 4096) throw new Error('Invalid section block state palette');
  const paletteNames = palette.map(entry => keyFor(entry.Name ?? entry.name ?? 'minecraft:air', entry.Properties));
  const native = palette.map((entry, i) => {
    const id = stateRegistry.lookup(entry.Name ?? entry.name ?? 'minecraft:air', entry.Properties);
    if (id !== undefined) return id;
    if (!diagnostics.unknownStates.includes(paletteNames[i])) diagnostics.unknownStates.push(paletteNames[i]);
    return stateRegistry.lookup('minecraft:barrier', {}) ?? 1;
  });
  const states = new Uint16Array(4096);
  if (palette.length === 1) { states.fill(native[0]); return { states, paletteNames }; }
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length))), perLong = Math.floor(64 / bits);
  const data = blockStates.data;
  if (!(data instanceof BigInt64Array) && !Array.isArray(data)) throw new Error('Missing section packed block states');
  if (data.length !== Math.ceil(4096 / perLong)) throw new Error('Invalid modern section packed-long length');
  const mask = (1n << BigInt(bits)) - 1n;
  for (let index = 0; index < states.length; index++) {
    const long = BigInt.asUintN(64, data[Math.floor(index / perLong)]);
    const paletteIndex = Number((long >> BigInt((index % perLong) * bits)) & mask);
    if (paletteIndex >= native.length) throw new Error('Section state index exceeds its palette');
    states[index] = native[paletteIndex];
  }
  return { states, paletteNames };
}

/** Read an actual Java .mca region. Unsupported chunks are reported, never silently accepted. */
export async function importAnvil(input, { regionX = 0, regionZ = 0, registry, onSection, maxChunks = 1024, maxChunkBytes = 16 * 1024 * 1024, maxRegionBytes = 128 * 1024 * 1024 } = {}) {
  if (input?.size > maxRegionBytes) throw new Error('Anvil region exceeds the file size limit');
  const bytes = await asBytes(input);
  if (bytes.length > maxRegionBytes) throw new Error('Anvil region exceeds the file size limit');
  if (bytes.length < 8192 || bytes.length % 4096 !== 0) throw new Error('Invalid Anvil region sector length');
  if (!Number.isInteger(regionX) || !Number.isInteger(regionZ)) throw new Error('Region coordinates must be integers');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stateRegistry = registry?.lookup ? registry : registryStates(registry);
  if (!stateRegistry.byId.size) throw new Error('A native Minecraft block state registry is required');
  const diagnostics = { unknownStates: [], skippedChunks: [], dataVersions: [], externalChunks: 0 };
  const sections = [], claimed = new Set([0, 1]);
  let chunks = 0;
  for (let slot = 0; slot < 1024; slot++) {
    const location = view.getUint32(slot * 4), sector = location >>> 8, count = location & 255;
    if (!sector && !count) continue;
    if (chunks >= maxChunks) throw new Error('Region exceeds the configured chunk limit');
    if (sector < 2 || count === 0 || (sector + count) * 4096 > bytes.length) throw new Error('Region chunk points outside its sectors');
    for (let s = sector; s < sector + count; s++) {
      if (claimed.has(s)) throw new Error('Region chunks overlap allocated sectors');
      claimed.add(s);
    }
    const start = sector * 4096, length = view.getUint32(start);
    if (length < 1 || length > count * 4096 - 4) throw new Error('Invalid region chunk length');
    const compression = bytes[start + 4];
    if (compression & 128) {
      diagnostics.externalChunks++;
      diagnostics.skippedChunks.push({ slot, reason: 'External .mcc chunk is not included in this region file' });
      continue;
    }
    const compressed = bytes.subarray(start + 5, start + 4 + length);
    let inflated;
    // Check the declared zlib ISIZE only when possible; the bounded NBT parser also protects allocations.
    if (compression === 1) {
      if (compressed.length < 18) throw new Error('Truncated gzip chunk');
      const gzipSize = new DataView(compressed.buffer, compressed.byteOffset + compressed.length - 4, 4).getUint32(0, true);
      if (gzipSize > maxChunkBytes) throw new Error('Chunk decompression exceeds the size limit');
      inflated = gunzipSync(compressed);
    } else if (compression === 2) inflated = unzlibSync(compressed, { out: new Uint8Array(maxChunkBytes + 1) });
    else if (compression === 3) inflated = compressed;
    else { diagnostics.skippedChunks.push({ slot, reason: `Unsupported Anvil compression type ${compression}` }); continue; }
    if (inflated.length > maxChunkBytes) throw new Error('Chunk decompression exceeds the size limit');
    const root = decodeNBT(inflated, { maxBytes: maxChunkBytes }).value;
    const chunk = root.Level ?? root;
    const version = root.DataVersion ?? chunk.DataVersion;
    if (version !== undefined && !diagnostics.dataVersions.includes(version)) diagnostics.dataVersions.push(version);
    if (version !== undefined && version < 2529) {
      diagnostics.skippedChunks.push({ slot, reason: 'Only modern 1.16+ padded blockstate arrays are supported' }); continue;
    }
    const expectedX = regionX * 32 + slot % 32, expectedZ = regionZ * 32 + Math.floor(slot / 32);
    const cx = chunk.xPos ?? expectedX, cz = chunk.zPos ?? expectedZ;
    if (cx !== expectedX || cz !== expectedZ) throw new Error('Chunk coordinates disagree with the region slot');
    const sectionList = chunk.sections ?? chunk.Sections;
    if (!Array.isArray(sectionList) || sectionList.length > 64) throw new Error('Invalid chunk section list');
    const seenY = new Set();
    for (const section of sectionList) {
      const sy = section.Y;
      if (!Number.isInteger(sy) || seenY.has(sy)) throw new Error('Invalid or duplicate section Y');
      seenY.add(sy);
      if (sy < -4 || sy > 19) { diagnostics.skippedChunks.push({ slot, reason: `Section Y ${sy} is outside supported -64..319 build height` }); continue; }
      const blockStates = section.block_states ?? (section.Palette ? { palette: section.Palette, data: section.BlockStates } : null);
      if (!blockStates) continue;
      const skyLight = section.SkyLight, blockLight = section.BlockLight;
      if (skyLight !== undefined && (!(skyLight instanceof Uint8Array) || skyLight.length !== 2048)) throw new Error('Invalid section SkyLight nibble array');
      if (blockLight !== undefined && (!(blockLight instanceof Uint8Array) || blockLight.length !== 2048)) throw new Error('Invalid section BlockLight nibble array');
      const decoded = { cx, sy, cz, ...decodeSectionStates(blockStates, stateRegistry, diagnostics), skyLight, blockLight };
      if (onSection) await onSection(decoded);
      else sections.push(decoded);
    }
    chunks++;
  }
  return { sections, chunks, diagnostics };
}

export async function importLevelDat(input, { onSpawn } = {}) {
  const compressed = await asBytes(input);
  if (compressed.length > 16 * 1024 * 1024) throw new Error('level.dat exceeds the size limit');
  const bytes = decompressSync(compressed, { out: new Uint8Array(16 * 1024 * 1024 + 1) });
  if (bytes.length > 16 * 1024 * 1024) throw new Error('level.dat decompression exceeds the size limit');
  const data = decodeNBT(bytes, { maxBytes: 16 * 1024 * 1024 }).value.Data;
  if (!data) throw new Error('level.dat is missing its Data compound');
  const spawn = [data.SpawnX, data.SpawnY, data.SpawnZ];
  if (!spawn.every(Number.isInteger)) throw new Error('level.dat has invalid spawn coordinates');
  if (onSpawn) await onSpawn(spawn);
  return { spawn, name: data.LevelName ?? '', version: data.Version?.Name ?? '', dataVersion: data.DataVersion, seed: data.WorldGenSettings?.seed ?? data.RandomSeed, time: data.Time, dayTime: data.DayTime };
}
