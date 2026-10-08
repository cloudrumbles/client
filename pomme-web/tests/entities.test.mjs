import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { EntityScene, buildEntityPreview } from '../src/entities.js';
import { previewEntityData } from '../src/entity-preview.js';
import { defaultPlayerSkin, normalizePlayerSkin, profileSkin, PlayerSkinCache } from '../src/entity-skins.js';
import { bakedEntityModel, entityModelNames } from '../src/entity-models.js';
import { rgbaPNG, textureProfile } from './entity-fixtures.mjs';
import { advanceEntityAnimation } from '../src/entity-animation-state.js';
import { droppedItemCopies } from '../src/entity-item-rendering.js';
import { entityLightFlags, entityLightProbe } from '../src/entity-lighting.js';

const data = minecraftData('1.20.4');
const registry = { entities: data.entitiesArray, items: data.itemsArray, blocks: data.blocksArray };

function scene(options = {}) {
  const uploads = [], removals = [];
  const renderer = {
    uploadDynamicMesh(key, opaque, water, bounds, format) { uploads.push({ key, opaque: opaque.slice(), water: water.slice(), bounds, format }); },
    removeMesh(key) { removals.push(key); },
  };
  return { scene: new EntityScene({ renderer, registry, ...options }), uploads, removals };
}
function entity(name, id = 1, overrides = {}) { return { id, uuid: `entity-${id}`, entityType: data.entitiesByName[name].id, x: -31, y: -20, z: 48, yaw: Math.PI / 2, pitch: 0, metadata: [], ...overrides }; }
function worldPoint(upload, index) { return Array.from(upload.opaque.slice(index, index + 3), (value, axis) => value + upload.format.origin[axis]); }

test('only server entity events produce geometry, and server removals dispose the dynamic batch', () => {
  const { scene: visual, uploads, removals } = scene();
  visual.update(0, [-31, -19, 52]); assert.equal(uploads.length, 0);
  visual.consume({ type: 'spawn', entity: entity('pig') });
  visual.update(0.1, [-31, -19, 52]);
  assert.equal(visual.stats.visible, 1); assert.ok(uploads[0].opaque.length > 0); assert.equal(uploads[0].water.length, 0);
  assert.equal(uploads[0].format.stride, 14); assert.equal(uploads[0].key, '__minecraft_entities');
  visual.consume({ type: 'remove', id: 1 }); visual.update(0.2, [-31, -19, 52]);
  assert.deepEqual(removals, ['__minecraft_entities']); assert.equal(visual.stats.vertices, 0);
  assert.equal(visual.stats.dynamicShadows, false);
});

test('packet positions interpolate over 75ms with shortest-angle interpolation and teleport snapping', () => {
  const { scene: visual } = scene();
  visual.update(1, [0, 2, 0]);
  visual.consume({ type: 'spawn', entity: entity('player', 7, { x: 0, y: 0, z: 5, yaw: Math.PI * 1.98 }) });
  visual.consume({ type: 'update', entity: entity('player', 7, { x: 1, y: 0, z: 5, yaw: Math.PI * 0.02 }) });
  const track = visual.entities.get(7), middle = visual.sample(track, 1.0375);
  assert.ok(Math.abs(middle.x - 0.5) < 1e-6);
  assert.ok(Math.abs(middle.yaw - Math.PI * 2) < 1e-6, 'rotation crosses the short side of 2π');
  assert.equal(visual.sample(track, 1.1).x, 1);
  visual.update(1.1, [0, 2, 0]);
  visual.consume({ type: 'update', entity: entity('player', 7, { x: 50, y: 0, z: 5, yaw: 0 }) });
  assert.equal(visual.sample(track, 1.1).x, 50, 'large server teleports should snap');
});

test('every articulated box has finite unit normals and outward triangle winding', () => {
  for (const name of ['player', 'creeper', 'zombie', 'skeleton', 'pig', 'cow', 'spider', 'boat', 'bee', 'slime', 'item']) {
    const { scene: visual, uploads } = scene();
    visual.consume({ type: 'spawn', entity: entity(name, 1, { pitch: 0.2, headYaw: Math.PI * 0.7, ...(name === 'item' ? { metadata: [{ key: 8, value: { present: true, itemId: data.itemsByName.stone.id, itemCount: 1 } }] } : {}) }) });
    visual.update(0.1, [-31, -19, 52]);
    const vertices = uploads[0].opaque;
    assert.equal(vertices.length % 42, 0, name);
    for (let triangle = 0; triangle < vertices.length; triangle += 42) {
      const a = vertices.slice(triangle, triangle + 3), b = vertices.slice(triangle + 14, triangle + 17), c = vertices.slice(triangle + 28, triangle + 31);
      const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
      const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const normal = vertices.slice(triangle + 3, triangle + 6);
      assert.ok(cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) > 0, `${name} triangle ${triangle / 42} winding`);
      assert.ok(Math.abs(Math.hypot(...normal) - 1) < 1e-5, `${name} normal`);
    }
    assert.ok(Array.from(vertices).every(Number.isFinite), name);
  }
});

test('models preserve fractional detail at large and negative native world coordinates', () => {
  const { scene: visual, uploads } = scene();
  const x = 29999000.375, y = -43.5, z = -29999980.625;
  visual.consume({ type: 'spawn', entity: entity('player', 1, { x, y, z, yaw: 0 }) });
  visual.update(0.1, [x, y + 1.62, z + 4]);
  const upload = uploads[0];
  assert.ok(upload.format.origin[0] > 29998000); assert.ok(upload.format.origin[2] < -29999000);
  assert.ok(upload.bounds.min[0] < x && upload.bounds.max[0] > x);
  const point = worldPoint(upload, 0);
  assert.ok(Math.abs(point[0] - (x + 4 / 16 * 0.9375)) < 0.001);
  assert.ok(upload.bounds.max[1] - upload.bounds.min[1] > 1.7);
});

test('distance, frustum, invisible metadata and tracking caps bound entity rendering', () => {
  const { scene: visual, uploads } = scene({ maxVisible: 2, maxTracked: 3, maxDistance: 20 });
  visual.update(0, [0, 1.5, 0]);
  for (let id = 1; id <= 8; id++) visual.consume({ type: 'spawn', entity: entity('pig', id, { x: 0, y: 0, z: id * 2, yaw: 0 }) });
  assert.equal(visual.entities.size, 3);
  visual.update(0.1, [0, 1.5, 0], { direction: [0, 0, 1], fov: Math.PI / 2, aspect: 1 });
  assert.equal(visual.stats.visible, 2);
  visual.update(0.2, [0, 1.5, 0], { direction: [0, 0, -1], fov: Math.PI / 2, aspect: 1 });
  assert.equal(visual.stats.visible, 0);
  visual.clear();
  visual.consume({ type: 'spawn', entity: entity('zombie', 4, { x: 0, y: 0, z: 3, metadata: [{ key: 0, type: 0, value: 32 }] }) });
  visual.update(0.3, [0, 1.5, 0]); assert.equal(visual.stats.visible, 0);
  assert.equal(uploads.length, 1);
});

test('block item entities use user-imported material tiles and still use the real item ID', () => {
  const stone = data.blocksByName.stone.defaultState, itemId = data.itemsByName.stone.id;
  const materials = new Map([[stone, { faces: { up: { tile: 17 } } }]]);
  const { scene: visual, uploads } = scene({ materials });
  visual.consume({ type: 'spawn', entity: entity('item', 1, { metadata: [{ key: 8, type: 7, value: { present: true, itemId, itemCount: 32 } }] }) });
  visual.update(0.1, [-31, -19, 52]);
  assert.equal(uploads[0].opaque[12], 17);
  visual.clear(); assert.equal(visual.entities.size, 0); assert.equal(visual.stats.visible, 0);
});

test('static entities reuse the previous dynamic mesh and animated entities upload at most 30Hz', () => {
  const { scene: visual, uploads } = scene();
  visual.consume({ type: 'spawn', entity: entity('creeper') });
  visual.update(0.1, [-31, -19, 52]);
  visual.update(0.2, [-31, -19, 52]); visual.update(0.3, [-31, -19, 52]);
  assert.equal(uploads.length, 1);
  visual.consume({ type: 'spawn', entity: entity('item', 2, { metadata: [{ key: 8, value: { present: true, itemId: data.itemsByName.stone.id, itemCount: 1 } }] }) });
  visual.update(0.4, [-31, -19, 52]);
  const before = uploads.length;
  for (let i = 1; i <= 10; i++) visual.update(0.4 + i / 600, [-31, -19, 52]);
  assert.equal(uploads.length, before);
  visual.update(0.45, [-31, -19, 52]); assert.equal(uploads.length, before + 1);
});

test('entity picking uses actual collision boxes and nearest live server ID at negative coordinates', () => {
  const { scene: visual } = scene();
  visual.consume({ type: 'spawn', entity: entity('zombie', 41, { x: -30, y: -20, z: 48 }) });
  visual.consume({ type: 'spawn', entity: entity('zombie', 42, { x: -30, y: -20, z: 50 }) });
  const pick = visual.pick([-30, -18.5, 53], [0, 0, -1], 5);
  assert.equal(pick.entityId, 42); assert.ok(Math.abs(pick.distance - 2.7) < 1e-5);
  assert.ok(Math.abs(pick.localPoint[2] - 0.3) < 1e-5);
  assert.equal(visual.pick([-35, -18.5, 53], [0, 0, -1], 5), null);
  assert.equal(visual.pick([-30, -18.5, 53], [0, 0, -1], 2), null);
  visual.consume({ type: 'remove', id: 42 });
  assert.equal(visual.pick([-30, -18.5, 53], [0, 0, -1], 6).entityId, 41);
});

test('native imported entity sheets use Minecraft cuboid UV rectangles rather than stretching a full sheet', () => {
  const paths = new Map([['player', 'player/wide/steve'], ['zombie', 'zombie/zombie'], ['skeleton', 'skeleton/skeleton'], ['creeper', 'creeper/creeper'], ['pig', 'pig/pig'], ['cow', 'cow/cow'], ['sheep', 'sheep/sheep']]);
  for (const [name, path] of paths) {
    const atlas = { entityTiles: new Map([[`minecraft:entity/${path}`, 1], ['minecraft:entity/sheep/sheep_fur', 2]]), tiles: [{}, { width: 64, height: name === 'player' || name === 'zombie' ? 64 : 32 }, { width: 64, height: 32 }] };
    const { scene: visual, uploads } = scene({ atlas });
    visual.consume({ type: 'spawn', entity: entity(name, 1, { yaw: 0 }) }); visual.update(0.1, [-31, -19, 52]);
    const vertices = uploads[0].opaque;
    assert.equal(vertices[12], 1, name);
    assert.equal(visual.stats.texturedModels, 1); assert.equal(visual.stats.fallbackModels, 0);
    for (let index = 0; index < vertices.length; index += 14) {
      assert.ok(vertices[index + 10] >= 0 && vertices[index + 10] <= 1, `${name} U range`);
      assert.ok(vertices[index + 11] >= 0 && vertices[index + 11] <= 1, `${name} V range`);
    }
    if (name === 'player') {
      const front = Array.from({ length: 36 }, (_, index) => index * 14).filter(index => vertices[index + 5] > 0.99);
      const valuesU = front.map(index => vertices[index + 10]), valuesV = front.map(index => vertices[index + 11]);
      assert.equal(Math.min(...valuesU), 8 / 64, 'Steve head front left U');
      assert.equal(Math.max(...valuesU), 16 / 64, 'Steve head front right U');
      assert.equal(Math.max(...valuesV), 16 / 64, 'Steve head front bottom V');
      assert.ok(Array.from(vertices).some((value, index) => index % 14 === 11 && value >= 48 / 64), '64×64 player left limbs use lower sheet region');
    }
    if (name === 'sheep') assert.ok(Array.from(vertices).some((value, index) => index % 14 === 12 && value === 2), 'sheep fur uses separate native sheet');
  }
});

test('every exported native model has a valid hierarchy and bounded normalized texture coordinates', () => {
  assert.ok(entityModelNames().length >= 45);
  for (const name of entityModelNames()) {
    const model = bakedEntityModel(name);
    for (let index = 0; index < model.parts.length; index++) {
      const part = model.parts[index];
      assert.ok(part.parent === null || part.parent < index, `${name}/${part.name} parent`);
      for (const geometry of part.geometry) for (let vertex = 0; vertex < geometry.length; vertex += 8) {
        assert.ok(Array.from(geometry.subarray(vertex, vertex + 8)).every(Number.isFinite), `${name}/${part.name}`);
        assert.ok(geometry[vertex + 6] >= 0 && geometry[vertex + 6] <= 1, `${name}/${part.name} U ${geometry[vertex + 6]}`);
        assert.ok(geometry[vertex + 7] >= 0 && geometry[vertex + 7] <= 1, `${name}/${part.name} V ${geometry[vertex + 7]}`);
      }
    }
  }
});

test('the first-person local avatar cannot cover the camera or intercept attack picking', () => {
  const { scene: visual, uploads } = scene();
  visual.consume({ type: 'spawn', entity: entity('player', 11, { x: 0, y: 0, z: 0 }) });
  visual.consume({ type: 'spawn', entity: entity('player', 12, { x: 0, y: 0, z: -2 }) });
  visual.update(.1, [0, 1.6, 0], { entityId: 11 });
  assert.equal(visual.stats.visible, 1); assert.equal(visual.pick([0, 1, 0], [0, 0, -1], 5)?.entityId, 12);
  visual.update(.2, [0, 1.6, 0], { entityId: 11, thirdPerson: true }); assert.equal(visual.stats.visible, 2);
  assert.equal(uploads.length, 2); visual.clear(); assert.equal(visual.localEntityId, null);
});

test('original Nether and aquatic models render their native parts, scales and metadata textures', () => {
  const paths = { ghast: 'ghast/ghast', blaze: 'blaze', guardian: 'guardian', elder_guardian: 'guardian_elder', endermite: 'endermite', silverfish: 'silverfish', magma_cube: 'slime/magmacube', wither: 'wither/wither' };
  for (const [name, path] of Object.entries(paths)) {
    const atlas = { entityTiles: new Map([[`minecraft:entity/${path}`, 0], ['minecraft:entity/ghast/ghast_shooting', 1], ['minecraft:entity/wither/wither_invulnerable', 2]]), tiles: [{ width: 64, height: ['guardian', 'elder_guardian', 'wither'].includes(name) ? 64 : 32 }, { width: 64, height: 32 }, { width: 64, height: 64 }] };
    const { scene: visual, uploads } = scene({ atlas }); visual.consume({ type: 'spawn', entity: entity(name) }); visual.update(.1, [-31, -19, 52]);
    assert.equal(visual.stats.nativeModels, 1, name); assert.equal(visual.stats.approximateModels, 0, name); assert.ok(visual.stats.vertices >= 144, name);
    const before = uploads.at(-1).opaque.slice();
    if (name !== 'magma_cube') { visual.update(.3, [-31, -19, 52]); assert.notDeepEqual(uploads.at(-1).opaque, before, `${name} native idle motion`); }
    if (name === 'ghast') { assert.ok(uploads[0].bounds.max[0] - uploads[0].bounds.min[0] >= 4.49); const actor = entity(name, 1, { metadata: [{ key: data.entitiesByName[name].metadataKeys.indexOf('is_charging'), value: true }] }); visual.consume({ type: 'update', entity: actor }); visual.update(.4, [-31, -19, 52]); assert.equal(uploads.at(-1).opaque[12], 1); }
    if (name === 'wither') { const actor = entity(name, 1, { metadata: [{ key: data.entitiesByName[name].metadataKeys.indexOf('inv'), value: 220 }] }); visual.consume({ type: 'update', entity: actor }); visual.update(.4, [-31, -19, 52]); assert.equal(uploads.at(-1).opaque[12], 2); assert.ok(uploads.at(-1).bounds.max[0] - uploads.at(-1).bounds.min[0] < uploads[0].bounds.max[0] - uploads[0].bounds.min[0]); }
    for (let i = 0; i < before.length; i += 14) assert.ok(Math.abs(Math.hypot(before[i + 3], before[i + 4], before[i + 5]) - 1) < 1e-5, `${name} normal`);
  }
  assert.deepEqual(bakedEntityModel('ghast').parts.slice(1).map(part => part.cubes[0].size[1]), [8, 13, 9, 11, 11, 10, 12, 9, 12], 'source Java Random seed 1660 tentacle lengths');
});

test('native cosmetic tick state is independent of render frequency and follows slime landing transitions', () => {
  const track = name => ({ definition: { name }, entity: { id: 1, onGround: true } });
  const fast = track('guardian'), slow = track('guardian'); advanceEntityAnimation(fast, 0); advanceEntityAnimation(slow, 0);
  for (let i = 1; i <= 120; i++) advanceEntityAnimation(fast, i / 60); const actual = advanceEntityAnimation(slow, 2); assert.deepEqual(advanceEntityAnimation(fast, 2), actual);
  assert.ok(actual.spikes > .8); const moving = advanceEntityAnimation(slow, 3, { moving: true }); assert.ok(moving.spikes < actual.spikes); assert.ok(moving.tail > actual.tail);
  const slime = track('slime'); advanceEntityAnimation(slime, 0); slime.entity.onGround = false;
  advanceEntityAnimation(slime, .05); assert.equal(slime.animationState.targetSquish, .6); assert.equal(advanceEntityAnimation(slime, .1).squish, .3);
  slime.entity.onGround = true; advanceEntityAnimation(slime, .15); assert.equal(slime.animationState.targetSquish, -.3);
  const magma = track('magma_cube'); advanceEntityAnimation(magma, 0); magma.entity.onGround = false; advanceEntityAnimation(magma, .05); assert.equal(magma.animationState.targetSquish, .9);
  const wither = track('wither'); advanceEntityAnimation(wither, 0); const heads = advanceEntityAnimation(wither, .05, { sideHeads: [{ yaw: Math.PI, pitch: -Math.PI / 2 }] });
  assert.ok(Math.abs(heads.sideHeads[0].yaw) <= Math.PI / 18 + 1e-12); assert.ok(Math.abs(heads.sideHeads[0].pitch) <= Math.PI * 2 / 9 + 1e-12);
});

test('dropped and equipped items use actual source meshes, native copy thresholds and arm matrices', () => {
  assert.deepEqual([1, 2, 16, 17, 32, 33, 48, 49, 64].map(droppedItemCopies), [1, 2, 2, 3, 3, 4, 4, 5, 5]);
  const pixelsRGBA = new Uint8Array(16 * 16 * 4); for (let y = 2; y < 14; y++) for (let x = 6; x < 10; x++) pixelsRGBA.set([20, 240, 60, 255], (y * 16 + x) * 4);
  const atlas = { width: 16, height: 16, pixelsRGBA, itemTiles: new Map([['minecraft:item/diamond_sword', 0]]), tiles: [{ x: 0, y: 0, width: 16, height: 16 }], itemModels: new Map([['minecraft:diamond_sword', { parent: 'item/handheld', textures: { layer0: 'item/diamond_sword' }, display: { ground: { scale: [.5, .5, .5], translation: [0, 2, 0] }, thirdperson_righthand: { rotation: [0, -90, 55], translation: [0, 4, .5], scale: [.85, .85, .85] } } }]]) };
  const { scene: visual, uploads } = scene({ atlas }); const slot = { present: true, itemId: data.itemsByName.diamond_sword.id, itemCount: 1 }, itemKey = data.entitiesByName.item.metadataKeys.indexOf('item');
  const actor = entity('item', 1, { metadata: [{ key: itemKey, value: slot }] }); visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [-31, -19, 52]); const single = visual.stats.vertices;
  assert.equal(visual.stats.nativeModels, 1); assert.equal(visual.stats.approximateModels, 0); assert.ok(single >= 36);
  visual.consume({ type: 'update', entity: { ...actor, metadata: [{ key: itemKey, value: { ...slot, itemCount: 2 } }] } }); visual.update(.2, [-31, -19, 52]); assert.equal(visual.stats.vertices, single * 2);
  visual.clear(); const player = entity('player', 2, { equipment: [{ slot: 0, item: slot }] }); visual.consume({ type: 'spawn', entity: player }); visual.update(.3, [-31, -19, 52]);
  const equipped = uploads.at(-1).opaque, sword = equipped.filter((_, index) => equipped[Math.floor(index / 14) * 14 + 12] === 0); assert.equal(sword.length / 14, single); assert.equal(visual.stats.equipmentParts, 1);
  visual.consume({ type: 'animation', id: 2, animation: 0 }); visual.update(.45, [-31, -19, 52]); const swung = uploads.at(-1).opaque; assert.notDeepEqual(swung.slice(-sword.length), equipped.slice(-sword.length));
  for (let i = 0; i < swung.length; i += 14) assert.ok(Math.abs(Math.hypot(swung[i + 3], swung[i + 4], swung[i + 5]) - 1) < 1e-5);
});

test('native piglin geometry uses server dance, handedness, tags and the missing zombified ear', () => {
  const { scene: visual, uploads } = scene(); const definition = data.entitiesByName.piglin, key = name => definition.metadataKeys.indexOf(name);
  const actor = entity('piglin', 1, { metadata: [{ key: key('mob_flags'), value: 2 }] }); visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [-31, -19, 52]); const standing = uploads.at(-1).opaque.slice();
  assert.equal(visual.stats.nativeModels, 1); assert.equal(visual.stats.approximateModels, 0); assert.equal(visual.stats.vertices, 16 * 36);
  visual.consume({ type: 'update', entity: { ...actor, metadata: [...actor.metadata, { key: key('is_dancing'), value: true }] } }); visual.update(.2, [-31, -19, 52]); assert.notDeepEqual(uploads.at(-1).opaque, standing);
  visual.consume({ type: 'update', entity: { ...actor, equipment: [{ slot: 1, item: { present: true, itemId: data.itemsByName.gold_ingot.id, itemCount: 1 } }] } }); visual.update(.3, [-31, -19, 52]); const untagged = uploads.at(-1).opaque.slice();
  visual.consume({ type: 'tags', tags: [{ tagType: 'minecraft:item', tags: [{ tagName: 'minecraft:piglin_loved', entries: [data.itemsByName.gold_ingot.id] }] }] }); visual.update(.4, [-31, -19, 52]); assert.notDeepEqual(uploads.at(-1).opaque, untagged);
  visual.clear(); visual.consume({ type: 'spawn', entity: entity('zombified_piglin') }); visual.update(.5, [-31, -19, 52]); assert.equal(visual.stats.vertices, 15 * 36); assert.equal(visual.itemTags.size, 0);
});

test('armor-stand packet poses and flags preserve equipment on an invisible wooden body', () => {
  const atlas = { entityTiles: new Map([['minecraft:entity/armor/diamond_layer_1', 0]]), tiles: [{ width: 64, height: 32 }] }, { scene: visual, uploads } = scene({ atlas });
  const definition = data.entitiesByName.armor_stand, key = name => definition.metadataKeys.indexOf(name), actor = entity('armor_stand');
  visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [-31, -19, 52]); assert.equal(visual.stats.vertices, 8 * 36, 'hidden default arms');
  visual.consume({ type: 'update', entity: { ...actor, metadata: [{ key: key('client_flags'), value: 4 }, { key: key('right_arm_pose'), value: { pitch: -90, yaw: 0, roll: 0 } }] } }); visual.update(.2, [-31, -19, 52]); assert.equal(visual.stats.vertices, 10 * 36);
  const visibleBody = uploads.at(-1).opaque; assert.ok(Array.from(visibleBody).every(Number.isFinite));
  visual.consume({ type: 'update', entity: { ...actor, metadata: [{ key: key('shared_flags'), value: 32 }, { key: key('client_flags'), value: 16 }], equipment: [{ slot: 4, item: { present: true, itemId: data.itemsByName.diamond_chestplate.id, itemCount: 1 } }] } }); visual.update(.3, [-31, -19, 52]);
  assert.equal(visual.stats.visible, 1); assert.equal(visual.stats.vertices, 3 * 36, 'only received chest armor remains visible'); assert.equal(visual.pick([-31, -19, 52], [0, 0, -1], 8), null, 'marker cannot intercept picking');
  const saved = previewEntityData({ Small: true, ShowArms: true, NoBasePlate: true, Marker: true, Pose: { Head: [15, 20, 30] } }, definition, registry);
  assert.equal(saved.metadata.find(entry => entry.key === key('client_flags')).value, 29); assert.deepEqual(saved.metadata.find(entry => entry.key === key('head_pose')).value, [15, 20, 30]);
});

test('guardian fluid animation uses the world hook as native block coordinates', () => {
  const { scene: visual } = scene(); let calls = 0;
  visual.consume({ type: 'spawn', entity: entity('guardian') });
  const inWaterAt = position => { assert.deepEqual(position, [-31, -20, 48]); calls++; return false; };
  visual.update(.1, [-31, -19, 52], { inWaterAt }); visual.update(.2, [-31, -19, 52], { inWaterAt }); assert.equal(visual.entities.get(1).animationState.tailSpeed, 2); assert.equal(calls, 2);
  visual.clear(); visual.consume({ type: 'spawn', entity: entity('pig') }); visual.update(.3, [-31, -19, 52], { inWaterAt: () => { throw new Error('non-aquatic actor requested water state'); } });
});

test('native entity light changes update only packed nibbles and unchanged caves reuse the batch', () => {
  let light = { sky: 0, block: 0 }, probes = [];
  const { scene: visual, uploads } = scene({ getLight: position => { probes.push(position); return light; } });
  const actor = entity('player'); visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [-31, -19, 52]); const cave = uploads[0].opaque.slice();
  assert.deepEqual(probes[0], [-31, -18.38, 48]); assert.equal(cave[13] & 512, 512); assert.equal((cave[13] >> 10) & 15, 0); assert.equal((cave[13] >> 14) & 15, 0);
  visual.update(.2, [-31, -19, 52]); assert.equal(uploads.length, 1);
  light = { sky: 0, block: 14 }; visual.update(.3, [-31, -19, 52]); const torch = uploads[1].opaque; assert.equal((torch[13] >> 14) & 15, 14);
  for (let i = 0; i < torch.length; i++) if (i % 14 !== 13) assert.equal(torch[i], cave[i], 'lighting changes preserve all position, normal, material and texture data');
  visual.update(.4, [-31, -19, 52]); assert.equal(uploads.length, 2);
  const definition = data.entitiesByName.player, track = { entity: { ...actor, metadata: [{ key: definition.metadataKeys.indexOf('pose'), value: 5 }] }, definition };
  assert.deepEqual(entityLightProbe(track, { x: 0, y: 10, z: 0 }), [0, 11.27, 0]);
  const blaze = { definition: data.entitiesByName.blaze, entity: entity('blaze') }; assert.equal((entityLightFlags(blaze, { x: 0, y: 0, z: 0 }, () => ({ sky: 0, block: 0 })) >> 14) & 15, 15);
});

test('player profiles use Java UUID default selection and accept only bounded Mojang texture URLs', () => {
  assert.deepEqual(defaultPlayerSkin('00000000-0000-0000-0000-000000000000'), { path: 'minecraft:entity/player/slim/alex', slim: true });
  assert.deepEqual(defaultPlayerSkin('00000000-0000-0000-0000-000000000009'), { path: 'minecraft:entity/player/wide/alex', slim: false });
  assert.deepEqual(defaultPlayerSkin('ffffffff-0000-0000-0000-000000000000'), { path: 'minecraft:entity/player/wide/zuri', slim: false });
  const hash = 'abc123'.repeat(10) + 'abcd';
  const player = textureProfile('uuid', `http://textures.minecraft.net/texture/${hash}`, true);
  assert.deepEqual(profileSkin(player), { url: `https://textures.minecraft.net/texture/${hash}`, slim: true });
  for (const url of [`https://textures.minecraft.net.evil.test/texture/${hash}`, `https://evil.test/texture/${hash}`, `https://textures.minecraft.net:4433/texture/${hash}`, `https://user@textures.minecraft.net/texture/${hash}`, `https://textures.minecraft.net/texture/${hash}?x=y`, `https://textures.minecraft.net/other/${hash}`, 'file:///tmp/skin.png', 'data:image/png,invalid']) assert.equal(profileSkin(textureProfile('uuid', url)), null, url);
  assert.equal(profileSkin({ properties: [{ name: 'textures', value: 'e'.repeat(33000) }] }), null);
});

test('legacy player sheets mirror left limbs, preserve the transparency hack, and force base-body alpha', () => {
  const source = new Uint8Array(64 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) source.set([x, y, 19, 255], (y * 64 + x) * 4);
  const image = normalizePlayerSkin({ width: 64, height: 32, pixelsRGBA: source });
  const pixel = (x, y) => Array.from(image.pixelsRGBA.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  assert.deepEqual(pixel(20, 48), [7, 16, 19, 255]);
  assert.deepEqual(pixel(23, 48), [4, 16, 19, 255]);
  assert.deepEqual(pixel(36, 48), [47, 16, 19, 255]);
  assert.equal(pixel(32, 0)[3], 0, 'fully opaque old hat backgrounds become transparent');
  assert.equal(pixel(40, 20)[3], 255, 'base arm remains opaque after legacy hat cleanup');
  assert.equal(pixel(0, 48)[3], 0, 'unused sleeve overlay remains transparent');
  assert.equal(source[(32 * 4) + 3], 255, 'source bytes remain owned by their caller');
  assert.throws(() => normalizePlayerSkin({ width: 32, height: 32, pixelsRGBA: new Uint8Array(4096) }), /64×32/);
});

test('account skin fetches are deduplicated, bounded, and append the true RGBA pixels once', async () => {
  const pixels = new Uint8Array(64 * 64 * 4); for (let pixel = 0; pixel < pixels.length; pixel += 4) pixels.set([193, 38, 12, 255], pixel);
  const bytes = rgbaPNG(64, 64, pixels), hash = 'a'.repeat(64), calls = [], uploads = [];
  const cache = new PlayerSkinCache({ maxSkins: 1, fetchSkin: async (url, options) => { calls.push({ url, options }); return { ok: true, headers: new Map(), arrayBuffer: async () => bytes.buffer }; }, appendTile: image => { uploads.push(image); return { id: 19 }; } });
  const profile = textureProfile('1', `https://textures.minecraft.net/texture/${hash}`, true);
  const pending = cache.request(profile); cache.request(profile);
  await pending.promise;
  const ready = cache.request(profile);
  assert.equal(ready.state, 'ready'); assert.equal(ready.tile, 19); assert.equal(ready.slim, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(uploads.length, 1); assert.deepEqual(uploads[0].pixelsRGBA, pixels);
  assert.equal(cache.request(textureProfile('2', `https://textures.minecraft.net/texture/${'b'.repeat(64)}`)), null);
  cache.clear(); assert.equal(cache.skins.size, 0);
});

test('player outer layers obey customization bits and actual slim profiles change arm widths', () => {
  const atlas = { entityTiles: new Map([['minecraft:entity/player/wide/steve', 1], ['minecraft:entity/player/slim/alex', 2]]), tiles: [{}, { width: 64, height: 64 }, { width: 64, height: 64 }] };
  const definition = data.entitiesByName.player, customization = definition.metadataKeys.indexOf('player_mode_customisation');
  const { scene: visual, uploads } = scene({ atlas });
  visual.consume({ type: 'spawn', entity: entity('player', 1, { uuid: '00000000-0000-0000-0000-000000000009', yaw: 0, metadata: [{ key: customization, value: 0 }] }) });
  visual.update(0.1, [-31, -19, 52]); const base = uploads.at(-1);
  assert.equal(base.opaque.length / 14, 6 * 36, 'six body cuboids without any outer layers');
  visual.consume({ type: 'update', entity: entity('player', 1, { uuid: '00000000-0000-0000-0000-000000000009', yaw: 0, metadata: [{ key: customization, value: 127 }] }) });
  visual.update(0.2, [-31, -19, 52]); assert.equal(uploads.at(-1).opaque.length / 14, 12 * 36, 'six separate body overlay cuboids');
  const wide = bakedEntityModel('player'), slim = bakedEntityModel('player_slim');
  assert.equal(wide.parts.find(part => part.name === 'left_arm').cubes[0].size[0], 4);
  assert.equal(slim.parts.find(part => part.name === 'left_arm').cubes[0].size[0], 3);
});

test('equipped armor, leather dye and held item sprites follow authoritative equipment slots', () => {
  const atlas = { entityTiles: new Map([['minecraft:entity/player/wide/steve', 1], ['minecraft:entity/armor/diamond_layer_1', 2], ['minecraft:entity/armor/leather_layer_2', 3], ['minecraft:entity/armor/leather_layer_2_overlay', 4]]), itemTiles: new Map([['minecraft:item/diamond_sword', 5]]), tiles: [{}, { width: 64, height: 64 }] };
  const { scene: visual, uploads } = scene({ atlas });
  const item = name => ({ present: true, itemId: data.itemsByName[name].id, itemCount: 1 });
  const equipment = [{ slot: 0, item: item('diamond_sword') }, { slot: 4, item: item('diamond_chestplate') }, { slot: 3, item: { ...item('leather_leggings'), nbtData: { type: 'compound', value: { display: { type: 'compound', value: { color: { type: 'int', value: 0xff0000 } } } } } } }];
  visual.consume({ type: 'spawn', entity: entity('player', 1, { yaw: 0, equipment }) }); visual.update(0.1, [-31, -19, 52]);
  const vertices = uploads[0].opaque, ids = new Set(Array.from(vertices).filter((_, index) => index % 14 === 12));
  assert.equal(visual.stats.equipmentParts, 3);
  for (const id of [2, 3, 4, 5]) assert.ok(ids.has(id), `equipment tile ${id}`);
  const leggings = Array.from({ length: vertices.length / 14 }, (_, index) => index * 14).find(index => vertices[index + 12] === 3);
  assert.deepEqual(Array.from(vertices.subarray(leggings + 6, leggings + 9)), [1, 0, 0]);
  visual.consume({ type: 'update', entity: entity('player', 1, { yaw: 0, equipment: [] }) }); visual.update(0.2, [-31, -19, 52]);
  assert.equal(visual.stats.equipmentParts, 0);
});

test('spawner previews use saved entity variants, baby transforms and authoritative NBT equipment', () => {
  const definition = data.entitiesByName.sheep, saved = previewEntityData({ Age: -1, Color: 14, Sheared: true, ArmorItems: [{}, {}, { id: 'minecraft:diamond_chestplate', Count: 1 }] }, definition, registry);
  const value = name => saved.metadata.find(entry => entry.key === definition.metadataKeys.indexOf(name))?.value;
  assert.equal(value('baby'), true); assert.equal(value('wool'), 14 | 16); assert.equal(saved.equipment[2].item.itemId, data.itemsByName.diamond_chestplate.id);
  const adult = buildEntityPreview({ name: 'minecraft:pig' }, { registry }), young = buildEntityPreview({ name: 'minecraft:pig', nbt: { Age: -1 } }, { registry });
  const size = vertices => { const x = Array.from({ length: 36 }, (_, index) => vertices[index * 14]); return Math.max(...x) - Math.min(...x); };
  assert.equal(size(adult.vertices), size(young.vertices), 'native pig baby retains the unscaled head');
  assert.ok(young.bounds.max[1] - young.bounds.min[1] < adult.bounds.max[1] - adult.bounds.min[1]);
  assert.equal(young.source, 'block-entity-preview'); assert.equal(buildEntityPreview({ name: 'minecraft:missing' }, { registry }), null);
  const explicit = buildEntityPreview({ name: 'pig', nbt: { Age: -1 }, metadata: [{ key: data.entitiesByName.pig.metadataKeys.indexOf('baby'), value: false }] }, { registry });
  assert.deepEqual(explicit.vertices, adult.vertices, 'explicit actor metadata takes precedence over saved values');
});

test('preview mesh origins preserve original model detail without registering a network entity', () => {
  const origin = [29998848, 0, -30000128], position = [29999000.375, -43.5, -29999980.625];
  const far = buildEntityPreview({ name: 'zombie', position, origin, scale: .4 }, { registry });
  const near = buildEntityPreview({ name: 'zombie', position: position.map((value, axis) => value - origin[axis]), scale: .4 }, { registry });
  assert.deepEqual(far.vertices, near.vertices); assert.deepEqual(far.bounds, near.bounds);
});

test('native item frames use actual imported geometry, attachment and frame-filtered map tiles', () => {
  const calls = [], atlas = { tileByName: new Map([['minecraft:block/birch_planks', 3]]), blockModels: new Map([['minecraft:block/template_item_frame_map', { textures: { wood: 'block/birch_planks' }, elements: [{ from: [0, 0, 15], to: [16, 1, 16], faces: { north: { texture: '#wood', uv: [0, 15, 16, 16] }, south: { texture: '#wood', uv: [0, 15, 16, 16] } } }] }], ['minecraft:block/item_frame_map', { parent: 'block/template_item_frame_map' }]]), itemModels: new Map() };
  const maps = { tileForItem(slot, options) { calls.push({ slot, options }); return { tile: 9 }; } };
  const { scene: visual, uploads } = scene({ atlas, maps }), definition = data.entitiesByName.item_frame;
  const item = { present: true, itemId: data.itemsByName.filled_map.id, itemCount: 1 };
  const metadata = [{ key: definition.metadataKeys.indexOf('item'), value: item }, { key: definition.metadataKeys.indexOf('rotation'), value: 2 }];
  const actor = entity('item_frame', 1, { x: 0, y: 1, z: 0, yaw: Math.PI, objectData: 2, metadata });
  visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [0, 1, -4]);
  assert.equal(visual.stats.nativeModels, 1); assert.equal(visual.stats.vertices, 18); assert.ok(calls.every(call => call.options.frame));
  const original = uploads[0].opaque; assert.ok(original.some((value, index) => index % 14 === 12 && value === 3)); assert.ok(original.some((value, index) => index % 14 === 12 && value === 9));
  visual.consume({ type: 'update', entity: { ...actor, metadata: [...metadata, { key: 0, value: 32 }] } }); visual.update(.2, [0, 1, -4]);
  assert.equal(visual.stats.visible, 1); assert.equal(visual.stats.vertices, 6, 'invisible frames retain their actual displayed map');
  assert.ok(uploads.at(-1).opaque.every((value, index) => index % 14 !== 12 || value === 9));
});

test('server passenger lists attach and detach native humanoid riding poses', () => {
  const { scene: visual, uploads } = scene(); const rider = entity('player', 5), boat = entity('boat', 7);
  visual.consume({ type: 'spawn', entity: rider }); visual.update(.1, [-31, -19, 52]); const standing = uploads.at(-1).opaque.slice();
  visual.consume({ type: 'spawn', entity: { ...boat, passengers: [5] } }); assert.equal(visual.entities.get(5).entity.vehicleId, 7);
  visual.update(.2, [-31, -19, 52]); assert.notDeepEqual(uploads.at(-1).opaque.slice(0, standing.length), standing);
  visual.consume({ type: 'update', entity: { ...boat, passengers: [] } }); assert.equal(visual.entities.get(5).entity.vehicleId, null);
  visual.consume({ type: 'update', entity: { ...boat, passengers: [5] } }); visual.consume({ type: 'remove', id: 7 }); assert.equal(visual.entities.get(5).entity.vehicleId, null);
});

test('entity picking respects native crouch and swim dimensions and authoritative pickup counts', () => {
  const { scene: visual } = scene(), actor = entity('player', 1, { x: 0, y: 0, z: 0, metadata: [{ key: data.entitiesByName.player.metadataKeys.indexOf('pose'), value: 5 }] });
  visual.consume({ type: 'spawn', entity: actor }); assert.equal(visual.pick([0, 1.7, 3], [0, 0, -1], 4), null);
  assert.equal(visual.pick([0, 1.4, 3], [0, 0, -1], 4)?.entityId, 1);
  visual.consume({ type: 'update', entity: { ...actor, metadata: [{ key: data.entitiesByName.player.metadataKeys.indexOf('pose'), value: 3 }] } }); assert.equal(visual.pick([0, 1.4, 3], [0, 0, -1], 4), null);
  visual.consume({ type: 'spawn', entity: entity('item', 8, { metadata: [{ key: 8, value: { present: true, itemId: data.itemsByName.apple.id, itemCount: 5 } }] }) });
  visual.consume({ type: 'collect', id: 8, count: 2 }); assert.equal(visual.entities.get(8).entity.metadata[0].value.itemCount, 3);
  visual.consume({ type: 'collect', id: 8, count: 3 }); assert.equal(visual.entities.has(8), false);
});

test('source-backed mob part visibility follows server horns, chest, stinger and croaking state', () => {
  for (const [name, key, initial, next, expected] of [['goat', 'has_left_horn', true, false, 36], ['llama', 'chest', false, true, -72], ['bee', 'flags', 0, 4, 12], ['frog', 'pose', 0, 8, null]]) {
    const definition = data.entitiesByName[name], metadataKey = definition.metadataKeys.indexOf(key), { scene: visual } = scene();
    const actor = entity(name, 1, { metadata: [{ key: metadataKey, value: initial }] }); visual.consume({ type: 'spawn', entity: actor }); visual.update(.1, [-31, -19, 52]); const before = visual.stats.vertices;
    visual.consume({ type: 'update', entity: { ...actor, metadata: [{ key: metadataKey, value: next }] } }); visual.update(.2, [-31, -19, 52]);
    if (expected === null) assert.ok(visual.stats.vertices > before, 'native frog croaking part appears only in croaking pose'); else assert.equal(before - visual.stats.vertices, expected, name);
  }
  const closed = buildEntityPreview({ name: 'shulker', nbt: { Peek: 0 } }, { registry }), open = buildEntityPreview({ name: 'shulker', nbt: { Peek: 100 } }, { registry });
  assert.ok(open.bounds.max[1] > closed.bounds.max[1] + .9, 'native peek moves the lid by its full original travel');
});
