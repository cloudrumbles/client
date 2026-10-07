import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, zlibSync } from '../vendor/fflate.js';
import { loadResourcePack, decodePNG, MATERIAL_FLAGS } from '../src/assets.js';
import { registryStates } from '../src/anvil.js';

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

test('native blockstate mixed-radix mapping follows Minecraft boolean and enum order', () => {
  const states = registryStates({ blocks: [{ name: 'test', minStateId: 20, maxStateId: 25, states: [{ name: 'lit', type: 'bool', num_values: 2 }, { name: 'axis', values: ['x', 'y', 'z'] }] }] });
  assert.equal(states.lookup('minecraft:test', { axis: 'z', lit: 'true' }), 22);
  assert.equal(states.lookup('test', { axis: 'x', lit: 'false' }), 23);
  assert.equal(states.lookup('test', { axis: 'x', lit: 'unknown' }), undefined);
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
