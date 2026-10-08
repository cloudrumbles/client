import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { sampleColormap, createBiomeTints, applyBiomeTints, createBiomeSampler, defaultBiomeTint, hashBiomeSeed, tintComponents } from '../src/biome-tints.js';
import { reduceColumn, meshColumn } from '../src/distant.worker.js';
import { fallbackMaterials } from '../src/registry.js';
import { DISTANT_CACHE_VERSION, recordBytes, validCachedColumn, materialSignature } from '../src/distant.js';
const compiled = await WebAssembly.compile(await readFile(new URL('../public/core.wasm', import.meta.url)));
async function coreWorld() { const { exports: core } = await WebAssembly.instantiate(compiled); assert.equal(core.world_reset(-64, 384, -2, -2, 4, 4), 1); return core; }
function loadBiomes(core, x, y, z, values) { const pointer = core.world_stage_ptr(); new Uint32Array(core.memory.buffer, pointer, 64).set(values); return core.world_load_biomes(x, y, z, pointer, 64); }
const configuration = { defaultBiome: 0, biomes: [
  { id: 0, grass: 0x123456, foliage: 0x234567, water: 0x345678, modifier: 0 },
  { id: 1, grass: 0xff0000, foliage: 0x00ff00, water: 0x0000ff, modifier: 0 },
  { id: 2, grass: 0x92bd59, foliage: 0x208020, water: 0x617b64, modifier: 1 },
  { id: 3, grass: 0xffffff, foliage: 0x6a7039, water: 0x617b64, modifier: 2 },
] };

test('native climate colormap truncation and explicit biome overrides preserve original texture RGB', () => {
  const pixelsRGBA = new Uint8Array(256 * 256 * 4);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) pixelsRGBA.set([x, y, 77, 255], (y * 256 + x) * 4);
  const map = { width: 256, height: 256, pixelsRGBA };
  assert.equal(sampleColormap(map, .8, .4), 50 << 16 | 173 << 8 | 77);
  assert.equal(sampleColormap(map, 2, 0), 255 << 8 | 77);
  assert.equal(sampleColormap(map, -.7, .9), 0xffff4d);
  const registry = { biomes: [{ id: 10, name: 'plains' }, { id: 11, name: 'cherry_grove' }, { id: 12, name: 'custom:blue' }] };
  const tints = createBiomeTints(registry, { grass: map, foliage: map }, new Map([['custom:blue', { temperature: .9, downfall: .4, effects: { grass_color: 0x0808ff, foliage_color: 0x88aa11, water_color: 0x2255ff } }]]));
  assert.equal(tints.defaultBiome, 10);
  assert.equal(tints.biomes[0].grass, 50 << 16 | 173 << 8 | 77);
  assert.equal(tints.biomes[1].grass, 11983713);
  assert.deepEqual(tints.biomes[2], { id: 12, grass: 0x0808ff, foliage: 0x88aa11, water: 0x2255ff, modifier: 0 });
  assert.deepEqual(defaultBiomeTint(1, { grass: map }), [127 / 255, 127 / 255, 77 / 255]);
  assert.deepEqual(defaultBiomeTint(2, { foliage: map }), tintComponents(4764952));
  assert.deepEqual(defaultBiomeTint(3), [1, 1, 1]);
});

test('raw level.dat seeds use native little-endian SHA256 obfuscation', async () => {
  for (const seed of [0n, 1n, -1n, 9223372036854775807n, -9223372036854775808n]) {
    const input = Buffer.alloc(8); input.writeBigInt64LE(seed);
    const expected = createHash('sha256').update(input).digest().readBigInt64LE(0);
    assert.equal(await hashBiomeSeed(seed, webcrypto), expected);
  }
});

test('real WASM and CPU fallback agree across seeded negative quart boundaries, vertical clamps, swamp noise and native RGB blends', async () => {
  const core = await coreWorld(), columns = [];
  for (let z = -2; z < 2; z++) for (let x = -2; x < 2; x++) {
    const biomes = new Uint32Array(1536);
    for (let sy = -4; sy < 20; sy++) {
      const section = new Uint32Array(64);
      for (let y = 0; y < 4; y++) for (let qz = 0; qz < 4; qz++) for (let qx = 0; qx < 4; qx++) section[(y * 4 + qz) * 4 + qx] = ((x * 4 + qx + z * 4 + qz + sy * 4 + y) % 3 + 3) % 3 + 1;
      biomes.set(section, (sy + 4) * 64); assert.equal(loadBiomes(core, x, sy, z, section), 1);
    }
    columns.push({ x, z, biomes });
  }
  assert.equal(core.world_biome_section_count(), 384);
  const positions = [[-31,-80,-31],[-16,-64,-16],[-1,-1,-1],[0,0,0],[2,2,2],[7,7,7],[8,8,8],[15,15,15],[16,16,16],[31,328,31],[17,7,-33],[-29,119,21]];
  for (const seed of [0n, -1n, 1234567890123456789n]) for (const blendRadius of [0, 2]) {
    applyBiomeTints(core, configuration, { seed, blendRadius });
    const sample = createBiomeSampler(configuration, { seed, blendRadius, columns });
    for (const position of positions) for (const kind of [1, 2, 3, 4]) assert.deepEqual(tintComponents(core.world_biome_tint(...position, kind)), sample(...position, kind), `${position} kind${kind} seed${seed} blend${blendRadius}`);
  }
  const revision = core.world_revision();
  assert.equal(loadBiomes(core, -2, -4, -2, columns[0].biomes.subarray(0, 64)), 1);
  assert.equal(core.world_revision(), revision, 'duplicate biome palettes preserve cached terrain meshes');
  assert.equal(core.world_load_biomes(-2, -4, -2, core.world_stage_ptr() + 4, 64), 0);
  assert.equal(core.world_load_biomes(-2, -4, -2, core.world_stage_ptr(), 63), 0);
  assert.equal(core.world_set_biome_blend_radius(8), 0);
  assert.equal(core.biome_tints_register(9, 0x1000000, 0, 0, 0), 0);
  assert.equal(core.world_unload_column(-2, -2), 1);
  assert.equal(core.world_biome_section_count(), 360);
});

test('custom native templates tint each vertex independently without changing confirmed collision or ray picking', async () => {
  const core = await coreWorld(); applyBiomeTints(core, configuration, { blendRadius: 0 });
  assert.equal(loadBiomes(core, 0, 0, 0, new Uint32Array(64).fill(1)), 1);
  assert.equal(core.block_register(700, 1, 1, 1, 17), 1);
  const vertices = new Float32Array([[0,1,0],[0,1,1],[1,1,1],[0,1,0],[1,1,1],[1,1,0]].flatMap(p => [...p,0,1,0,1,1,1,1,0,0,-1,17]));
  const pointer = core.world_float_stage_ptr(); new Float32Array(core.memory.buffer, pointer, vertices.length).set(vertices);
  assert.equal(core.block_model_register(700, pointer, vertices.length), 1);
  new Float32Array(core.memory.buffer, pointer, 6).set([1,1,2,2,3,3]); assert.equal(core.block_model_tints(700, pointer, 6), 1);
  assert.equal(core.block_model_tints(700, pointer, 5), 0);
  assert.equal(core.block_set(8, 8, 8, 700), 1);
  const count = core.mesh_chunk(10, 0), mesh = new Float32Array(core.memory.buffer, core.mesh_ptr(), count * 14).slice();
  assert.equal(count, 6);
  for (let i = 0; i < 6; i++) assert.deepEqual([...mesh.subarray(i * 14 + 6, i * 14 + 9)], i < 2 ? [1,0,0] : i < 4 ? [0,1,0] : [0,0,1]);
  assert.equal(core.block_get(8, 8, 8), 700);
  assert.equal(core.collides_aabb(8.1, 8.1, 8.1, 8.9, 8.9, 8.9), 1);
  assert.equal(core.ray_cast(8.5, 11, 8.5, 0, -1, 0, 5), 1);
});

test('distant cache retains native biome IDs within its byte budgets and bakes selected tint into stable coarse meshes', () => {
  const block = { id: 700, name: 'minecraft:grass_block', flags: 3, color: [1,1,1], faces: Object.fromEntries(['east','west','up','down','south','north'].map(face => [face, { tintKind: 1, tint: [1,1,1] }])) };
  const materials = new Map([[700, block]]), blocks = new Uint16Array(4096); blocks[(8 * 16 + 8) * 16 + 8] = 700;
  const record = reduceColumn({ x: 0, z: 0, sections: [{ sectionY: 0, blocks, biomes: new Uint32Array(64).fill(1) }] }, materials);
  assert.equal(record.biomes.length, 1536); assert.equal(record.biomes[4 * 64], 1);
  assert.equal(recordBytes(record), 29200);
  record.schemaVersion = DISTANT_CACHE_VERSION; record.signature = materialSignature(materials);
  assert.ok(validCachedColumn(record, record.signature));
  const sample = createBiomeSampler(configuration, { blendRadius: 0, columns: [record] });
  const geometry = meshColumn(record, 4, materials, sample).opaque;
  assert.ok(geometry.length > 0);
  for (let i = 0; i < geometry.length; i += 14) assert.deepEqual([...geometry.subarray(i + 6, i + 9)], [1,0,0]);
  assert.equal(validCachedColumn({ ...record, biomes: new Uint32Array(64) }, record.signature), false);
});

test('native WASM and CPU fallback sample custom dimension quart Y ranges and vertical limits identically', async () => {
  const core = await coreWorld();
  for (const bounds of [{ minY: 0, height: 256 }, { minY: -320, height: 512 }, { minY: -40000, height: 32 }, { minY: 40000, height: 32 }]) {
    const { minY, height } = bounds;
    assert.equal(core.world_reset(minY, height, -1, -1, 3, 3), 1);
    const records = [];
    for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
      const biomes = new Uint32Array(height * 4);
      for (let section = 0; section < height / 16; section++) {
        const palette = new Uint32Array(64);
        for (let quart = 0; quart < 4; quart++) palette.fill((section * 4 + quart) % 3 + 1, quart * 16, (quart + 1) * 16);
        biomes.set(palette, section * 64); assert.equal(loadBiomes(core, x, minY / 16 + section, z, palette), 1);
      }
      records.push({ x, z, ...bounds, biomes });
    }
    for (const seed of [0n, -987654321n]) for (const blendRadius of [0, 2]) {
      applyBiomeTints(core, configuration, { seed, blendRadius });
      const sample = createBiomeSampler(configuration, { seed, blendRadius, columns: records });
      for (const y of [minY - 8, minY, minY + 3, minY + height - 4, minY + height - 1, minY + height + 8]) for (const kind of [1, 2, 3, 4]) {
        assert.deepEqual(sample(6, y, 7, kind), tintComponents(core.world_biome_tint(6, y, 7, kind)), `${minY}/${height}, y${y}, kind${kind}, seed${seed}, blend${blendRadius}`);
      }
    }
  }
});


test('procedural fallback terrain retains native biome kinds and fixed foliage constants before textures are imported', () => {
  const names = ['air', 'grass_block', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'water'];
  const registry = { blocks: names.map((name, id) => ({ name, minStateId: id, maxStateId: id, defaultState: id, states: [], boundingBox: name === 'air' || name === 'water' ? 'empty' : 'block', filterLight: 15 })) };
  const materials = fallbackMaterials(registry);
  assert.equal(materials.get(1).faces.up.tintKind, 1); assert.equal(materials.get(1).faces.down.tintKind, 0);
  assert.deepEqual(materials.get(1).faces.down.tint, [.39, .27, .17]);
  assert.equal(materials.get(2).faces.up.tintKind, 2);
  assert.deepEqual(materials.get(3).color, [97, 153, 97].map(value => value / 255));
  assert.deepEqual(materials.get(4).color, [128, 167, 85].map(value => value / 255));
  assert.equal(materials.get(5).faces.up.tintKind, 3);
  const biomes = createBiomeTints({ biomes: [{ id: 0, name: 'plains' }, { id: 1, name: 'desert' }] });
  assert.notEqual(biomes.biomes[0].grass, biomes.biomes[1].grass, 'compact native RGB facts retain biome variation without imported colormap pixels');
});
