import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, zlibSync } from '../vendor/fflate.js';
import { loadResourcePack, decodePNG, MATERIAL_FLAGS, nativeBlockTint } from '../src/assets.js';
import { registryStates } from '../src/anvil.js';
import { copperStatueGeometry } from '../src/copper-statue.js';

const enc = new TextEncoder();
const join = arrays => { const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0)); let at = 0; for (const a of arrays) { out.set(a, at); at += a.length; } return out; };
function crc(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const payload = join([enc.encode(type), data]), out = new Uint8Array(data.length + 12), view = new DataView(out.buffer); view.setUint32(0, data.length); out.set(payload, 4); view.setUint32(out.length - 4, crc(payload)); return out; }
function png(width, height, pixels) {
  const header = new Uint8Array(13), hv = new DataView(header.buffer); hv.setUint32(0, width); hv.setUint32(4, height); header[8] = 8; header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1)); for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(rows)), chunk('IEND', new Uint8Array())]);
}
const registry = { blocks: [
  { name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' },
  { name: 'stone', minStateId: 1, maxStateId: 1, boundingBox: 'block' },
  { name: 'oak_slab', minStateId: 2, maxStateId: 3, boundingBox: 'block', states: [{ name: 'type', type: 'enum', values: ['bottom', 'top'] }] },
  { name: 'oak_fence', minStateId: 4, maxStateId: 5, boundingBox: 'block', states: [{ name: 'north', type: 'bool', num_values: 2 }] },
  { name: 'water', minStateId: 6, maxStateId: 6, boundingBox: 'empty' },
  { name: 'chest', minStateId: 7, maxStateId: 7, boundingBox: 'block' },
] };
function resourceArchive(overrides = {}) {
  const face = { texture: '#all' };
  const cube = { textures: { all: 'minecraft:block/red' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(n => [n, { ...face, cullface: n }])) }] };
  const files = {
    'assets/minecraft/textures/block/red.png': png(2, 2, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])),
    'assets/minecraft/textures/block/water_still.png': png(1, 1, new Uint8Array([255, 255, 255, 180])),
    'assets/minecraft/models/block/cube.json': cube,
    'assets/minecraft/models/block/stone.json': { parent: 'minecraft:block/cube', textures: { all: '#side', side: 'minecraft:block/red' } },
    'assets/minecraft/models/block/slab.json': { parent: 'block/cube', elements: [{ ...cube.elements[0], to: [16, 8, 16] }] },
    'assets/minecraft/models/block/post.json': { parent: 'block/cube', elements: [{ ...cube.elements[0], from: [6, 0, 6], to: [10, 16, 10] }] },
    'assets/minecraft/models/block/rail.json': { parent: 'block/cube', elements: [{ ...cube.elements[0], from: [7, 6, 0], to: [9, 9, 6] }] },
    'assets/minecraft/models/block/chest.json': { parent: 'builtin/entity' },
    'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'block/stone' } } },
    'assets/minecraft/blockstates/oak_slab.json': { variants: { 'type=bottom': { model: 'block/slab' }, 'type=top': { model: 'block/slab', x: 180 } } },
    'assets/minecraft/blockstates/oak_fence.json': { multipart: [{ apply: { model: 'block/post' } }, { when: { OR: [{ north: 'true' }, { north: 'invalid' }] }, apply: { model: 'block/rail' } }] },
    'assets/minecraft/blockstates/chest.json': { variants: { '': { model: 'block/chest' } } },
    'META-INF/irrelevant.class': enc.encode('Not an asset'),
    ...overrides,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, data instanceof Uint8Array ? data : enc.encode(JSON.stringify(data))])));
}

test('modern copper chest/statue native forms and pot height bake without placeholder geometry', async () => {
  const shape = [[.125, 0, .125, .875, 1.5, .875]];
  const native = { blocks: [registry.blocks[0],
    { name: 'copper_chest', minStateId: 1, maxStateId: 3, boundingBox: 'block', states: [{ name: 'type', values: ['single', 'left', 'right'] }] },
    { name: 'waxed_oxidized_copper_chest', minStateId: 4, maxStateId: 4, boundingBox: 'block' },
    { name: 'copper_golem_statue', minStateId: 10, maxStateId: 13, boundingBox: 'block', states: [{ name: 'copper_golem_pose', values: ['standing', 'running', 'sitting', 'star'] }] },
    { name: 'decorated_pot', minStateId: 14, maxStateId: 14, boundingBox: 'block' }],
    collisionShapes: { blocks: { copper_golem_statue: 1 }, shapes: { 1: shape } } };
  const texture = png(1, 1, new Uint8Array([140, 90, 50, 255])), files = {};
  for (const name of ['copper', 'copper_left', 'copper_right', 'copper_oxidized']) files[`assets/minecraft/textures/entity/chest/${name}.png`] = texture;
  for (const name of ['copper_golem/copper_golem', 'decorated_pot/decorated_pot_base', 'decorated_pot/decorated_pot_side']) files[`assets/minecraft/textures/entity/${name}.png`] = texture;
  for (const block of native.blocks.slice(1)) {
    files[`assets/minecraft/blockstates/${block.name}.json`] = { variants: { '': { model: `block/${block.name}` } } };
    files[`assets/minecraft/models/block/${block.name}.json`] = { parent: 'builtin/entity' };
  }
  const { materials, atlas, diagnostics } = await loadResourcePack(resourceArchive(files), { registry: native });
  assert.equal(diagnostics.unsupportedStates, 0);
  for (const [id, name] of [[1, 'copper'], [2, 'copper_left'], [3, 'copper_right'], [4, 'copper_oxidized']]) {
    const material = materials.get(id);
    assert.equal(material.model.staticBlockEntity, 'chest');
    assert.equal(material.templateVertices[12], atlas.tileByName.get(`minecraft:entity/chest/${name}`));
    assert.equal(material.model.parts.length, 3);
  }
  const bounds = vertices => [0, 1, 2].map(axis => {
    const values = Array.from({ length: vertices.length / 14 }, (_, i) => vertices[i * 14 + axis]);
    return [Math.min(...values), Math.max(...values)];
  });
  for (const id of [10, 11, 12, 13]) {
    const material = materials.get(id);
    assert.equal(material.model.staticBlockEntity, 'copper statue');
    assert.ok(material.flags & MATERIAL_FLAGS.CUSTOM_MODEL); assert.equal(material.flags & MATERIAL_FLAGS.FLUID, 0);
    assert.deepEqual(material.collisionBoxes, shape, 'native state collision remains independent of model poses');
    assert.ok(material.particleTile > 0);
  }
  assert.ok(Math.abs(bounds(materials.get(10).templateVertices)[1][1] - 23.985 / 16) < 1e-6);
  assert.ok(Math.abs(bounds(materials.get(12).templateVertices)[1][1] - 19.985 / 16) < 1e-6);
  assert.ok(bounds(materials.get(13).templateVertices)[0][0] < 0 && bounds(materials.get(13).templateVertices)[0][1] > 1, 'native star arms extend beyond their block');
  const pot = materials.get(14);
  assert.ok(Math.abs(bounds(pot.templateVertices)[1][1] - 19.9 / 16) < 1e-6);
  assert.equal(pot.model.rotation[1], 180);
  assert.ok(pot.model.quads.some(quad => quad.positions.every(position => position[1] === 1)), 'native body closes at16px below the neck');
});

test('all native copper statue pose triangles keep outward normals and exact cube UVs', () => {
  assert.equal(copperStatueGeometry('unknown'), null);
  for (const pose of ['standing', 'running', 'sitting', 'star']) {
    const vertices = copperStatueGeometry(pose);
    assert.equal(vertices.length / 14, pose === 'sitting' ? 396 : 324);
    for (let i = 0; i < vertices.length; i += 42) {
      const a = [0,1,2].map(axis => vertices[i + 14 + axis] - vertices[i + axis]);
      const b = [0,1,2].map(axis => vertices[i + 28 + axis] - vertices[i + axis]);
      const cross = [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
      assert.ok(cross.reduce((sum, value, axis) => sum + value * vertices[i + 3 + axis], 0) > 0);
    }
    for (let i = 0; i < vertices.length; i += 14) {
      assert.ok(Math.abs(Math.hypot(...vertices.subarray(i + 3, i + 6)) - 1) < 1e-6);
      assert.ok(vertices[i + 10] >= 0 && vertices[i + 10] <= 1 && vertices[i + 11] >= 0 && vertices[i + 11] <= 1);
    }
  }
});

test('native static forms preserve inherited particle aliases and state-specific pack overrides', async () => {
  const native = { blocks: [
    { name: 'copper_golem_statue', minStateId: 1, maxStateId: 2, boundingBox: 'block', states: [{ name: 'waterlogged', values: ['false', 'true'] }] },
    { name: 'copper_chest', minStateId: 3, maxStateId: 3, boundingBox: 'block' },
    { name: 'decorated_pot', minStateId: 4, maxStateId: 4, boundingBox: 'block' },
  ] };
  const files = {}, image = png(1, 1, new Uint8Array([140, 90, 50, 255]));
  for (const name of ['block/copper_block', 'block/oxidized_copper', 'block/terracotta', 'entity/copper_golem/copper_golem', 'entity/chest/copper', 'entity/decorated_pot/decorated_pot_base', 'entity/decorated_pot/decorated_pot_side']) files[`assets/minecraft/textures/${name}.png`] = image;
  files['assets/minecraft/models/block/native_entity.json'] = { parent: 'builtin/entity', textures: { particle: '#breakage', breakage: 'minecraft:block/copper_block' } };
  for (const name of ['copper_golem_statue', 'copper_chest', 'decorated_pot']) {
    files[`assets/minecraft/models/block/${name}.json`] = { parent: 'block/native_entity', ...(name === 'decorated_pot' ? { textures: { breakage: 'block/terracotta' } } : {}) };
    files[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `block/${name}` } } };
  }
  const base = resourceArchive(files), overlay = resourceArchive({
    'assets/minecraft/models/block/statue_logged.json': { parent: 'block/copper_golem_statue', textures: { breakage: 'block/oxidized_copper' } },
    'assets/minecraft/blockstates/copper_golem_statue.json': { variants: { 'waterlogged=false': { model: 'block/copper_golem_statue' }, 'waterlogged=true': { model: 'block/statue_logged' } } },
  });
  const pack = await loadResourcePack([base, overlay], { registry: native });
  for (const [id, expected] of [[1, 'copper_block'], [2, 'oxidized_copper'], [3, 'copper_block'], [4, 'terracotta']]) {
    const material = pack.materials.get(id);
    assert.equal(pack.atlas.tiles[material.particleTile].name, `minecraft:block/${expected}`);
    assert.ok(material.templateVertices.length > 0);
    assert.ok(material.model.staticBlockEntity);
  }
  assert.equal(pack.diagnostics.unsupportedStates, 0);
});

test('native font references preserve first-provider space and bitmap glyph precedence', async () => {
  const pixels = new Uint8Array(4 * 4 * 4).fill(255);
  const pack = await loadResourcePack(resourceArchive({
    'assets/minecraft/font/default.json': { providers: [
      { type: 'reference', id: 'minecraft:include/space' },
      { type: 'reference', id: 'minecraft:include/early' },
      { type: 'space', advances: { A: 40, B: 99 } },
      { type: 'reference', id: 'minecraft:include/late' },
    ] },
    'assets/minecraft/font/include/space.json': { providers: [{ type: 'space', advances: { A: 4 } }] },
    'assets/minecraft/font/include/early.json': { providers: [{ type: 'bitmap', file: 'minecraft:font/early.png', height: 8, ascent: 7, chars: ['AB'] }] },
    'assets/minecraft/font/include/late.json': { providers: [{ type: 'bitmap', file: 'minecraft:font/late.png', height: 16, ascent: 14, chars: ['BC'] }] },
    'assets/minecraft/textures/font/early.png': png(4, 4, pixels),
    'assets/minecraft/textures/font/late.png': png(4, 4, pixels),
  }), { registry });
  assert.deepEqual(pack.atlas.fontGlyphs.get('A'), { tile: -1, advance: 4, width: 0, height: 0, ascent: 0 });
  const early = pack.atlas.fontGlyphs.get('B'), late = pack.atlas.fontGlyphs.get('C');
  assert.equal(pack.atlas.tiles[early.tile].name, 'minecraft:font/early');
  assert.equal(early.advance, 5); assert.equal(early.height, 8);
  assert.equal(pack.atlas.tiles[late.tile].name, 'minecraft:font/late');
  assert.equal(late.advance, 9); assert.equal(late.height, 16);
});

test('font resource stacks retain native glyph fallback beneath higher-pack providers and references', async () => {
  const base = resourceArchive({
    'assets/minecraft/font/default.json': { providers: [{ type: 'space', advances: { A: 4, B: 6 } }] },
  });
  const overlay = resourceArchive({
    'assets/minecraft/font/default.json': { providers: [{ type: 'space', advances: { A: 20 } }] },
  });
  const spaces = await loadResourcePack([base, overlay], { registry });
  assert.equal(spaces.atlas.fontGlyphs.get('A').advance, 20);
  assert.equal(spaces.atlas.fontGlyphs.get('B').advance, 6);

  const pixels = new Uint8Array(4 * 4 * 4).fill(255);
  const referencedBase = resourceArchive({
    'assets/minecraft/font/default.json': { providers: [
      { type: 'space', advances: { A: 4, B: 6 } },
      { type: 'reference', id: 'minecraft:include/shared' },
    ] },
    'assets/minecraft/font/include/shared.json': { providers: [{ type: 'space', advances: { C: 8, D: 9 } }] },
  });
  const referencedOverlay = resourceArchive({
    'assets/minecraft/font/default.json': { providers: [
      { type: 'bitmap', file: 'minecraft:font/overlay.png', height: 8, ascent: 7, chars: ['A'] },
      { type: 'space', advances: { A: 99 } },
      { type: 'reference', id: 'minecraft:include/shared' },
    ] },
    'assets/minecraft/font/include/shared.json': { providers: [{ type: 'space', advances: { C: 20 } }] },
    'assets/minecraft/textures/font/overlay.png': png(4, 4, pixels),
  });
  const referenced = await loadResourcePack([referencedBase, referencedOverlay], { registry });
  const glyphs = referenced.atlas.fontGlyphs;
  assert.equal(referenced.atlas.tiles[glyphs.get('A').tile].name, 'minecraft:font/overlay');
  assert.equal(glyphs.get('A').height, 8);
  assert.equal(glyphs.get('B').advance, 6);
  assert.equal(glyphs.get('C').advance, 20);
  assert.equal(glyphs.get('D').advance, 9);
});

test('font traversal bounds repeated references with both populated and empty leaves', async () => {
  for (const providers of [[{ type: 'space', advances: { A: 4 } }], []]) {
    const files = {};
    for (let depth = 0; depth <= 6; depth++) {
      const name = depth === 0 ? 'default' : `include/layer${depth}`;
      files[`assets/minecraft/font/${name}.json`] = { providers: depth === 6 ? providers : Array.from({ length: 10 }, () => ({ type: 'reference', id: `minecraft:include/layer${depth + 1}` })) };
    }
    await assert.rejects(loadResourcePack(resourceArchive(files), { registry }), /Font references exceed the provider traversal limit/);
  }
});

test('font resource stack fallback still rejects cyclic and overly deep reference graphs', async () => {
  const overlay = resourceArchive({ 'assets/minecraft/font/default.json': { providers: [{ type: 'space', advances: { A: 20 } }] } });
  const cyclic = resourceArchive({ 'assets/minecraft/font/default.json': { providers: [{ type: 'reference', id: 'minecraft:default' }] } });
  await assert.rejects(loadResourcePack([cyclic, overlay], { registry }), /Cyclic or overly deep font reference/);
  const files = {};
  for (let depth = 0; depth <= 34; depth++) {
    const name = depth === 0 ? 'default' : `include/layer${depth}`;
    files[`assets/minecraft/font/${name}.json`] = { providers: depth === 34 ? [] : [{ type: 'reference', id: `minecraft:include/layer${depth + 1}` }] };
  }
  await assert.rejects(loadResourcePack([resourceArchive(files), overlay], { registry }), /Cyclic or overly deep font reference/);
});

test('portable PNG decoder preserves texture pixels, rejects malformed formats, and bounds allocations', () => {
  const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 12]);
  assert.deepEqual(decodePNG(png(2, 1, pixels)).pixelsRGBA, pixels);
  assert.throws(() => decodePNG(new Uint8Array(33)), /signature/);
  assert.throws(() => decodePNG(png(2, 1, pixels), { maxPixels: 1 }), /pixel limit/);
  const interlace = png(2, 1, pixels); interlace[28] = 1;
  assert.throws(() => decodePNG(interlace), /Interlaced/);
});

test('resource ZIP imports inherited texture references, native IDs, padded atlas, and slab/fence geometry', async () => {
  const { atlas, materials, diagnostics } = await loadResourcePack(resourceArchive(), { registry, tileSize: 8 });
  assert.equal(materials.size, 8);
  assert.equal(materials.get(0).flags, MATERIAL_FLAGS.INVISIBLE);
  const stone = materials.get(1);
  assert.equal(stone.fullCube, true); assert.equal(stone.flags, MATERIAL_FLAGS.SOLID | MATERIAL_FLAGS.AO_OPAQUE);
  assert.equal(stone.templateVertices.length, 36 * 14);
  assert.deepEqual(stone.collisionBoxes, [[0, 0, 0, 1, 1, 1]]);
  const red = atlas.tiles.find(tile => tile.name === 'minecraft:block/red');
  assert.ok(red.id > 0); assert.equal(stone.faces.up.tile, red.id);
  const pixelAt = (x, y) => Array.from(atlas.pixelsRGBA.subarray((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4));
  assert.deepEqual(pixelAt(red.x, red.y), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(red.x - 1, red.y - 1), pixelAt(red.x, red.y), 'atlas border extrudes edge texels');
  assert.equal(materials.get(2).fullCube, false); assert.ok(materials.get(2).flags & MATERIAL_FLAGS.CUSTOM_MODEL);
  assert.deepEqual(materials.get(2).collisionBoxes, [[0, 0, 0, 1, .5, 1]]);
  const top = materials.get(3).collisionBoxes[0];
  assert.ok(Math.abs(top[1] - .5) < 1e-6 && Math.abs(top[4] - 1) < 1e-6);
  assert.equal(materials.get(4).model.quads.length, 12, 'true boolean first native state selects multipart rail');
  assert.equal(materials.get(5).model.quads.length, 6, 'false boolean second state selects post only');
  assert.ok(materials.get(6).flags & MATERIAL_FLAGS.FLUID); assert.equal(materials.get(6).collisionBoxes.length, 0);
  assert.equal(diagnostics.unsupportedStates, 1); assert.equal(materials.get(7).unsupported, true);
  assert.match(diagnostics.unsupportedModels[0].reason, /builtin|missing/);
  for (const m of materials.values()) for (let i = 0; i < m.templateVertices.length; i += 14) {
    assert.ok(m.templateVertices.subarray(i, i + 14).every(Number.isFinite));
    assert.equal(m.templateVertices[i + 13] & 511, m.flags);
    assert.equal((m.templateVertices[i + 13] >> 10) & 15, 15);
  }
});

test('resource inheritance and texture cycles fail visibly rather than hanging', async () => {
  const pack = resourceArchive({ 'assets/minecraft/models/block/stone.json': { parent: 'block/stone' } });
  const result = await loadResourcePack(pack, { registry });
  assert.equal(result.materials.get(1).unsupported, true);
  assert.match(result.materials.get(1).model.reason, /Cyclic/);
  await assert.rejects(loadResourcePack(pack, { registry, maxInflatedBytes: 100 }), /limits/);
});

test('ordered resource pack stacks retain base models and append/replace native sound events', async () => {
  const base = resourceArchive({ 'assets/minecraft/sounds.json': { appended: { sounds: ['base/a'], subtitle: 'Base subtitle' }, replaced: { sounds: ['base/b'] }, untouched: { sounds: ['base/c'] } } });
  const partial = zipSync({
    'assets/minecraft/textures/block/red.png': png(1, 1, new Uint8Array([5, 240, 10, 255])),
    'assets/minecraft/sounds.json': enc.encode(JSON.stringify({ appended: { sounds: [{ name: 'override/a', volume: .4 }] }, replaced: { replace: true, sounds: ['override/b'] } })),
  });
  const result = await loadResourcePack([base, new File([partial], 'server.zip')], { registry });
  assert.equal(result.materials.get(1).unsupported, false, 'partial server packs inherit base model JSON');
  const tile = result.atlas.tiles[result.materials.get(1).faces.up.tile], index = (tile.y * result.atlas.width + tile.x) * 4;
  assert.deepEqual(result.atlas.pixelsRGBA.slice(index, index + 4), new Uint8Array([5, 240, 10, 255]));
  assert.deepEqual(result.sounds.get('minecraft').appended.sounds, ['base/a', { name: 'override/a', volume: .4 }]); assert.equal(result.sounds.get('minecraft').appended.subtitle, 'Base subtitle');
  assert.deepEqual(result.sounds.get('minecraft').replaced.sounds, ['override/b']); assert.deepEqual(result.sounds.get('minecraft').untouched.sounds, ['base/c']);
  const raw = JSON.parse(new TextDecoder().decode(result.audioFiles.get('assets/minecraft/sounds.json'))); assert.deepEqual(raw, result.sounds.get('minecraft'));
  await assert.rejects(loadResourcePack([base, partial], { registry, maxPackBytes: base.length }), /file size limit/);
  await assert.rejects(loadResourcePack([], { registry }), /between one and 64/);
});

test('native blockstate mixed-radix mapping follows Minecraft boolean and enum order', () => {
  const states = registryStates({ blocks: [{ name: 'test', minStateId: 20, maxStateId: 25, states: [{ name: 'lit', type: 'bool', num_values: 2 }, { name: 'axis', values: ['x', 'y', 'z'] }] }] });
  assert.equal(states.lookup('minecraft:test', { axis: 'z', lit: 'true' }), 22);
  assert.equal(states.lookup('test', { axis: 'x', lit: 'false' }), 23);
  assert.equal(states.lookup('test', { axis: 'x', lit: 'unknown' }), undefined);
});

test('resource packs retain native glyph metrics, item/particle/weather sheets and supplied audio bytes', async () => {
  const glyph = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) glyph.set([255, 255, 255, 255], (y * 8 + x) * 4);
  const audio = new Uint8Array([79, 103, 103, 83, 0, 1]);
  const pack = await loadResourcePack(resourceArchive({
    'assets/minecraft/font/default.json': { providers: [{ type: 'reference', id: 'minecraft:test' }, { type: 'space', advances: { ' ': 4 } }] },
    'assets/minecraft/font/test.json': { providers: [{ type: 'bitmap', file: 'minecraft:font/glyph.png', ascent: 7, chars: ['A'] }] },
    'assets/minecraft/textures/font/glyph.png': png(8, 8, glyph),
    'assets/minecraft/textures/item/diamond_sword.png': png(8, 8, glyph),
    'assets/minecraft/models/item/diamond_sword.json': { parent: 'item/handheld', textures: { layer0: 'item/diamond_sword' } },
    'assets/minecraft/textures/particle/flame.png': png(8, 8, glyph),
    'assets/minecraft/particles/flame.json': { textures: ['minecraft:particle/flame'] },
    'assets/minecraft/textures/environment/rain.png': png(8, 8, glyph),
    'assets/minecraft/textures/map/map_background.png': png(8, 16, new Uint8Array(8 * 16 * 4).fill(255)),
    'assets/minecraft/textures/gui/sprites/map/decorations/player.png': png(8, 8, glyph),
    'assets/minecraft/textures/gui/sprites/container/irrelevant.png': png(8, 8, glyph),
    'assets/minecraft/sounds.json': { 'block.chest.open': { sounds: ['test/chest'] } },
    'assets/minecraft/sounds/test/chest.ogg': audio,
  }), { registry, tileSize: 16 });
  const metrics = pack.atlas.fontGlyphs.get('A');
  assert.equal(metrics.width, 5); assert.equal(metrics.height, 8); assert.equal(metrics.advance, 6); assert.equal(metrics.ascent, 7);
  assert.deepEqual(metrics.uv, [0, 0, 5 / 8, 1]); assert.equal(pack.atlas.fontGlyphs.get(' ').advance, 4);
  const item = pack.atlas.tiles[pack.atlas.itemTiles.get('minecraft:item/diamond_sword')];
  assert.equal(item.width, 8, 'retain source item pixels instead of upscaling to the block tile size');
  assert.ok(pack.atlas.itemModels.has('minecraft:diamond_sword'));
  assert.deepEqual(pack.atlas.particleFrames.get('minecraft:flame'), [pack.atlas.particleTiles.get('minecraft:particle/flame')]);
  assert.ok(pack.atlas.weatherTiles.has('minecraft:environment/rain'));
  const map = pack.atlas.tiles[pack.atlas.tileByName.get('minecraft:map/map_background')]; assert.deepEqual([map.width, map.height], [8, 16], 'map art preserves actual dimensions');
  assert.ok(pack.atlas.tileByName.has('minecraft:gui/sprites/map/decorations/player'));
  assert.equal(pack.atlas.tileByName.has('minecraft:gui/sprites/container/irrelevant'), false, 'map sprites do not import the entire GUI atlas');
  assert.deepEqual(pack.audioFiles.get('assets/minecraft/sounds/test/chest.ogg'), audio);
  assert.ok(pack.audioFiles.get('assets/minecraft/sounds.json'));
  assert.deepEqual(pack.sounds.get('minecraft')['block.chest.open'].sounds, ['test/chest']);
  await assert.rejects(loadResourcePack(resourceArchive({ 'assets/minecraft/font/default.json': { providers: [{ type: 'reference', id: 'minecraft:default' }] } }), { registry }), /font reference/);
});

test('user entity sheets render native chest halves, beds, shulkers and rotated signs without checker placeholders', async () => {
  const blocks = [
    { name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' },
    { name: 'chest', minStateId: 1, maxStateId: 6, boundingBox: 'block', states: [{ name: 'type', values: ['single', 'left', 'right'] }, { name: 'facing', values: ['south', 'north'] }] },
    { name: 'red_bed', minStateId: 7, maxStateId: 8, boundingBox: 'block', states: [{ name: 'part', values: ['foot', 'head'] }] },
    { name: 'white_shulker_box', minStateId: 9, maxStateId: 10, boundingBox: 'block', states: [{ name: 'facing', values: ['up', 'north'] }] },
    { name: 'oak_sign', minStateId: 11, maxStateId: 12, boundingBox: 'empty', states: [{ name: 'rotation', values: ['0', '4'] }] },
  ];
  const sheet = (width, height) => { const p = new Uint8Array(width * height * 4); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) p.set([x, y, 100, 255], (y * width + x) * 4); return png(width, height, p); };
  const pack = resourceArchive({
    'assets/minecraft/textures/entity/chest/normal.png': sheet(64, 64),
    'assets/minecraft/textures/entity/chest/normal_left.png': sheet(64, 64),
    'assets/minecraft/textures/entity/chest/normal_right.png': sheet(64, 64),
    'assets/minecraft/textures/entity/bed/red.png': sheet(64, 64),
    'assets/minecraft/textures/entity/shulker/shulker_white.png': sheet(64, 64),
    'assets/minecraft/textures/entity/signs/oak.png': sheet(64, 32),
  });
  const { atlas, materials, diagnostics } = await loadResourcePack(pack, { registry: { blocks } });
  assert.equal(diagnostics.unsupportedStates, 0); assert.equal(diagnostics.staticBlockEntityStates, 12);
  assert.equal(materials.get(1).model.staticBlockEntity, 'chest'); assert.equal(materials.get(1).model.quads.length, 18);
  assert.equal(materials.get(3).model.quads.length, 15, 'left seam is removed');
  assert.equal(materials.get(5).model.quads.length, 15, 'right seam is removed');
  const southLock = materials.get(1).model.quads.slice(-6), northLock = materials.get(2).model.quads.slice(-6);
  assert.ok(Math.max(...southLock.flatMap(q => q.positions.map(p => p[2]))) > .99);
  assert.ok(Math.min(...northLock.flatMap(q => q.positions.map(p => p[2]))) < .01);
  const signTile = atlas.tiles[atlas.entityTiles.get('minecraft:entity/signs/oak')];
  assert.deepEqual([signTile.width, signTile.height], [64, 32], 'entity sheet is not resampled or cropped as a block animation');
  const index = ((signTile.y + 31) * atlas.width + signTile.x + 63) * 4;
  assert.deepEqual(Array.from(atlas.pixelsRGBA.subarray(index, index + 4)), [63, 31, 100, 255]);
  assert.equal(materials.get(7).model.staticBlockEntity, 'bed'); assert.equal(materials.get(9).model.staticBlockEntity, 'shulker');
  assert.deepEqual(materials.get(7).model.quads[0].uv, [6 / 64, 28 / 64, 22 / 64, 44 / 64]);
  assert.deepEqual(materials.get(8).model.quads[0].uv, [6 / 64, 6 / 64, 22 / 64, 22 / 64]);
  assert.notDeepEqual(materials.get(11).templateVertices, materials.get(12).templateVertices, 'sign native rotation affects its actual geometry');
  for (const material of materials.values()) for (let i = 0; i < material.templateVertices.length; i += 42) {
    const v = material.templateVertices;
    const a = [v[i + 14] - v[i], v[i + 15] - v[i + 1], v[i + 16] - v[i + 2]], b = [v[i + 28] - v[i], v[i + 29] - v[i + 1], v[i + 30] - v[i + 2]];
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    assert.ok(cross.reduce((sum, n, axis) => sum + n * v[i + 3 + axis], 0) > 0, 'authored outward triangle winding');
  }
});

test('native PNG animation metadata preserves frame order, per-frame ticks and bounded decoded RGBA', async () => {
  const red = new Uint8Array([255, 0, 0, 255]), blue = new Uint8Array([0, 0, 255, 255]);
  const pack = resourceArchive({
    'assets/minecraft/textures/block/red.png': png(1, 2, join([red, blue])),
    'assets/minecraft/textures/block/red.png.mcmeta': { animation: { frametime: 3, interpolate: true, frames: [1, { index: 0, time: 7 }, 1] } },
  });
  const { atlas, diagnostics } = await loadResourcePack(pack, { registry, tileSize: 8 });
  assert.equal(atlas.animations.length, 1); assert.equal(diagnostics.animatedTextures, 1);
  const animation = atlas.animations[0];
  assert.deepEqual(animation.durationsTicks, [3, 7, 3]); assert.equal(animation.interpolate, true);
  assert.equal(animation.frames[0], animation.frames[2], 'repeated frame references share their allocation');
  assert.deepEqual(Array.from(animation.frames[0].subarray(0, 4)), Array.from(blue));
  assert.deepEqual(Array.from(animation.frames[1].subarray(0, 4)), Array.from(red));
  assert.deepEqual([animation.width, animation.height], [8, 8]); assert.equal(diagnostics.animatedBytes, 2 * 8 * 8 * 4);
  const tile = atlas.tiles[animation.tile], start = (tile.y * atlas.width + tile.x) * 4;
  assert.deepEqual(Array.from(atlas.pixelsRGBA.subarray(start, start + 4)), Array.from(blue), 'initial atlas uses the first declared frame rather than PNG frame zero');
  await assert.rejects(loadResourcePack(pack, { registry, tileSize: 8, maxAnimatedBytes: 256 }), /memory limit/);
});

test('native tint metadata preserves biome inputs and separates static block colors without model-cache collisions', async () => {
  const names = ['grass_block', 'oak_leaves', 'spruce_leaves', 'birch_leaves', 'lily_pad', 'tall_grass', 'melon_stem', 'redstone_wire', 'pink_petals', 'unknown_leaves', 'water_cauldron', 'water', 'bubble_column'];
  let id = 1; const blocks = [{ name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' }], overrides = {};
  for (const name of names) {
    const states = name === 'tall_grass' ? [{ name: 'half', values: ['lower', 'upper'] }] : name === 'melon_stem' ? [{ name: 'age', values: ['0', '7'] }] : name === 'redstone_wire' ? [{ name: 'power', values: ['0', '15'] }] : [];
    const count = states.length ? 2 : 1; blocks.push({ name, minStateId: id, maxStateId: id + count - 1, states, boundingBox: 'empty' }); id += count;
    overrides[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `block/${name}` } } };
    overrides[`assets/minecraft/models/block/${name}.json`] = { textures: { all: 'block/red' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all', tintindex: 0 }, down: { texture: '#all', tintindex: name === 'pink_petals' ? 1 : 0 } } }] };
  }
  const colormapPixels = new Uint8Array([20, 40, 60, 255, 80, 100, 120, 255]);
  overrides['assets/minecraft/textures/colormap/grass.png'] = png(2, 1, colormapPixels);
  overrides['assets/minecraft/textures/colormap/foliage.png'] = png(2, 1, colormapPixels);
  overrides['data/minecraft/worldgen/biome/test.json'] = { temperature: .8, downfall: .4, effects: { water_color: 4159204 } };
  const native = { blocks }, result = await loadResourcePack(resourceArchive(overrides), { registry: native }), states = registryStates(native);
  const material = (name, properties = {}) => result.materials.get(states.lookup(name, properties));
  assert.deepEqual(result.atlas.colormaps.grass.pixelsRGBA, colormapPixels); assert.deepEqual([result.atlas.colormaps.grass.width, result.atlas.colormaps.grass.height], [2, 1]);
  assert.equal(result.atlas.biomeDefinitions.get('minecraft:test').effects.water_color, 4159204);
  assert.equal(material('grass_block').faces.up.tintKind, 1); assert.equal(material('oak_leaves').faces.up.tintKind, 2);
  assert.equal(material('tall_grass', { half: 'upper' }).faces.up.tintKind, 4); assert.equal(material('tall_grass', { half: 'lower' }).faces.up.tintKind, 1);
  for (const name of ['water', 'bubble_column', 'water_cauldron']) assert.equal(material(name).faces.up.tintKind, 3);
  assert.deepEqual(material('grass_block').faces.up.tint, [1, 1, 1], 'actual world biome colors are applied by the mesher rather than a default sample');
  assert.deepEqual(material('grass_block').templateTintKinds, new Uint8Array(12).fill(1));
  assert.deepEqual(material('spruce_leaves').faces.up.tint, [97, 153, 97].map(value => value / 255)); assert.equal(material('spruce_leaves').faces.up.tintKind, 0);
  assert.deepEqual(material('birch_leaves').faces.up.tint, [128, 167, 85].map(value => value / 255));
  assert.deepEqual(material('melon_stem', { age: '0' }).faces.up.tint, [0, 1, 0]); assert.deepEqual(material('melon_stem', { age: '7' }).faces.up.tint, [224, 199, 28].map(value => value / 255));
  assert.deepEqual(material('redstone_wire', { power: '0' }).faces.up.tint, [76 / 255, 0, 0]); assert.deepEqual(material('redstone_wire', { power: '15' }).faces.up.tint, [1, 50 / 255, 0]);
  assert.equal(material('pink_petals').faces.up.tintKind, 0); assert.equal(material('pink_petals').faces.down.tintKind, 1);
  assert.deepEqual(material('unknown_leaves').faces.up.tint, [1, 1, 1]); assert.equal(material('unknown_leaves').faces.up.tintKind, 0, 'unregistered block tint is not guessed from its name');
  assert.deepEqual(nativeBlockTint('pink_petals', {}, -1), { tintKind: 0, tint: [1, 1, 1] }, 'native negative tintindex makes the quad untinted');
});

test('resource pack languages merge individual translation keys across pack stacks and namespaces', async () => {
  const base = resourceArchive({ 'assets/minecraft/lang/en_us.json': { 'item.minecraft.diamond': 'Diamond', 'chat.type.text': '<%s> %s' }, 'assets/minecraft/lang/de_de.json': { 'item.minecraft.diamond': 'Diamant' } });
  const overlay = zipSync({ 'assets/minecraft/lang/en_us.json': enc.encode(JSON.stringify({ 'item.minecraft.diamond': 'Custom diamond' })), 'assets/custom/lang/en_us.json': enc.encode(JSON.stringify({ 'custom.notice': 'Native translated notice' })) });
  const pack = await loadResourcePack([base, overlay], { registry });
  assert.equal(pack.languages.get('en_us')['item.minecraft.diamond'], 'Custom diamond'); assert.equal(pack.languages.get('en_us')['chat.type.text'], '<%s> %s'); assert.equal(pack.languages.get('en_us')['custom.notice'], 'Native translated notice');
  assert.equal(pack.languages.get('de_de')['item.minecraft.diamond'], 'Diamant'); assert.equal(Object.getPrototypeOf(pack.languages.get('en_us')), null);
});

test('end portal and gateway tiles retain separate native projected layer counts without duplicating pixels', async () => {
  const blocks = [{ name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' }, { name: 'end_portal', minStateId: 1, maxStateId: 1, boundingBox: 'empty' }, { name: 'end_gateway', minStateId: 2, maxStateId: 2, boundingBox: 'empty' }];
  const pack = await loadResourcePack(resourceArchive({ 'assets/minecraft/textures/entity/end_portal.png': png(2, 2, new Uint8Array(16).fill(255)), 'assets/minecraft/textures/environment/end_sky.png': png(2, 2, new Uint8Array(16).fill(127)) }), { registry: { blocks } });
  const portal = pack.atlas.tiles[pack.atlas.entityTiles.get('minecraft:entity/end_portal')], gateway = pack.atlas.tiles[pack.atlas.entityTiles.get('minecraft:entity/end_gateway_portal')];
  assert.notEqual(portal.id, gateway.id); assert.deepEqual([portal.x, portal.y, portal.width, portal.height], [gateway.x, gateway.y, gateway.width, gateway.height]); assert.equal(gateway.aliasOf, portal.id);
  assert.equal(portal.portalLayers, 15); assert.equal(gateway.portalLayers, 16); assert.equal(portal.portalSkyTile, pack.atlas.weatherTiles.get('minecraft:environment/end_sky')); assert.equal(gateway.portalSkyTile, portal.portalSkyTile);
  assert.deepEqual(pack.materials.get(1).model.quads.map(quad => quad.normal.map(value => value || 0)), [[0, 1, 0], [0, -1, 0]], 'native end portal renders only its horizontal surfaces'); assert.equal(pack.materials.get(2).model.quads.length, 6); assert.equal(pack.materials.get(2).faces.up.tile, gateway.id);
});
