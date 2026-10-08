import { decompressSync } from '../vendor/fflate.js';
import { decodeNBT } from './nbt.js';
import { structuredBytes } from '../authority/limits.js';
export { storeSourceLevelInventory, restoreSourceLevelInventory } from './source-inventory-store.js';
const LEVEL_BYTES = 16 * 1024 * 1024, SOURCE_BYTES = 4 * 1024 * 1024;
const typeNames = ['', 'byte', 'short', 'int', 'long', 'float', 'double', 'byteArray', 'string', 'list', 'compound', 'intArray', 'longArray'];
const numeric = tag => tag && tag.type >= 1 && tag.type <= 6;
function nativeInt(tag, fallback = 0, legacyFloats = false) {
  if (!numeric(tag)) return fallback;
  if (typeof tag.value === 'bigint') return Number(BigInt.asIntN(32, tag.value));
  if (Number.isNaN(tag.value)) return 0;
  const value = tag.type === 5 ? Math.fround(tag.value) : tag.value;
  const narrowed = Math.max(-2147483648, Math.min(2147483647, Math.trunc(value))) | 0;
  // Legacy NumericTag getters use Mth.floor for float/double, including its
  // Java int overflow after subtracting one below Integer.MIN_VALUE. Modern
  // NbtOps codecs use Number.intValue/byteValue and truncate instead.
  return legacyFloats && tag.type >= 5 && value < narrowed ? narrowed - 1 | 0 : narrowed;
}
const nativeByte = (tag, legacyFloats = false) => nativeInt(tag, 0, legacyFloats) << 24 >> 24;
const child = (tag, key) => tag?.type === 10 ? tag.value[key] : undefined;
const resource = value => typeof value === 'string' && /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(value) ? value.includes(':') ? value : `minecraft:${value}` : null;

/** Read only the typed Data.Player subtree; retain all save-codec tag types. */
function sourcePlayerNbt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), utf8 = new TextDecoder('utf-8', { fatal: true });
  let offset = 0, nodes = 0, capturedBytes = 0, player, dataVersion, version;
  const need = length => { if (length < 0 || offset + length > bytes.length) throw new Error('Truncated source inventory NBT.'); };
  const u8 = () => { need(1); return view.getUint8(offset++); };
  const i32 = () => { need(4); const value = view.getInt32(offset); offset += 4; return value; };
  const count = width => { const value = i32(); if (value < 0 || value > 1_000_000 - nodes) throw new Error('Source inventory NBT exceeds its element limit.'); need(value * width); return value; };
  const string = () => {
    need(2); const start = offset, size = view.getUint16(offset); offset += 2; need(size);
    const encoded = bytes.subarray(offset, offset + size); offset += size;
    try { return utf8.decode(encoded); } catch {
      // Reuse the existing Java modified-UTF decoder for unusual tag strings.
      const standalone = new Uint8Array(1 + 2 + size); standalone[0] = 8; standalone.set(bytes.subarray(start, offset), 1);
      return decodeNBT(standalone, { named: false, maxBytes: LEVEL_BYTES }).value;
    }
  };
  const charge = size => { capturedBytes += size; if (capturedBytes > SOURCE_BYTES) throw new Error('Source player inventory exceeds its memory limit.'); };
  function value(type, path, capture, depth = 0) {
    if (++nodes > 1_000_000 || depth > 64 || type < 1 || type > 12) throw new Error('Invalid or oversized source inventory NBT.');
    if (capture) charge(32);
    let result;
    if (type >= 1 && type <= 6) {
      const width = [0, 1, 2, 4, 8, 4, 8][type]; need(width);
      result = type === 1 ? view.getInt8(offset) : type === 2 ? view.getInt16(offset) : type === 3 ? view.getInt32(offset) : type === 4 ? view.getBigInt64(offset) : type === 5 ? view.getFloat32(offset) : view.getFloat64(offset); offset += width;
    } else if (type === 8) { result = string(); if (capture) charge(result.length * 2); }
    else if ([7, 11, 12].includes(type)) {
      const width = type === 7 ? 1 : type === 11 ? 4 : 8, size = count(width); nodes += size;
      if (capture) {
        charge(size * width); result = type === 7 ? bytes.slice(offset, offset + size) : type === 11 ? new Int32Array(size) : new BigInt64Array(size);
        if (type !== 7) for (let i = 0; i < size; i++) result[i] = type === 11 ? view.getInt32(offset + i * width) : view.getBigInt64(offset + i * width);
      }
      offset += size * width;
    } else if (type === 9) {
      const elementType = u8(), size = count(0); if (elementType > 12 || elementType === 0 && size !== 0) throw new Error('Invalid source inventory list type.');
      result = capture ? { elementType, entries: [] } : undefined;
      for (let i = 0; i < size; i++) { const entry = value(elementType, `${path}[]`, capture, depth + 1); if (capture) result.entries.push(entry); }
    } else if (type === 10) {
      result = capture ? Object.create(null) : undefined; const seen = new Set();
      while (true) {
        const next = u8(); if (next === 0) break;
        const key = string(); if (seen.has(key)) throw new Error('Duplicate source inventory NBT key.'); seen.add(key);
        if (capture) charge(key.length * 2);
        const nextPath = path ? `${path}.${key}` : key, selected = nextPath === 'Data.Player';
        const tag = value(next, nextPath, capture || selected, depth + 1);
        if (capture) result[key] = tag;
        if (selected) player = tag;
        if (nextPath === 'Data.DataVersion') dataVersion = tag?.value;
        if (nextPath === 'Data.Version.Name') version = tag?.value;
      }
    }
    // Scalar metadata is retained even outside the captured subtree.
    return capture || type <= 6 || type === 8 ? { type, value: result } : undefined;
  }
  const rootType = u8(); if (rootType !== 10) throw new Error('Source level.dat requires a root compound.'); string(); value(rootType, '', false);
  if (offset !== bytes.length) throw new Error('Trailing source inventory NBT bytes.');
  if (player && player.type !== 10) throw new Error('Source Player requires a compound.');
  const source = { format: 'java-player-inventory-v1', dataVersion, version, present: !!player, player: player ?? null };
  structuredBytes(source, SOURCE_BYTES); return source;
}

/** Preserve the source save representation; this is not a protocol slot decoder. */
export async function readSourceLevelInventory(input, { raw = false } = {}) {
  const packed = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  if (packed.byteLength > LEVEL_BYTES) throw new Error('Source level.dat exceeds its file limit.');
  const bytes = raw ? packed : decompressSync(packed, { out: new Uint8Array(LEVEL_BYTES + 1) });
  if (bytes.byteLength > LEVEL_BYTES) throw new Error('Source level.dat exceeds its decompression limit.');
  return sourcePlayerNbt(bytes);
}

// An explicit legacy NBT conversion retains each numeric/list/array tag type.
// Modern component save codecs need their own conversions; raw values are never
// blindly assigned to protocol component data.
function legacyNbt(tag) {
  if (tag.type === 10) return { type: 'compound', value: Object.fromEntries(Object.entries(tag.value).map(([name, value]) => [name, legacyNbt(value)])) };
  if (tag.type === 9) return { type: 'list', value: { type: typeNames[tag.value.elementType], value: tag.value.entries.map(entry => legacyNbt(entry).value) } };
  return { type: typeNames[tag.type], value: structuredClone(tag.value) };
}

/** A parse failure is different from a source with no player inventory. Keep a
 * bounded blocking marker through resume, so it cannot silently seed/save a
 * replacement starter inventory. The original file remains untouched. */
export function unavailableSourceLevelInventory(error, { version, dataVersion } = {}) {
  return { format: 'java-player-inventory-v1', version, dataVersion, present: true, player: null,
    unavailable: { reason: String(error?.message ?? error ?? 'Source player inventory could not be read.').slice(0, 512) } };
}

/** Prepare an all-or-nothing first-open plan; no worker/storage mutation occurs. */
export function planSourceInventoryBootstrap(source, { registry, componentDecoders = new Map() }) {
  if (source?.format !== 'java-player-inventory-v1') throw new Error('Invalid source player inventory descriptor.');
  structuredBytes(source, SOURCE_BYTES);
  const version = registry?.version?.minecraftVersion, legacy = version === '1.20.4';
  if (!['1.20.4', '1.21.11'].includes(version)) throw new Error('Source inventory requires a supported native registry.');
  const diagnostics = [], deferred = [], player = Array.from({ length: 41 }, () => ({ present: false }));
  if (source.unavailable) {
    if (source.player !== null || source.present !== true || typeof source.unavailable.reason !== 'string' || source.unavailable.reason.length > 512) throw new Error('Invalid deferred source inventory marker.');
    return { present: true, ready: false, version, selected: 0, player, diagnostics, deferred: [{ reason: source.unavailable.reason }], source: structuredClone(source) };
  }
  const selected = nativeInt(child(source.player, 'SelectedItemSlot'), 0, legacy);
  const compatible = source.dataVersion === registry.version.dataVersion || source.dataVersion === undefined && source.version === version;
  if (!compatible) deferred.push({ reason: 'Source data version needs native data fixing before this registry can load it.' });
  if (selected < 0 || selected > 8) deferred.push({ reason: 'Source selected hotbar is outside native bounds.' });
  const items = new Map(registry.items.map(item => [`minecraft:${item.name}`, item]));
  function decodeStack(record, context) {
    if (record?.type !== 10) { diagnostics.push({ context, reason: 'Native item record is not a compound.' }); return null; }
    const id = child(record, 'id'), item = id?.type === 8 ? items.get(resource(id.value)) : undefined;
    if (!item) { diagnostics.push({ context, reason: 'Native item ID is missing, invalid or unavailable.' }); return null; }
    let count = legacy ? nativeByte(child(record, 'Count'), true) : nativeInt(child(record, 'count'), 1);
    if (!legacy && (count < 1 || count > 99)) count = 1; // ItemStack count codec .orElse(1).
    if (item.name === 'air' || count <= 0) return legacy ? null : { present: false };
    if (count > 99) { deferred.push({ context, reason: 'Source stack count exceeds the portable authority bound.', record }); return null; }
    const stack = { present: true, itemId: item.id, itemCount: count };
    if (legacy) {
      let tag = child(record, 'tag')?.type === 10 ? structuredClone(child(record, 'tag')) : null;
      if (tag && item.name === 'player_head') deferred.push({ context, reason: 'Native PlayerHeadItem.verifyTagAfterLoad requires its own source conversion.', record });
      if (item.maxDurability) {
        tag ??= { type: 10, value: Object.create(null) };
        tag.value.Damage = { type: 3, value: Math.max(0, nativeInt(child(tag, 'Damage'), 0, true)) };
      }
      if (tag) stack.nbtData = legacyNbt(tag); return stack;
    }
    const patch = child(record, 'components');
    if (patch === undefined) return stack;
    if (patch.type !== 10) { deferred.push({ context, reason: 'Native component patch is not a compound.', record }); return null; }
    const seen = new Set(), components = [], removed = [];
    for (const [key, value] of Object.entries(patch.value)) {
      const removal = key.startsWith('!'), type = resource(removal ? key.slice(1) : key);
      if (!type || seen.has(type)) { deferred.push({ context, reason: 'Ambiguous or invalid native component patch identifier.', record }); continue; } seen.add(type);
      if (type === 'minecraft:max_stack_size') {
        if (removal) {
          if (value.type !== 10 || Object.keys(value.value).length) deferred.push({ context, reason: 'Native removal must encode a unit/empty compound.', record });
          else removed.push(type);
        } else {
          const limit = nativeInt(value, 0);
          if (!numeric(value) || limit < 1 || limit > 99) deferred.push({ context, reason: 'Invalid native maximum stack size component.', record });
          else components.push({ type, data: limit });
        }
      } else {
        const decoder = componentDecoders.get(type);
        if (!decoder) { deferred.push({ context, reason: `Missing explicit source codec conversion for ${type}.`, component: { type, removal, value: structuredClone(value) }, record }); continue; }
        if (removal) {
          if (value.type !== 10 || Object.keys(value.value).length) deferred.push({ context, reason: 'Native removal must encode a unit/empty compound.', record });
          else removed.push(type);
        } else components.push({ type, data: decoder(structuredClone(value), { registry }) });
      }
    }
    if (components.length) stack.components = components; if (removed.length) stack.removeComponents = removed; return stack;
  }
  const inventory = child(source.player, 'Inventory');
  if (inventory?.type === 9) {
    if (inventory.value.entries.length > 4096) throw new Error('Source inventory list exceeds its record bound.');
    for (const [ordinal, record] of inventory.value.entries.entries()) {
      const slot = nativeByte(child(record, 'Slot'), legacy) & 255;
      const index = slot < 36 ? slot : legacy && slot >= 100 && slot <= 103 ? slot - 64 : legacy && slot === 150 ? 40 : -1;
      if (index < 0) continue;
      const stack = decodeStack(record, `Inventory[${ordinal}]`); if (stack) player[index] = stack;
    }
  } else if (inventory !== undefined) diagnostics.push({ reason: 'Native Inventory tag is not a list and loads as empty.' });
  if (!legacy) {
    const equipment = child(source.player, 'equipment');
    if (equipment?.type === 10) for (const [slot, record] of Object.entries(equipment.value)) {
      const index = { feet: 36, legs: 37, chest: 38, head: 39, offhand: 40 }[slot];
      if (index === undefined) {
        if (slot === 'mainhand') continue; // PlayerEquipment.get redirects to selected inventory.
        if (['body', 'saddle'].includes(slot)) deferred.push({ context: `equipment.${slot}`, reason: 'Native equipment index exceeds retained portable player slots.', record });
        else diagnostics.push({ context: `equipment.${slot}`, reason: 'Unknown native equipment slot.' });
        continue;
      }
      const stack = decodeStack(record, `equipment.${slot}`); if (stack) player[index] = stack;
    }
  }
  const result = { present: source.present, ready: source.present && compatible && deferred.length === 0, version, selected, player, diagnostics, deferred, source: structuredClone(source) };
  structuredBytes(result, SOURCE_BYTES); return result;
}
