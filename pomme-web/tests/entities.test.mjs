import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { EntityScene } from '../src/entities.js';

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
    visual.consume({ type: 'spawn', entity: entity(name, 1, { pitch: 0.2, headYaw: Math.PI * 0.7 }) });
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
  assert.ok(Math.abs(point[0] - (x + 0.25)) < 0.001);
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
  visual.consume({ type: 'spawn', entity: entity('item', 2) });
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
    visual.consume({ type: 'spawn', entity: entity(name) }); visual.update(0.1, [-31, -19, 52]);
    const vertices = uploads[0].opaque;
    assert.equal(vertices[12], 1, name);
    assert.equal(visual.stats.texturedModels, 1); assert.equal(visual.stats.fallbackModels, 0);
    for (let index = 0; index < vertices.length; index += 14) {
      assert.ok(vertices[index + 10] >= 0 && vertices[index + 10] <= 1, `${name} U range`);
      assert.ok(vertices[index + 11] >= 0 && vertices[index + 11] <= 1, `${name} V range`);
    }
    if (name === 'player') {
      assert.equal(vertices[4 * 6 * 14 + 10], 16 / 64, 'Steve head front right U');
      assert.equal(vertices[4 * 6 * 14 + 11], 16 / 64, 'Steve head front bottom V');
      assert.ok(Array.from(vertices).some((value, index) => index % 14 === 11 && value >= 48 / 64), '64×64 player left limbs use lower sheet region');
    }
    if (name === 'sheep') assert.ok(Array.from(vertices).some((value, index) => index % 14 === 12 && value === 2), 'sheep fur uses separate native sheet');
  }
});
