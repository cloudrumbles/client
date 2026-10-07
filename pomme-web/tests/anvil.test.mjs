import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, zlibSync } from '../vendor/fflate.js';
import { decodeNBT } from '../src/nbt.js';
import { importAnvil, importLevelDat, registryStates } from '../src/anvil.js';

const enc = new TextEncoder();
const join = arrays => { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };
const integer = (size, number) => { const bytes = new Uint8Array(size), view = new DataView(bytes.buffer); if (size === 1) view.setInt8(0, number); else if (size === 2) view.setInt16(0, number); else if (size === 4) view.setInt32(0, number); else view.setBigInt64(0, BigInt(number)); return bytes; };
const text = value => { const bytes = enc.encode(value); return join([integer(2, bytes.length), bytes]); };
function payload(type, value) {
  if ([1, 2, 3, 4].includes(type)) return integer(({ 1: 1, 2: 2, 3: 4, 4: 8 })[type], value);
  if (type === 8) return text(value);
  if (type === 7) return join([integer(4, value.length), new Uint8Array(value)]);
  if (type === 10) return join([...Object.entries(value).map(([name, [childType, child]]) => join([integer(1, childType), text(name), payload(childType, child)])), integer(1, 0)]);
  if (type === 9) return join([integer(1, value.type), integer(4, value.values.length), ...value.values.map(entry => payload(value.type, entry))]);
  if (type === 12) return join([integer(4, value.length), ...value.map(n => integer(8, n))]);
  throw new Error(`Fixture type ${type}`);
}
const nbt = value => join([integer(1, 10), text(''), payload(10, value)]);
const registry = { blocks: Array.from({ length: 32 }, (_, id) => ({ name: id === 0 ? 'air' : `test_${id}`, minStateId: id, maxStateId: id, states: [] })) };
function regionFixture({ compression = 2, sectionY = -4, paletteCount = 32, dataVersion = 3700, external = false } = {}) {
  const values = Array.from({ length: paletteCount }, (_, id) => ({ Name: [8, `minecraft:${id === 0 ? 'air' : `test_${id}`}`] }));
  const bits = Math.max(4, Math.ceil(Math.log2(paletteCount))), perLong = Math.floor(64 / bits);
  const longs = Array.from({ length: Math.ceil(4096 / perLong) }, () => 0n);
  for (let i = 0; i < 4096; i++) longs[Math.floor(i / perLong)] |= BigInt(i % paletteCount) << BigInt((i % perLong) * bits);
  const bytes = nbt({ DataVersion: [3, dataVersion], xPos: [3, -32], zPos: [3, 64], sections: [9, { type: 10, values: [{ Y: [1, sectionY], SkyLight: [7, new Uint8Array(2048).fill(0xab)], BlockLight: [7, new Uint8Array(2048).fill(0x21)], block_states: [10, { palette: [9, { type: 10, values }], ...(paletteCount > 1 ? { data: [12, longs.map(n => BigInt.asIntN(64, n))] } : {}) }] }] }] });
  const compressed = compression === 1 ? gzipSync(bytes) : compression === 2 ? zlibSync(bytes) : bytes;
  const sectors = Math.ceil((compressed.length + 5) / 4096), region = new Uint8Array((2 + sectors) * 4096), view = new DataView(region.buffer);
  view.setUint32(0, 2 * 256 + sectors); view.setUint32(8192, compressed.length + 1); region[8196] = compression | (external ? 128 : 0); region.set(compressed, 8197);
  return region;
}

test('NBT preserves signed bigints and null-prototype compounds; malformed data is bounded', () => {
  const bytes = nbt({ value: [4, -9223372036854775808n], ['__proto__']: [8, 'safe'], array: [12, [-1n, 2n]] });
  const decoded = decodeNBT(bytes);
  assert.equal(decoded.value.value, -9223372036854775808n); assert.deepEqual(decoded.value.array, new BigInt64Array([-1n, 2n]));
  assert.equal(Object.getPrototypeOf(decoded.value), null); assert.equal(decoded.bytesRead, bytes.length);
  assert.equal(decoded.value.__proto__, 'safe');
  assert.throws(() => decodeNBT(bytes.subarray(0, -1)), /Truncated/);
  assert.throws(() => decodeNBT(join([bytes, new Uint8Array([0])])), /Trailing/);
  assert.throws(() => decodeNBT(bytes, { maxBytes: 10 }), /byte limit/);
  assert.throws(() => decodeNBT(nbt({ nested: [10, { child: [10, {}] }] }), { maxDepth: 1 }), /depth limit/);
  const unnamed = join([integer(1, 10), payload(10, { hello: [8, '世界'] })]);
  assert.equal(decodeNBT(unnamed, { named: false }).value.hello, '世界');
  const modified = join([integer(1, 8), text(''), integer(2, 8), new Uint8Array([192, 128, 237, 160, 189, 237, 184, 128])]);
  assert.equal(decodeNBT(modified).value, '\0😀', 'Java modified UTF-8 NUL and surrogate pairs decode losslessly');
});

test('real deflated Anvil NBT decodes negative region coordinates, build height, and padded long indices', async () => {
  const result = await importAnvil(regionFixture(), { regionX: -1, regionZ: 2, registry });
  assert.equal(result.chunks, 1); assert.equal(result.sections.length, 1);
  const section = result.sections[0];
  assert.deepEqual([section.cx, section.sy, section.cz], [-32, -4, 64]);
  assert.ok(section.states instanceof Uint16Array); assert.equal(section.states.length, 4096);
  assert.equal(section.skyLight.length, 2048); assert.equal(section.blockLight.length, 2048);
  assert.ok(section.skyLight.every(byte => byte === 0xab)); assert.ok(section.blockLight.every(byte => byte === 0x21));
  for (let i = 0; i < 4096; i++) assert.equal(section.states[i], i % 32, `x+z*16+y*256 index ${i}`);
  assert.deepEqual(result.diagnostics.dataVersions, [3700]); assert.deepEqual(result.diagnostics.unknownStates, []);
});

test('gzip, raw, single-entry palettes and section streaming preserve the actual NBT content', async () => {
  for (const compression of [1, 3]) {
    const received = [];
    const result = await importAnvil(regionFixture({ compression, paletteCount: 1, sectionY: 19 }), { regionX: -1, regionZ: 2, registry, onSection: async section => received.push(section) });
    assert.equal(result.sections.length, 0); assert.equal(received.length, 1); assert.equal(received[0].sy, 19);
    assert.ok(received[0].states.every(id => id === 0));
  }
});

test('Anvil rejects invalid sectors, overlap, wrong coordinates and oversized inflation; external chunks are explicit', async () => {
  await assert.rejects(importAnvil(new Uint8Array(8191), { registry }), /sector length/);
  await assert.rejects(importAnvil(regionFixture(), { registry }), /coordinates/);
  await assert.rejects(importAnvil(regionFixture(), { regionX: -1, regionZ: 2, registry, maxChunkBytes: 100 }), /size limit|Truncated|bounds|offset/i);
  const overlap = regionFixture(); new DataView(overlap.buffer).setUint32(4, new DataView(overlap.buffer).getUint32(0));
  await assert.rejects(importAnvil(overlap, { regionX: -1, regionZ: 2, registry }), /overlap/);
  const external = await importAnvil(regionFixture({ external: true }), { regionX: -1, regionZ: 2, registry });
  assert.equal(external.diagnostics.externalChunks, 1); assert.match(external.diagnostics.skippedChunks[0].reason, /External/);
  const old = await importAnvil(regionFixture({ dataVersion: 2200 }), { regionX: -1, regionZ: 2, registry });
  assert.match(old.diagnostics.skippedChunks[0].reason, /1.16/);
});

test('level.dat supplies actual world spawn and lossless seed/time metadata', async () => {
  const bytes = gzipSync(nbt({ Data: [10, { SpawnX: [3, -12], SpawnY: [3, 70], SpawnZ: [3, 24], LevelName: [8, 'Local world'], DataVersion: [3, 3700], Time: [4, 45000n], WorldGenSettings: [10, { seed: [4, 1234567890123456789n] }] }] }));
  let spawn;
  const result = await importLevelDat(bytes, { onSpawn: value => { spawn = value; } });
  assert.deepEqual(spawn, [-12, 70, 24]); assert.equal(result.seed, 1234567890123456789n); assert.equal(result.name, 'Local world');
  assert.equal(registryStates(registry).lookup('minecraft:air', {}), 0);
});
