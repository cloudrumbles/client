// Mechanical native-shaped item/entity-region NBT. No original game assets.
import { zlibSync } from '../../vendor/fflate.js';
const encode = new TextEncoder(), concat = parts => { const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes; };
const integer = (size, value) => { const bytes = new Uint8Array(size), view = new DataView(bytes.buffer); if (size === 1) view.setInt8(0, value); else if (size === 2) view.setInt16(0, value); else if (size === 4) view.setInt32(0, value); else view.setBigInt64(0, value); return bytes; };
const string = text => { const bytes = encode.encode(text); return concat([integer(2, bytes.length), bytes]); };
function payload(type, value) {
  if (type <= 4) return integer([0, 1, 2, 4, 8][type], value);
  if (type === 5 || type === 6) { const bytes = new Uint8Array(type === 5 ? 4 : 8), view = new DataView(bytes.buffer); if (type === 5) view.setFloat32(0, value); else view.setFloat64(0, value); return bytes; }
  if (type === 7) return concat([integer(4, value.length), new Uint8Array(value)]);
  if (type === 8) return string(value);
  if (type === 9) return concat([integer(1, value.type), integer(4, value.entries.length), ...value.entries.map(entry => payload(value.type, entry))]);
  if (type === 10) return concat([...Object.entries(value).map(([name, [kind, child]]) => concat([integer(1, kind), string(name), payload(kind, child)])), integer(1, 0)]);
  if (type === 11 || type === 12) return concat([integer(4, value.length), ...value.map(entry => integer(type === 11 ? 4 : 8, entry))]);
  throw new Error('Unsupported mechanical source item tag.');
}
export const encodeSourceItemNbt = compound => concat([integer(1, 10), string(''), payload(10, compound)]);
export const SOURCE_PLAYER_UUID_WORDS = [0x12345678, 0x12345678, 0x12345678, 0x12345678];
export function sourceItemRecord(version, { ordinal = 1, count = 7, owner = SOURCE_PLAYER_UUID_WORDS, delay = 0, position = [8.5, 70, 8.5], extra = {}, item = {} } = {}) {
  return { id: [8, 'minecraft:item'], UUID: [11, [0, 0, 0, ordinal]], Pos: [9, { type: 6, entries: position }], Motion: [9, { type: 6, entries: [0, 0, 0] }],
    Age: [2, 12], PickupDelay: [2, delay], Health: [2, 5], NoGravity: [1, 0], OnGround: [1, 1], ...(owner ? { Owner: [11, owner] } : {}),
    Item: [10, { id: [8, 'minecraft:oak_planks'], [version === '1.20.4' ? 'Count' : 'count']: [version === '1.20.4' ? 1 : 3, count], ...item }], ...extra };
}
export function sourceItemsRegion(version, records = [sourceItemRecord(version)], { compressed = true, position = [0, 0], terrain = false } = {}) {
  const chunk = encodeSourceItemNbt(terrain ? { DataVersion: [3, version === '1.20.4' ? 3700 : 4671], Level: [10, { Entities: [9, { type: 10, entries: records }] }] } : { DataVersion: [3, version === '1.20.4' ? 3700 : 4671], Position: [11, position], Entities: [9, { type: 10, entries: records }] });
  const payload = compressed ? zlibSync(chunk) : chunk, sectors = Math.ceil((payload.length + 5) / 4096), region = new Uint8Array((2 + sectors) * 4096), view = new DataView(region.buffer);
  view.setUint32(0, 2 << 8 | sectors); view.setUint32(8192, payload.length + 1); region[8196] = compressed ? 2 : 3; region.set(payload, 8197); region.name = 'r.0.0.mca'; return region;
}
