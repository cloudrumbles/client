import { gunzipSync, unzlibSync } from '../vendor/fflate.js';
import { decodeNBT } from './nbt.js';
import { structuredBytes } from '../authority/limits.js';
export { storeSourceWorldItems, restoreSourceWorldItems } from './source-world-items-store.js';
const CHUNK_BYTES = 16 * 1024 * 1024, SOURCE_BYTES = 8 * 1024 * 1024;
const child = (tag, key) => tag?.type === 10 ? tag.value[key] : undefined;

/** Modern entity regions share terrain basenames; folder identity or an explicit
 * File list separates them. Bare region selections continue importing terrain. */
export function classifySourceRegionFiles(files, { entityRegions = [] } = {}) {
  const explicit = new Set(entityRegions), terrain = [], entities = [];
  for (const file of files) if (/\.mca$/i.test(file.name)) {
    // A whole-world folder contains other dimensions with the same basenames.
    // Admit only the selected root's region/entities pair. Selecting a dimension
    // folder itself still admits its own pair; bare file selections stay valid.
    const relative = (file.webkitRelativePath ?? '').replaceAll('\\', '/'), selected = relative.split('/').slice(1).join('/');
    if (!explicit.has(file) && selected.includes('/') && !/^(?:region|entities)\/[^/]+$/i.test(selected)) continue;
    (explicit.has(file) || /(?:^|\/)entities\//i.test(relative) || /^entities\//i.test(relative) ? entities : terrain).push(file);
  }
  for (const file of explicit) if (!entities.includes(file)) entities.push(file);
  return { terrainRegions: terrain, entityRegions: entities };
}
export function unavailableSourceWorldItems(error, { version, dataVersion } = {}) {
  return { format: 'java-source-world-items-v1', version, dataVersion, records: [], unavailable: { reason: String(error?.message ?? error ?? 'Source ground items could not be read.').slice(0, 512) } };
}

/** Capture only typed native Entities lists while skipping terrain arrays. The
 * parser retains numeric/list/array types needed by native save codecs. */
export function readSourceWorldItemChunk(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > CHUNK_BYTES) throw new Error('Source entity chunk exceeds its byte limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), utf8 = new TextDecoder('utf-8', { fatal: true });
  let offset = 0, nodes = 0, captured = 0, dataVersion, position; const records = [];
  const need = size => { if (size < 0 || offset + size > bytes.length) throw new Error('Truncated source entity NBT.'); };
  const u8 = () => { need(1); return view.getUint8(offset++); };
  const i32 = () => { need(4); const value = view.getInt32(offset); offset += 4; return value; };
  const count = width => { const size = i32(); if (size < 0 || size > 1_000_000 - nodes) throw new Error('Source entity NBT exceeds its element limit.'); need(size * width); return size; };
  const charge = size => { captured += size; if (captured > SOURCE_BYTES) throw new Error('Source entity records exceed their memory limit.'); };
  const string = () => {
    need(2); const start = offset, size = view.getUint16(offset); offset += 2; need(size); const encoded = bytes.subarray(offset, offset + size); offset += size;
    try { return utf8.decode(encoded); } catch { const tag = new Uint8Array(size + 3); tag[0] = 8; tag.set(bytes.subarray(start, offset), 1); return decodeNBT(tag, { named: false, maxBytes: CHUNK_BYTES }).value; }
  };
  function value(type, path, capture, depth = 0) {
    if (++nodes > 1_000_000 || depth > 64 || type < 1 || type > 12) throw new Error('Invalid or oversized source entity NBT.');
    if (capture) charge(32); let result;
    if (type <= 6) {
      const width = [0, 1, 2, 4, 8, 4, 8][type]; need(width);
      result = type === 1 ? view.getInt8(offset) : type === 2 ? view.getInt16(offset) : type === 3 ? view.getInt32(offset) : type === 4 ? view.getBigInt64(offset) : type === 5 ? view.getFloat32(offset) : view.getFloat64(offset); offset += width;
    } else if (type === 8) { result = string(); if (capture) charge(result.length * 2); }
    else if ([7, 11, 12].includes(type)) {
      const width = type === 7 ? 1 : type === 11 ? 4 : 8, size = count(width); nodes += size;
      if (capture) {
        charge(size * width); result = type === 7 ? bytes.slice(offset, offset + size) : type === 11 ? new Int32Array(size) : new BigInt64Array(size);
        if (type !== 7) for (let index = 0; index < size; index++) result[index] = type === 11 ? view.getInt32(offset + index * width) : view.getBigInt64(offset + index * width);
      }
      offset += size * width;
    } else if (type === 9) {
      const elementType = u8(), size = count(0); if (elementType > 12 || elementType === 0 && size) throw new Error('Invalid source entity list type.');
      result = capture ? { elementType, entries: [] } : undefined;
      for (let index = 0; index < size; index++) { const tag = value(elementType, `${path}[]`, capture, depth + 1); if (capture) result.entries.push(tag); }
    } else {
      result = capture ? Object.create(null) : undefined; const keys = new Set();
      while (true) {
        const kind = u8(); if (kind === 0) break; const key = string(); if (keys.has(key)) throw new Error('Duplicate source entity NBT key.'); keys.add(key); if (capture) charge(key.length * 2);
        const next = path ? `${path}.${key}` : key, selected = ['Entities', 'entities', 'Level.Entities', 'Level.entities', 'Position'].includes(next);
        const tag = value(kind, next, capture || selected, depth + 1); if (capture) result[key] = tag;
        if (next === 'DataVersion' || next === 'Level.DataVersion') dataVersion = tag?.value;
        if (next === 'Position') position = tag;
        if (/^(?:Level\.)?[Ee]ntities$/.test(next)) {
          if (tag.type !== 9 || tag.value.elementType !== 10 && tag.value.entries.length) throw new Error('Source Entities requires a compound list.');
          for (const entity of tag.value.entries) if (['minecraft:item', 'item'].includes(child(entity, 'id')?.value)) records.push(entity);
        }
      }
    }
    return capture || type <= 6 || type === 8 ? { type, value: result } : undefined;
  }
  if (u8() !== 10) throw new Error('Source entity NBT requires a root compound.'); string(); value(10, '', false);
  if (offset !== bytes.length) throw new Error('Trailing source entity NBT bytes.');
  if (records.length > 1024) throw new Error('Source items exceed their actor limit.');
  return { records, dataVersion, position };
}

/** Read actual terrain/modern entity region files without writing their source.
 * Unsupported compression/external chunks reject instead of implying no items. */
export async function readSourceWorldItems(files, { version, dataVersion, isCurrent = () => true } = {}) {
  const regions = [...files].filter(file => /\.mca$/i.test(file.name));
  if (regions.length > 64 || regions.reduce((sum, file) => sum + (file.size ?? file.byteLength ?? 0), 0) > 256 * 1024 * 1024) throw new Error('Source item regions exceed their import limit.');
  const source = { format: 'java-source-world-items-v1', version, dataVersion, records: [] }, versions = new Set();
  for (const file of regions) {
    if (!isCurrent()) return null;
    const name = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(file.name); if (!name) throw new Error('Source item regions require original r.x.z.mca filenames.');
    if ((file.size ?? file.byteLength ?? 0) > 128 * 1024 * 1024) throw new Error('Source item region exceeds its file limit.');
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer()); if (!isCurrent()) return null;
    if (bytes.length < 8192 || bytes.length % 4096 || bytes.length > 128 * 1024 * 1024) throw new Error('Invalid source item region sector length.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), claimed = new Set([0, 1]);
    for (let slot = 0; slot < 1024; slot++) {
      const location = view.getUint32(slot * 4), sector = location >>> 8, size = location & 255; if (!sector && !size) continue;
      if (sector < 2 || !size || (sector + size) * 4096 > bytes.length) throw new Error('Source item chunk points outside its sectors.');
      for (let next = sector; next < sector + size; next++) { if (claimed.has(next)) throw new Error('Source item chunks overlap sectors.'); claimed.add(next); }
      const start = sector * 4096, length = view.getUint32(start), compression = bytes[start + 4];
      if (length < 1 || length > size * 4096 - 4) throw new Error('Invalid source item chunk length.');
      if (compression & 128) throw new Error('Source item external .mcc chunks require their native source files.');
      const packed = bytes.subarray(start + 5, start + 4 + length); let inflated;
      if (compression === 1) {
        if (packed.length < 18 || new DataView(packed.buffer, packed.byteOffset + packed.length - 4, 4).getUint32(0, true) > CHUNK_BYTES) throw new Error('Source item gzip chunk exceeds its size limit.');
        inflated = gunzipSync(packed, { out: new Uint8Array(CHUNK_BYTES + 1) });
      } else if (compression === 2) inflated = unzlibSync(packed, { out: new Uint8Array(CHUNK_BYTES + 1) });
      else if (compression === 3) inflated = packed;
      else throw new Error(`Unsupported source item compression ${compression}.`);
      const chunk = readSourceWorldItemChunk(inflated);
      if (chunk.position && (chunk.position.type !== 11 || chunk.position.value.length !== 2 || chunk.position.value[0] !== Number(name[1]) * 32 + slot % 32 || chunk.position.value[1] !== Number(name[2]) * 32 + Math.floor(slot / 32))) throw new Error('Source entity chunk coordinates disagree with its region slot.');
      if (chunk.dataVersion !== undefined) versions.add(chunk.dataVersion);
      source.records.push(...chunk.records); if (source.records.length > 1024) throw new Error('Source items exceed their actor limit.'); structuredBytes(source, SOURCE_BYTES);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (!isCurrent()) return null;
  if (versions.size === 1) source.dataVersion = [...versions][0];
  else if (versions.size > 1) { source.dataVersions = [...versions]; source.dataVersion = -1; }
  return source;
}
