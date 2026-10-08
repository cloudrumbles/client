import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { FirstPersonScene, HandPose, heldItemPose, mapHandPose, itemUseAction } from '../src/first-person.js';
import { ItemMeshLibrary, generatedSpriteGeometry, crossbowProperties } from '../src/item-geometry.js';
import { defaultBiomeTint } from '../src/biome-tints.js';

const data = minecraftData('1.20.4'), registry = { items: data.itemsArray, blocks: data.blocksArray };
const slot = name => ({ present: true, itemId: data.itemsByName[name].id, itemCount: 1 });
const empty = { present: false };
function fixture() {
  const pixels = new Uint8Array(64 * 64 * 4); pixels.fill(255);
  const atlas = { width: 64, height: 64, pixelsRGBA: pixels, tiles: [{ x: 0, y: 0, width: 64, height: 64 }], entityTiles: new Map([['minecraft:entity/player/wide/steve', 0]]), itemTiles: new Map([['minecraft:item/diamond_sword', 0], ['minecraft:item/apple', 0], ['minecraft:item/bow', 0]]), itemModels: new Map() };
  const materials = new Map([[data.blocksByName.stone.defaultState, { fullCube: true, color: [0.4, 0.5, 0.6], flags: 0, faces: {} }]]);
  const uploads = [], removed = [], renderer = { uploadFirstPersonMesh(opaque, transparent, bounds, format) { uploads.push({ vertices: opaque.slice(), transparent: transparent.slice(), bounds, format }); }, clearFirstPersonMesh() { removed.push(true); } };
  const scene = new FirstPersonScene({ renderer, registry, atlas, materials });
  return { scene, renderer, atlas, materials, uploads, removed };
}
const input = extra => ({ eye: [0, 1.62, 0], yaw: 0, pitch: 0, mainHand: empty, offHand: empty, ...extra });

test('native item transforms retain equip lowering and the original eat and bow poses', () => {
  assert.deepEqual(heldItemPose().position, [0.56, -0.52, -0.72]);
  assert.deepEqual(heldItemPose({ side: -1, equip: 1 }).position, [-0.56, -1.12, -0.72]);
  const eat = heldItemPose({ action: 'eat', useTicks: 16, duration: 32 });
  const bow = heldItemPose({ action: 'bow', useTicks: 20 });
  assert.ok(Math.abs(eat.position[0]) < 0.56, 'eating moves the item toward the camera center after its native rotation');
  assert.ok(bow.matrix.some((value, index) => Math.abs(value - heldItemPose().matrix[index]) > 0.1));
  assert.equal(itemUseAction('cooked_beef', true), 'eat'); assert.equal(itemUseAction('potion', true), 'drink'); assert.equal(itemUseAction('bow', false), null);
  const normal = new HandPose().rotate('y', 32).scale(1, 2, 3).normalMatrix();
  assert.ok(Math.abs(normal[4] - 0.5) < 1e-8, 'nonuniform use animations transform normals with the inverse transpose');
});

test('generated item meshes extrude alpha holes and use their actual texture pixels', () => {
  const pixels = new Uint8Array(3 * 3 * 4); pixels.fill(255); pixels[(1 * 3 + 1) * 4 + 3] = 0;
  const atlas = { width: 3, height: 3, pixelsRGBA: pixels, tiles: [{ x: 0, y: 0, width: 3, height: 3 }] };
  const hole = generatedSpriteGeometry(atlas, 0);
  pixels[(1 * 3 + 1) * 4 + 3] = 255;
  const solid = generatedSpriteGeometry(atlas, 0);
  assert.ok(hole.length > solid.length, 'transparent inner pixels create the four inner edge spans');
  assert.equal(solid.length / 8, 36, 'a solid sprite has two planes and four extruded boundaries');
  for (let index = 0; index < hole.length; index += 8) { assert.ok(Math.abs(Math.hypot(...hole.slice(index + 3, index + 6)) - 1) < 1e-5); assert.ok(hole[index + 6] >= 0 && hole[index + 6] <= 1); }
});

test('item model inheritance and native bow predicates select the sourced sprite', () => {
  const { atlas } = fixture();
  atlas.itemTiles.set('minecraft:item/bow_pulling_1', 7);
  atlas.tiles[7] = { x: 0, y: 0, width: 64, height: 64 };
  atlas.itemModels.set('minecraft:generated', { parent: 'builtin/generated' });
  atlas.itemModels.set('minecraft:bow', { parent: 'item/generated', textures: { layer0: 'item/bow' }, display: { firstperson_righthand: { rotation: [0, -90, 25] } }, overrides: [{ predicate: { pulling: 1, pull: 0.65 }, model: 'item/bow_pulling_1' }] });
  atlas.itemModels.set('minecraft:bow_pulling_1', { parent: 'item/bow', textures: { layer0: 'item/bow_pulling_1' } });
  const library = new ItemMeshLibrary({ registry, atlas });
  assert.equal(library.get(slot('bow')).parts[0].tile, 0);
  assert.equal(library.get(slot('bow'), { pulling: 1, pull: 0.8 }).parts[0].tile, 7);
  assert.deepEqual(library.get(slot('bow'), { pulling: 1, pull: 0.8 }).display.firstperson_righthand.rotation, [0, -90, 25]);
});

test('confirmed item IDs render imported sprites and fallback full-cube block materials', () => {
  const { scene, uploads } = fixture();
  scene.update(0, input({ mainHand: slot('stone') }));
  assert.equal(scene.stats.items, 1); assert.equal(scene.stats.arms, 0); assert.equal(scene.stats.vertices, 36);
  assert.equal(uploads[0].vertices[12], -1); assert.ok(Math.abs(uploads[0].vertices[6] - 0.4) < 1e-6);
  scene.clear(); scene.update(1, input({ mainHand: slot('diamond_sword') }));
  assert.equal(scene.stats.items, 1); assert.equal(scene.stats.unsupportedItems.length, 0); assert.equal(uploads.at(-1).vertices[12], 0);
});

test('stationary hands reuse GPU mesh while camera, skin light and swing changes update it', () => {
  const { scene, uploads } = fixture();
  scene.update(0, input()); scene.update(0.1, input()); scene.update(0.2, input());
  assert.equal(uploads.length, 1, 'idle native arm must not rebuild or upload every frame');
  scene.update(0.3, input({ yaw: 0.2 })); assert.equal(uploads.length, 2);
  scene.update(0.4, input({ yaw: 0.2, blockLight: 5 })); assert.equal(uploads.length, 3);
  scene.swing(0, 0.4); scene.update(0.45, input({ yaw: 0.2, blockLight: 5 })); assert.equal(uploads.length, 4);
  scene.update(0.8, input({ yaw: 0.2, blockLight: 5 })); scene.update(0.9, input({ yaw: 0.2, blockLight: 5 })); assert.equal(uploads.length, 5);
});

test('native equip transition lowers the old item before swapping the confirmed selected slot', () => {
  const { scene } = fixture();
  const sword = slot('diamond_sword'), stone = slot('stone');
  scene.update(0, input({ mainHand: sword })); scene.update(0.051, input({ mainHand: stone }));
  assert.equal(scene.hands[0].item, sword); assert.ok(Math.abs(scene.hands[0].height - 0.6) < 1e-6);
  scene.update(0.101, input({ mainHand: stone })); assert.equal(scene.hands[0].item, sword);
  scene.update(0.151, input({ mainHand: stone })); assert.equal(scene.hands[0].item, stone); assert.equal(scene.hands[0].height, 0);
  scene.update(0.201, input({ mainHand: stone })); assert.ok(Math.abs(scene.hands[0].height - 0.4) < 1e-6);
});

test('active bow and spyglass hide the other hand and spectator/death remove the hand mesh', () => {
  const { scene, removed } = fixture();
  scene.update(0, input({ mainHand: slot('bow'), offHand: slot('stone'), use: true, useTicks: 15 }));
  assert.equal(scene.stats.items, 1);
  scene.update(0.1, input({ mainHand: slot('bow'), offHand: slot('stone'), use: true, useAction: 'scope' })); assert.equal(scene.stats.vertices, 0);
  assert.equal(removed.length, 1);
  scene.update(0.2, input({ state: { gameMode: 3 } })); assert.equal(scene.stats.vertices, 0);
  scene.clear(); scene.update(1, input()); assert.equal(scene.stats.arms, 1); assert.equal(scene.hands[0].height, 1);
});

test('map item uses actual palette tile, native two arms and map tilt instead of item sprite', () => {
  const { scene, uploads } = fixture(); scene.setMaps({ tileForItem: item => item?.itemId === data.itemsByName.filled_map.id ? { tile: 12, backgroundTile: 11 } : null });
  scene.update(0, input({ mainHand: slot('filled_map') }));
  assert.equal(scene.stats.maps, 1); assert.equal(scene.stats.arms, 2); assert.equal(scene.stats.items, 0);
  assert.ok(uploads[0].vertices.some((value, index) => index % 14 === 12 && value === 12));
  assert.ok(uploads[0].vertices.some((value, index) => index % 14 === 12 && value === 11));
  assert.notDeepEqual(mapHandPose({ twoHanded: true, pitch: -1 }).pose.matrix, mapHandPose({ twoHanded: true, pitch: 0 }).pose.matrix);
});

test('camera-relative hand mesh preserves fractional geometry at native world borders', () => {
  const first = fixture(), second = fixture(), far = [29999000.375, -43.5, -29999980.625], near = [far[0] % 256, far[1], ((far[2] % 256) + 256) % 256];
  first.scene.update(0, input({ eye: far, yaw: 0.9, pitch: 0.3 })); second.scene.update(0, input({ eye: near, yaw: 0.9, pitch: 0.3 }));
  const a = first.uploads[0], b = second.uploads[0]; assert.deepEqual(a.vertices, b.vertices); assert.ok(a.format.origin[0] > 29998000);
  for (let index = 0; index < a.vertices.length; index += 14) { assert.ok(Math.abs(Math.hypot(...a.vertices.slice(index + 3, index + 6)) - 1) < 1e-5); assert.equal(a.vertices[index + 13] & 512, 512); }
});

test('native arm, item and map meshes preserve all axes before Float32 at extreme custom heights', () => {
  for (const kind of ['arm', 'item', 'map']) for (const y of [0, -2_000_000_000, 2_000_000_000]) for (const [x, z] of [[0, 0], [29_999_000.375, -29_999_980.625]]) {
    const far = fixture(), near = fixture(), eye = [x, y + 1.625, z], localEye = eye.map(value => value - Math.floor(value / 256) * 256);
    if (kind === 'map') for (const entry of [far, near]) entry.scene.setMaps({ tileForItem: item => item?.itemId === data.itemsByName.filled_map.id ? { tile: 12, backgroundTile: 11 } : null });
    const mainHand = kind === 'arm' ? empty : slot(kind === 'map' ? 'filled_map' : 'diamond_sword');
    const options = { mainHand, yaw: .9, pitch: .3, swingProgress: .2 };
    far.scene.update(0, input({ ...options, eye })); near.scene.update(0, input({ ...options, eye: localEye }));
    const a = far.uploads[0], b = near.uploads[0]; assert.deepEqual(a.vertices, b.vertices, `${kind} at ${eye} lost native sub-block geometry`);
    assert.deepEqual(a.format.origin, eye.map((value, axis) => value - localEye[axis]));
    for (const bound of ['min', 'max']) for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(a.bounds[bound][axis] - a.format.origin[axis] - b.bounds[bound][axis]) < 5e-7);
    const uploads = far.scene.stats.uploads; far.scene.update(.01, input({ ...options, eye })); assert.equal(far.scene.stats.uploads, uploads, 'Stationary extreme-height geometry must reuse its upload');
    assert.equal(far.scene.stats[kind === 'arm' ? 'arms' : kind === 'map' ? 'maps' : 'items'], 1);
  }
});

test('explicit left-hand display entries mirror the native translation and Y/Z angles once', () => {
  const { scene } = fixture(), pose = new HandPose(), vertices = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1]);
  scene.library.get = () => ({ parts: [{ vertices, tile: 0, flags: 32 }], display: { firstperson_lefthand: { rotation: [10, 30, 40], translation: [2, 3, 4], scale: [1, 1, 1] } } });
  scene.item({ position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, pose, slot('diamond_sword'), -1, {});
  const expected = new HandPose().translate(-2 / 16, 3 / 16, 4 / 16).rotate('x', 10).rotate('y', -30).rotate('z', -40);
  assert.deepEqual(pose.position, expected.position); assert.deepEqual(pose.matrix, expected.matrix);
});

test('offhand eating moves its item while the confirmed main-hand block pose stays unchanged', () => {
  const { scene, uploads } = fixture(), main = slot('stone'), off = slot('apple');
  scene.update(0, input({ mainHand: main, offHand: off })); scene.update(.1, input({ mainHand: main, offHand: off, use: true, useHand: 1, useTicks: 16 }));
  assert.equal(scene.stats.items, 2); assert.deepEqual(uploads[0].vertices.slice(0, 36 * 14), uploads[1].vertices.slice(0, 36 * 14));
  assert.notDeepEqual(uploads[0].vertices.slice(36 * 14), uploads[1].vertices.slice(36 * 14));
});

test('block item templates retain fixed biome defaults and per-face colors', () => {
  const { atlas, materials } = fixture(), source = new Float32Array([0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 32, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 32, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 32]);
  materials.set(data.blocksByName.oak_leaves.defaultState, { templateVertices: source, templateTintKinds: new Uint8Array([2, 2, 2]), flags: 32 });
  const library = new ItemMeshLibrary({ registry, atlas, materials }); assert.deepEqual(library.get(slot('oak_leaves')).parts[0].tint, defaultBiomeTint(2));
  assert.ok(library.get(slot('oak_leaves')).parts[0].tint[1] > library.get(slot('oak_leaves')).parts[0].tint[0]);
});

test('custom three-dimensional item elements resolve inherited block models and rotated UVs', () => {
  const { atlas } = fixture(); atlas.tileByName = new Map([['minecraft:block/stone', 0]]); atlas.blockModels = new Map([['minecraft:block/fixture', { textures: { all: 'block/stone' }, elements: [{ from: [4, 0, 4], to: [12, 16, 12], rotation: { axis: 'z', origin: [8, 8, 8], angle: 22.5, rescale: true }, faces: { south: { texture: '#all', rotation: 90 }, north: { texture: '#all' } } }] }]]);
  atlas.itemModels.set('minecraft:diamond_sword', { parent: 'minecraft:block/fixture' });
  const library = new ItemMeshLibrary({ registry, atlas }), mesh = library.get(slot('diamond_sword'));
  assert.equal(mesh.parts[0].vertices.length / 8, 12); assert.ok(mesh.parts[0].vertices[0] !== -.25, 'element rotation applies to geometry');
  assert.equal(mesh.parts[0].tile, 0); assert.ok(library.cacheBytes > 0); library.setAssets(atlas); assert.equal(library.cacheBytes, 0);
});

test('shield and in-hand trident use the sourced native entity models and actual texture sheets', () => {
  const { atlas } = fixture(); atlas.entityTiles.set('minecraft:entity/shield_base_nopattern', 4); atlas.entityTiles.set('minecraft:entity/trident', 5);
  atlas.itemModels.set('minecraft:shield', { parent: 'builtin/entity' }); atlas.itemModels.set('minecraft:trident_in_hand', { parent: 'builtin/entity' });
  const library = new ItemMeshLibrary({ registry, atlas }); const shield = library.get(slot('shield'), { displayContext: 'firstperson' }), trident = library.get(slot('trident'), { displayContext: 'firstperson' });
  assert.equal(shield.parts.reduce((sum, part) => sum + part.vertices.length / 8, 0), 72, 'plate and handle native cuboids');
  assert.equal(shield.parts[0].tile, 4); assert.equal(trident.parts[0].tile, 5); assert.ok(trident.parts.reduce((sum, part) => sum + part.vertices.length / 8, 0) >= 4 * 36);
  for (const part of [...shield.parts, ...trident.parts]) for (let triangle = 0; triangle < part.vertices.length; triangle += 24) {
    const a = part.vertices.slice(triangle, triangle + 3), b = part.vertices.slice(triangle + 8, triangle + 11), c = part.vertices.slice(triangle + 16, triangle + 19), ab = b.map((v, axis) => v - a[axis]), ac = c.map((v, axis) => v - a[axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], normal = part.vertices.slice(triangle + 3, triangle + 6); assert.ok(cross.reduce((sum, v, axis) => sum + v * normal[axis], 0) > 0);
  }
});

test('charged crossbows derive their actual projectile and hand visibility from confirmed NBT', () => {
  const bow = { ...slot('crossbow'), nbtData: { type: 'compound', value: { Charged: { type: 'byte', value: 1 }, ChargedProjectiles: { type: 'list', value: { type: 'compound', value: [{ id: { type: 'string', value: 'minecraft:firework_rocket' } }] } } } } };
  assert.deepEqual(crossbowProperties(bow), { charged: 1, firework: 1 });
  const { scene, atlas } = fixture(); atlas.itemTiles.set('minecraft:item/crossbow', 0);
  scene.update(0, input({ mainHand: bow, offHand: slot('stone') })); assert.equal(scene.stats.items, 1, 'charged main crossbow hides the idle offhand');
  scene.clear(); scene.update(1, input({ mainHand: slot('apple'), offHand: bow, use: true, useHand: 0 })); assert.equal(scene.stats.items, 1, 'using main-hand food hides a charged offhand crossbow');
});
