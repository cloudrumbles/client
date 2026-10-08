// Generated mechanical source inventory NBT, not an original game save.
const encode = new TextEncoder(), concat = parts => { const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };
function int(bytes, value) { const result = new Uint8Array(bytes), view = new DataView(result.buffer); if (bytes === 1) view.setInt8(0, value); else if (bytes === 2) view.setInt16(0, value); else if (bytes === 4) view.setInt32(0, value); else view.setBigInt64(0, value); return result; }
const string = value => { const bytes = encode.encode(value); return concat([int(2, bytes.length), bytes]); };
function payload(type, value) {
  if (type >= 1 && type <= 4) return int([0, 1, 2, 4, 8][type], value);
  if (type === 7) return concat([int(4, value.length), new Uint8Array(value)]);
  if (type === 8) return string(value);
  if (type === 10) return concat([...Object.entries(value).map(([name, [childType, child]]) => concat([int(1, childType), string(name), payload(childType, child)])), int(1, 0)]);
  if (type === 9) return concat([int(1, value.type), int(4, value.entries.length), ...value.entries.map(entry => payload(value.type, entry))]);
  if (type === 11) return concat([int(4, value.length), ...value.map(entry => int(4, entry))]);
  throw new Error('Unsupported generated source fixture tag.');
}
export function sourceInventoryFixture(version, { count = 10, selected = 2, deferred = false, playerUuid } = {}) {
  const legacy = version === '1.20.4';
  const item = (name, amount) => ({ id: [8, `minecraft:${name}`], [legacy ? 'Count' : 'count']: [legacy ? 1 : 3, amount] });
  const plank = { Slot: [1, selected], ...item('oak_planks', count), ...(legacy ? { tag: [10, { source: [8, 'Original-shaped source fixture'], seed: [4, 7n], byte: [1, 1], integer: [3, 1] }] } : { components: [10, deferred ? { 'minecraft:custom_data': [10, { seed: [4, 7n] }] } : { max_stack_size: [3, 16] }] }) };
  const entries = [plank], player = { SelectedItemSlot: [3, selected] };
  if (playerUuid) player.UUID = [11, playerUuid];
  if (legacy) entries.push({ Slot: [1, 103], ...item('diamond_helmet', 1) }, { Slot: [1, -106], ...item('shield', 1) });
  else player.equipment = [10, { head: [10, item('diamond_helmet', 1)], offhand: [10, item('shield', 1)] }];
  player.Inventory = [9, { type: 10, entries }];
  const root = { Data: [10, { DataVersion: [3, legacy ? 3700 : 4671], Version: [10, { Name: [8, version] }], Player: [10, player] }] };
  return concat([int(1, 10), string(''), payload(10, root)]);
}
