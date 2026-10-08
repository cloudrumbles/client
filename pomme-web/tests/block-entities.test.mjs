import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, zlibSync } from '../vendor/fflate.js';
import { loadResourcePack } from '../src/assets.js';
import { BlockEntityScene, normalizeBlockEntity } from '../src/block-entities.js';

const encoder = new TextEncoder();
function png(width, height) {
  const chunk = (type, bytes) => { const out = new Uint8Array(bytes.length + 12); new DataView(out.buffer).setUint32(0, bytes.length); out.set(encoder.encode(type), 4); out.set(bytes, 8); return out; };
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1)); for (let y = 0; y < height; y++) rows.fill(255, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(rows)), chunk('IEND', new Uint8Array())], out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let at = 0; for (const part of chunks) { out.set(part, at); at += part.length; } return out;
}
const registry = { blocks: ['air', 'stone', 'chest', 'white_shulker_box', 'oak_sign', 'white_banner', 'decorated_pot', 'moving_piston', 'player_head', 'beacon', 'iron_block', 'red_stained_glass', 'blue_stained_glass', 'bedrock', 'enchanting_table', 'campfire', 'spawner', 'bell', 'piglin_head', 'dragon_head', 'conduit', 'end_gateway', 'end_portal', 'water', 'prismarine', 'prismarine_bricks', 'sea_lantern', 'dark_prismarine', 'lectern', 'suspicious_sand', 'suspicious_gravel', 'copper_chest'].map((name, id) => ({ name, minStateId: id, maxStateId: id, defaultState: id, boundingBox: name === 'air' ? 'empty' : 'block', filterLight: /air|stained_glass|beacon|water/.test(name) ? 0 : 15 })), items: [{ id: 0, name: 'beef' }, { id: 1, name: 'chicken' }], entities: [{ id: 0, name: 'pig', width: .9, height: .9, metadataKeys: ['baby'] }] };
const files = {}, addJson = (name, value) => { files[`assets/minecraft/${name}.json`] = encoder.encode(JSON.stringify(value)); };
for (const texture of ['block/stone', 'entity/chest/normal', 'entity/shulker/shulker_white', 'entity/signs/oak', 'entity/banner_base', 'entity/banner/cross', 'entity/decorated_pot/decorated_pot_base', 'entity/decorated_pot/decorated_pot_side', 'entity/decorated_pot/archer_pottery_pattern', 'entity/player/wide/steve', 'entity/beacon_beam', 'entity/enchanting_table_book', 'entity/pig/pig', 'entity/bell/bell_body', 'entity/piglin/piglin', 'entity/enderdragon/dragon', 'entity/conduit/base', 'entity/conduit/cage', 'entity/conduit/wind', 'entity/conduit/wind_vertical', 'entity/conduit/open_eye', 'entity/conduit/closed_eye', 'entity/end_portal', 'entity/end_gateway_beam', 'environment/end_sky', 'font/ascii', 'item/beef', 'item/chicken']) files[`assets/minecraft/textures/${texture}.png`] = png(64, 64);
addJson('blockstates/stone', { variants: { '': { model: 'block/stone' } } });
addJson('models/block/stone', { textures: { all: 'block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(name => [name, { texture: '#all' }])) }] });
addJson('font/default', { providers: [{ type: 'bitmap', file: 'minecraft:font/ascii.png', ascent: 7, chars: ['A?'] }, { type: 'space', advances: { ' ': 4 } }] });
const pack = await loadResourcePack(zipSync(files), { registry });

function scene(options = {}) {
  const uploads = [], removed = [], overrides = [], states = new Map();
  const renderer = { uploadDynamicMesh(key, vertices, water, bounds, format) { uploads.push({ key, vertices: vertices.slice(), bounds, format }); }, removeMesh(key) { removed.push(key); }, ...options.rendererExtras };
  const scene = new BlockEntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas, getState: (x, y, z) => states.get(`${x},${y},${z}`) ?? 0, setVisualOverride: (x, y, z, state) => overrides.push({ x, y, z, state }), ...options });
  const add = (state, x = 0, y = 0, z = 0, nbt = {}) => { states.set(`${x},${y},${z}`, state); scene.consume({ type: 'block-entity', x, y, z, nbt }); };
  return { scene, uploads, removed, overrides, states, add };
}

test('compact native chunk block entities expand signed chunk coordinates and typed NBT', () => {
  assert.deepEqual(normalizeBlockEntity({ x: 15, z: 0, y: -60, type: 7, nbtData: { type: 'compound', value: { id: { type: 'string', value: 'minecraft:sign' } } } }, { x: -2, z: -3 }), { x: -17, y: -60, z: -48, nbt: { id: 'minecraft:sign' }, action: 7 });
  assert.equal(normalizeBlockEntity(null), null); assert.equal(normalizeBlockEntity({ x: 30000001, y: 0, z: 0 }), null);
  const { scene: visual, uploads } = scene(), section = { y: -4, states: new Uint16Array(4096) }; section.states[4 * 256 + 15] = 4;
  visual.loadColumn({ x: -2, z: -3, sections: [section], blockEntities: [{ x: 15, z: 0, y: -60, type: 7, nbtData: { front_text: { messages: ['"A"'], color: 'white' } } }] });
  visual.update(.1, [-17, -59, -45]); assert.equal(visual.stats.signGlyphs, 1); assert.ok(uploads[0].bounds.min[0] < -16); visual.removeColumn(-2, -3); visual.update(.2, [-17, -59, -45]); assert.equal(visual.stats.tracked, 0);
});

test('server chest/shulker open counts animate actual imported parts and restore static geometry on close', () => {
  for (const [id, kind, expectedHeight] of [[2, 'chest', 1.5], [3, 'shulker', 1.5]]) {
    const { scene: visual, add, uploads, overrides, removed } = scene(); add(id);
    visual.update(0, [0, 2, 3]); assert.equal(uploads.length, 0, 'closed container remains in cached terrain');
    visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 2 }); visual.update(.5, [0, 2, 3]);
    assert.equal(visual.stats.containers, 1); assert.equal(uploads[0].vertices.length, pack.materials.get(id).templateVertices.length); assert.equal(overrides[0].state, 0);
    assert.ok(Math.abs(uploads[0].bounds.max[1] - expectedHeight) < .07, kind);
    for (let i = 0; i < uploads[0].vertices.length; i += 14) assert.ok(Math.abs(Math.hypot(...uploads[0].vertices.subarray(i + 3, i + 6)) - 1) < .00001, 'rotated unit normals');
    visual.update(.6, [0, 2, 3]); assert.equal(uploads.length, 1, 'fully open stationary container reuses its persistent batch');
    visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); visual.update(1.1, [0, 2, 3]);
    assert.equal(overrides.at(-1).state, null); assert.deepEqual(removed, ['__minecraft_block_entities']); assert.equal(visual.entities.get('0,0,0').openness, 0);
  }
});

test('moving pistons translate their named native blockState from server progress without mutating blocks', () => {
  const { scene: visual, add, uploads, states } = scene();
  add(7, 29_999_980, -40, -29_999_980, { blockState: { Name: 'minecraft:stone', Properties: {} }, facing: 5, extending: 1, progress: .5 });
  visual.update(0, [29_999_980, -38, -29_999_977]);
  assert.equal(visual.stats.pistons, 1); assert.ok(Math.abs(uploads[0].bounds.min[0] - 29_999_979.5) < .0001); assert.equal(uploads[0].format.origin[0], 29_999_872);
  visual.update(.05, [29_999_980, -38, -29_999_977]); assert.ok(Math.abs(uploads[1].bounds.min[0] - 29_999_980) < .0001); assert.equal(states.get('29999980,-40,-29999980'), 7);
  const colliders = visual.collisionBoxes(); assert.deepEqual(colliders[0], [29_999_980, -40, -29_999_980, 29_999_981, -39, -29_999_979]);
  visual.update(.2, [29_999_980, -38, -29_999_977]); assert.equal(visual.collisionBoxes(), colliders, 'collision sweeps reuse the cached array'); assert.ok(Math.abs(uploads.at(-1).bounds.min[0] - 29_999_980) < .0001, 'the final pose is uploaded even when a slow frame crosses the complete motion interval');
  visual.consume({ type: 'block', x: 29_999_980, y: -40, z: -29_999_980, state: 1 }); visual.update(.15, [29_999_980, -38, -29_999_977]); assert.equal(visual.stats.pistons, 0);
});

test('front/back sign messages use imported glyphs, dye tint, bounded line width and glow flags', () => {
  const { scene: visual, add, uploads } = scene();
  add(4, 0, 0, 0, { front_text: { messages: ['{"text":"AA"}', '"A"'], color: 'red', has_glowing_text: 1 }, back_text: { messages: ['"A"'], color: 'blue' } });
  visual.update(.1, [0, 1, 3]); assert.equal(visual.stats.signGlyphs, 4); assert.equal(visual.stats.signOutlines, 24); assert.equal(uploads[0].vertices.length, (4 + 24) * 6 * 14);
  assert.ok(uploads[0].vertices[13] & 16777216); assert.ok(uploads[0].vertices[6] > uploads[0].vertices[7]);
  const glyph = pack.atlas.fontGlyphs.get('A'); assert.equal(uploads[0].vertices[12], glyph.tile);
  visual.update(.2, [0, 1, 3]); assert.equal(uploads.length, 1);
});

test('native banner patterns and pottery sherd names select actual resource textures in declared order', () => {
  const { scene: visual, add, uploads } = scene(); add(5, 0, 0, 0, { Patterns: [{ Pattern: 'cr', Color: 14 }, { Pattern: 'cr', Color: 11 }] }); add(6, 2, 0, 0, { sherds: ['minecraft:archer_pottery_sherd', 'minecraft:brick', 'minecraft:brick', 'minecraft:brick'] });
  visual.update(.1, [1, 2, 4]); assert.equal(visual.stats.patterns, 2); assert.equal(visual.stats.decoratedSides, 1);
  const tileIds = new Set(Array.from({ length: uploads[0].vertices.length / 14 }, (_, i) => uploads[0].vertices[i * 14 + 12])); assert.ok(tileIds.has(pack.atlas.entityTiles.get('minecraft:entity/banner/cross'))); assert.ok(tileIds.has(pack.atlas.entityTiles.get('minecraft:entity/decorated_pot/archer_pottery_pattern')));
});

test('bounded visible/tracked batches release overrides on eviction, distance changes and disconnect', () => {
  const { scene: visual, add, overrides, removed } = scene({ maxTracked: 2, maxVisible: 1, maxDistance: 16 });
  for (let x = 0; x < 3; x++) { add(2, x, 0, 0); visual.consume({ type: 'block-action', x, y: 0, z: 0, actionId: 1, actionParam: 1 }); }
  visual.update(.5, [0, 2, 3]); assert.equal(visual.entities.size, 2); assert.equal(visual.stats.containers, 1); visual.update(.6, [100, 2, 3]); assert.equal(overrides.at(-1).state, null); assert.equal(visual.stats.vertices, 0); assert.equal(removed.length, 1); visual.clear(); assert.equal(visual.stats.tracked, 0);
});

test('open shulker collision extends along its authored native facing independently of drawing distance', () => {
  const { scene: visual, add } = scene({ maxDistance: 8 }); visual.update(0, [0, 2, 3]); add(3, 20, -30, -10); visual.consume({ type: 'block-action', x: 20, y: -30, z: -10, actionId: 1, actionParam: 1 }); visual.update(.5, [0, 2, 3]);
  assert.deepEqual(visual.collisionBoxes(), [[20, -30, -10, 21, -28.5, -9]]); assert.equal(visual.stats.vertices, 0); visual.clear(); assert.deepEqual(visual.collisionBoxes(), []);
});

test('real server SkullOwner profile properties replace head texture only after the bounded native skin cache resolves', async () => {
  let fetched = 0, appended = 0;
  const { scene: visual, add, uploads, overrides } = scene({ fetchSkin: async () => { fetched++; return new Response(png(64, 64)); }, rendererExtras: { appendAtlasTile: image => { appended++; assert.equal(image.width, 64); return { id: 5000 }; } } });
  const value = btoa(JSON.stringify({ textures: { SKIN: { url: `https://textures.minecraft.net/texture/${'a'.repeat(64)}` } } }));
  add(8, 0, 0, 0, { SkullOwner: { Properties: { textures: [{ Value: value }] } } }); visual.update(.1, [0, 1, 3]); assert.equal(uploads.length, 0, 'retain native default head while profile image loads');
  await visual.skinCache.skins.values().next().value.promise; visual.update(.2, [0, 1, 3]); assert.equal(visual.stats.customHeads, 1); assert.equal(uploads[0].vertices[12], 5000); assert.equal(overrides[0].state, 0);
  visual.update(.3, [0, 1, 3]); assert.equal(fetched, 1); assert.equal(appended, 1); visual.clear(); assert.equal(overrides.at(-1).state, null);
});

test('beacon beams require actual pyramid blocks, mix native stained-glass sections and stop at opaque blockers', () => {
  const { scene: visual, add, states, uploads } = scene({ maxY: 8, getGameTime: () => 15n }); add(9);
  visual.update(0, [0, 2, 3]); assert.equal(visual.stats.beaconSegments, 0, 'no base means no synthesized beam');
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) states.set(`${x},-1,${z}`, 10);
  states.set('0,2,0', 11); states.set('0,4,0', 12); states.set('0,6,0', 13); visual.consume({ type: 'block', x: 0, y: -1, z: 0, stateId: 10 }); visual.update(.1, [0, 2, 3]);
  assert.equal(visual.stats.beaconSegments, 3); assert.deepEqual(visual.entities.get('0,0,0').beamSections.map(section => [section.y, section.height]), [[0, 2], [2, 2], [4, 4]]);
  const vertices = uploads[0].vertices; assert.ok(vertices.some((value, index) => index % 14 === 9 && value === .125), 'outer layer uses native alpha'); assert.ok(uploads[0].bounds.max[1] > 1024);
  for (let i = 0; i < vertices.length; i += 42) { const a = vertices.slice(i, i + 3), b = vertices.slice(i + 14, i + 17), c = vertices.slice(i + 28, i + 31), u = b.map((v, k) => v - a[k]), v = c.map((n, k) => n - a[k]), n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], dot = n[0] * ((a[0] + b[0] + c[0]) / 3 - .5) + n[2] * ((a[2] + b[2] + c[2]) / 3 - .5); assert.deepEqual(Array.from(vertices.slice(i + 3, i + 6)), [0, 1, 0], 'native beam vertices retain the up normal'); assert.ok(vertices[i + 9] < 1 ? dot < 0 : dot > 0, 'native glow winds inward and the opaque core outward'); }
  states.set('0,7,0', 1); visual.consume({ type: 'block', x: 0, y: 7, z: 0, stateId: 1 }); visual.update(.2, [0, 2, 3]); assert.equal(visual.stats.beaconSegments, 0);
});

test('legacy beacon sections compare native Float32 dye channels after repeated glass colors converge', () => {
  const materials = new Map(pack.materials); materials.set(11, { ...materials.get(11), name: 'minecraft:light_gray_stained_glass' });
  const { scene: visual, add, states } = scene({ materials, maxY: 90 }); add(9);
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) states.set(`${x},-1,${z}`, 10);
  states.set('0,1,0', 11); states.set('0,2,0', 12); for (let y = 3; y < 90; y++) states.set(`0,${y},0`, 11);
  visual.update(0, [0, 2, 3]); const sections = visual.entities.get('0,0,0').beamSections;
  assert.deepEqual(sections.at(-1).color, [157, 157, 151].map(value => Math.fround(value / 255)));
  assert.ok(sections.length < 40 && sections.at(-1).height > 50, 'Converged native colors extend the current section instead of making one new section per glass block.');
});

test('enchanting books use the native seven parts and 20 Hz nearby-player open and flip spring', () => {
  let players = [[.5, .5, 2.5]], samples = 0;
  const { scene: visual, add, uploads } = scene({ getNearbyPlayers: () => players, random: () => [0, .75, .25][samples++ % 3] }); add(14);
  visual.update(0, [0, 2, 3]); const closed = uploads[0].vertices.slice(); assert.equal(visual.stats.enchantingBooks, 1);
  assert.equal(visual.entities.get('0,0,0').book.time, 0); assert.equal(visual.stats.vertices, 7 * 36);
  visual.update(.5, [0, 2, 3]); const book = visual.entities.get('0,0,0').book;
  assert.equal(book.time, 10); assert.ok(Math.abs(book.open - 1) < 1e-9); assert.ok(Math.abs(book.flip) > 0); assert.notDeepEqual(uploads.at(-1).vertices, closed);
  assert.ok(uploads.at(-1).vertices.every((value, index) => index % 14 !== 12 || value === pack.atlas.entityTiles.get('minecraft:entity/enchanting_table_book')));
  assert.ok(uploads.at(-1).bounds.min[1] > .45 && uploads.at(-1).bounds.max[1] < 1.3, 'native floating book remains above the 0.75-block table');
  const vertices = uploads.at(-1).vertices;
  for (let i = 0; i < vertices.length; i += 42) {
    const a = vertices.slice(i, i + 3), b = vertices.slice(i + 14, i + 17), c = vertices.slice(i + 28, i + 31), u = b.map((v, k) => v - a[k]), v = c.map((n, k) => n - a[k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; assert.ok(n.reduce((sum, value, k) => sum + value * vertices[i + 3 + k], 0) > 0, 'native thin-page winding agrees with transformed normals');
  }
  players = [[.5, .5, 3.5]]; visual.update(1.05, [0, 2, 3]); assert.equal(book.open, 0, 'native range is strictly less than three blocks');
});

test('campfire item NBT uses four native fixed-display slots and removes finished cooking items', () => {
  const { scene: visual, add, uploads } = scene();
  add(15, 0, 0, 0, { Items: [{ Slot: 0, id: 'minecraft:beef', Count: 1 }, { Slot: 1, id: 'minecraft:chicken', Count: 1 }, { Slot: 2, id: 'minecraft:beef', Count: 0 }, { Slot: 9, id: 'minecraft:beef', Count: 1 }] });
  visual.update(.1, [0, 2, 3]); assert.equal(visual.stats.cookingItems, 2);
  const tiles = new Set(Array.from({ length: uploads[0].vertices.length / 14 }, (_, index) => uploads[0].vertices[index * 14 + 12]));
  assert.deepEqual(tiles, new Set([pack.atlas.itemTiles.get('minecraft:item/beef'), pack.atlas.itemTiles.get('minecraft:item/chicken')]));
  assert.ok(uploads[0].bounds.min[1] > .43 && uploads[0].bounds.max[1] < .47, 'items lie at the exact native 0.44921875 height');
  assert.ok(uploads[0].bounds.min[0] < .1 && uploads[0].bounds.max[0] > .9, 'facing-dependent corner transforms are not stacked at the center');
  visual.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Items: [] } }); visual.update(.2, [0, 2, 3]); assert.equal(visual.stats.cookingItems, 0); assert.equal(visual.stats.vertices, 0);
});

test('spawner previews use actual SpawnData entities, native delay spin and nearby activation without network actors', () => {
  let players = [[.5, .5, 2]];
  const { scene: visual, add, uploads } = scene({ getNearbyPlayers: () => players }); add(16, 0, 0, 0, { SpawnData: { entity: { id: 'minecraft:pig' } }, Delay: 200, MinSpawnDelay: 300, RequiredPlayerRange: 4 });
  visual.update(0, [0, 2, 3]); assert.equal(visual.stats.spawnerPreviews, 1); assert.ok(uploads[0].vertices.length > 200 * 14);
  const track = visual.entities.get('0,0,0'), preview = track.preview; visual.update(.1, [0, 2, 3]); assert.equal(track.spawnDelay, 198); assert.ok(Math.abs(track.spin - (1000 / 399 + 1000 / 398)) < 1e-9); assert.equal(track.preview, preview, 'persistent model geometry is reused while only its transform changes');
  assert.notDeepEqual(uploads[0].vertices, uploads[1].vertices); assert.ok(uploads[1].bounds.max[1] < 1.1);
  players = [[.5, .5, 4.5]]; const spin = track.spin; visual.update(.3, [0, 2, 3]); assert.equal(track.spin, spin); assert.equal(track.spawnDelay, 198, 'no nearby player means no client spawner animation tick');
  visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); assert.equal(track.spawnDelay, 300, 'native spawner event one resets the minimum delay');
  visual.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { SpawnData: { entity: { id: 'minecraft:not_registered' } } } }); visual.update(.4, [0, 2, 3]); assert.equal(visual.stats.spawnerPreviews, 0); assert.equal(visual.stats.unavailable, 1, 'unknown SpawnData stays explicit rather than inventing a pig');
});

test('native 20 Hz block motions are drained once, bounded and keep directional collider exclusions separate', () => {
  const { scene: visual, add } = scene({ getGameTime: () => 100n }); add(7, 0, 0, 0, { blockState: { Name: 'minecraft:stone' }, progress: 0, facing: 5, extending: 1 });
  visual.update(0, [0, 2, 3]); visual.update(.02, [0, 2, 3]); assert.deepEqual(visual.drainBlockMotions(), []);
  visual.update(.05, [0, 2, 3]); const first = visual.drainBlockMotions(); assert.equal(first.length, 1);
  assert.deepEqual(first[0], { kind: 'piston', key: '0,0,0', tick: 100n, position: [0, 0, 0], direction: [1, 0, 0], previousProgress: 0, currentProgress: .5, boxes: [[-1, 0, 0, 0, 1, 1]], staticBoxes: [], materialName: 'minecraft:stone', extending: true, source: false });
  assert.deepEqual(visual.drainBlockMotions(), []); assert.equal(visual.collisionBoxes(null, null).length, 1, 'explicit null from player provider is accepted');
  assert.deepEqual(visual.collisionBoxes(null, { excludeMotion: '0,0,0', direction: [1, 0, 0] }), []); assert.equal(visual.collisionBoxes(null, { excludeMotion: '0,0,0', direction: [-1, 0, 0] }).length, 1);
  visual.update(.1, [0, 2, 3]); assert.equal(visual.drainBlockMotions()[0].currentProgress, 1); visual.update(.2, [0, 2, 3]); assert.deepEqual(visual.drainBlockMotions(), []);
  add(3, 2, 0, 0); visual.consume({ type: 'block-action', x: 2, y: 0, z: 0, actionId: 1, actionParam: 1 }); visual.update(.7, [0, 2, 3]); const lid = visual.drainBlockMotions(); assert.equal(lid.length, 10, 'half a second produces exactly ten native ticks despite binary time rounding');
  assert.deepEqual(lid[0].direction, [0, 1, 0]); assert.equal(lid[0].previousProgress, 0); assert.ok(Math.abs(lid[0].currentProgress - .1) < 1e-8); assert.equal(lid.at(-1).currentProgress, 1, 'native f32 accumulation clamps the tenth tick to fully open');
  visual.consume({ type: 'block-action', x: 2, y: 0, z: 0, actionId: 1, actionParam: 0 }); visual.update(1.2, [0, 2, 3]); assert.deepEqual(visual.drainBlockMotions(), [], 'closing native shulkers never push actors');
  visual.clear(); assert.deepEqual(visual.collisionBoxes(), []); assert.deepEqual(visual.drainBlockMotions(), []);
});

test('native banner cloth uses world-coordinate game-time phase while its pole remains still', () => {
  let age = 0n; const { scene: visual, add, uploads, overrides } = scene({ getGameTime: () => age }); add(5, 0, 0, 0, { Patterns: [{ Pattern: 'cr', Color: 14 }] });
  visual.update(0, [0, 2, 3]); const first = uploads[0].vertices; age = 25n; visual.update(.1, [0, 2, 3]); const second = uploads[1].vertices;
  assert.equal(overrides[0].state, 0); assert.deepEqual(first.subarray(0, 72 * 14), second.subarray(0, 72 * 14), 'native pole and bar are stationary cached parts');
  assert.notDeepEqual(first.subarray(72 * 14), second.subarray(72 * 14), 'all cloth layers follow the same source wave pose'); assert.equal(visual.stats.patterns, 1); assert.ok(uploads[0].bounds.max[1] > 1.82 && uploads[0].bounds.max[1] < 1.85);
});

test('native bell block action one swings along the click direction and settles after fifty ticks', () => {
  const { scene: visual, add, uploads, overrides } = scene(); add(17); visual.update(0, [0, 2, 3]); const rest = uploads[0].vertices.slice();
  assert.equal(visual.stats.bells, 1); assert.equal(overrides.length, 0, 'authored support remains in cached terrain while only native body is drawn');
  visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 2 }); visual.update(.1, [0, 2, 3]); const shaking = uploads[1].vertices;
  assert.notDeepEqual(rest, shaking); assert.equal(shaking[0], rest[0], 'north click swings around X and preserves each X coordinate');
  visual.update(2.6, [0, 2, 3]); assert.deepEqual(uploads.at(-1).vertices, rest, 'native final resting pose is uploaded even when a slow frame crosses tick fifty');
});

test('powered piglin ears and dragon jaw animate native parts and preserve the last unpowered tick', () => {
  const materials = new Map(pack.materials); for (const id of [18, 19]) materials.set(id, { ...materials.get(id), properties: { rotation: '0', powered: 'true' } });
  const { scene: visual, add, uploads } = scene({ materials }); add(18); add(19, 2); visual.update(0, [0, 2, 3]); const rest = uploads[0].vertices.slice(); visual.update(.1, [0, 2, 3]);
  assert.equal(visual.stats.animatedHeads, 2); assert.notDeepEqual(uploads.at(-1).vertices, rest); assert.equal(visual.entities.get('0,0,0').skull.ticks, 2);
  for (const id of [18, 19]) materials.set(id, { ...materials.get(id), properties: { rotation: '0', powered: 'false' } });
  visual.dirty = true; visual.update(.2, [0, 2, 3]); const count = uploads.length; visual.update(.4, [0, 2, 3]); assert.equal(uploads.length, count); assert.equal(visual.entities.get('0,0,0').skull.ticks, 2);
  for (let i = 0; i < uploads.at(-1).vertices.length; i += 14) assert.ok(Math.abs(Math.hypot(...uploads.at(-1).vertices.subarray(i + 3, i + 6)) - 1) < 1e-6, 'animated native ear/jaw normals stay unit length');
});

test('dynamic native template and model geometry use actual chunk skylight and blocklight values', () => {
  const { scene: visual, add, uploads } = scene({ getLight: () => ({ sky: 3, block: 12 }) }); add(7, 0, 0, 0, { blockState: { Name: 'minecraft:stone' }, progress: 0, facing: 5, extending: 1 }); add(14, 2);
  visual.update(.1, [0, 2, 3]); for (let i = 13; i < uploads[0].vertices.length; i += 14) { const flags = uploads[0].vertices[i]; assert.equal(flags >> 10 & 15, 3); assert.equal(flags >> 14 & 15, 12); assert.ok(flags & 512); }
});

test('a newly loaded scene starts at its first render timestamp without replaying browser uptime as native motion', () => {
  const { scene: visual, add, uploads } = scene(); add(7, 0, 0, 0, { blockState: { Name: 'minecraft:stone' }, progress: .25, facing: 5, extending: 1 });
  visual.update(12_345, [0, 2, 3]); assert.equal(uploads[0].bounds.min[0], -.75); assert.deepEqual(visual.drainBlockMotions(), []);
  visual.update(12_345.05, [0, 2, 3]); assert.equal(visual.drainBlockMotions()[0].currentProgress, .75); assert.ok(Math.abs(uploads.at(-1).bounds.min[0] + .25) < 1e-6);
});

test('dynamic collision entries retain their block owner while moved shapes use their rendered world bounds', () => {
  const { scene: visual, add } = scene(); add(7, 10, -5, 3, { blockState: { Name: 'minecraft:stone' }, progress: 0, facing: 5, extending: 1 }); visual.update(0, [10, -3, 6]);
  assert.deepEqual(visual.collisionEntries([8, -6, 2, 10, -4, 4], null), [{ box: [9, -5, 3, 10, -4, 4], position: [10, -5, 3], key: '10,-5,3', moving: true }]);
  assert.deepEqual(visual.collisionEntries([100, 0, 0, 101, 1, 1]), []);
  assert.deepEqual(visual.collisionEntries(null, { excludeMotion: '10,-5,3', direction: [1, 0, 0] }), []);
});

test('conduits use a fully wet 3x3 center and native 16/42 ring requirements at the forty-tick refresh', () => {
  let age = 39n; const materials = new Map(pack.materials); materials.set(20, { ...materials.get(20), properties: { waterlogged: 'true' } });
  const { scene: visual, add, states, uploads } = scene({ materials, getGameTime: () => age });
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) states.set(`${x},${y},${z}`, 23);
  const ring = []; for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
    const a = [Math.abs(x), Math.abs(y), Math.abs(z)]; if ((x === 0 && (a[1] === 2 || a[2] === 2)) || (y === 0 && (a[0] === 2 || a[2] === 2)) || (z === 0 && (a[0] === 2 || a[1] === 2))) ring.push([x, y, z]);
  }
  assert.equal(ring.length, 42); for (const position of ring.slice(0, 15)) states.set(position.join(','), 24); add(20); visual.update(0, [0, 2, 3]);
  age = 40n; visual.update(.05, [0, 2, 3]); assert.equal(visual.stats.activeConduits, 0); assert.equal(visual.entities.get('0,0,0').conduit.bases, 15);
  states.set(ring[15].join(','), 24); visual.consume({ type: 'block', x: ring[15][0], y: ring[15][1], z: ring[15][2], stateId: 24 }); age = 41n; visual.update(.1, [0, 2, 3]); assert.equal(visual.stats.activeConduits, 0, 'the native source waits for global game tick divisible by forty');
  age = 80n; visual.update(.15, [0, 2, 3]); const conduit = visual.entities.get('0,0,0').conduit; assert.equal(conduit.active, true); assert.equal(conduit.hunting, false); assert.equal(visual.stats.activeConduits, 1);
  const textures = vertices => new Set(Array.from({ length: vertices.length / 14 }, (_, index) => vertices[index * 14 + 12]));
  assert.ok(textures(uploads.at(-1).vertices).has(pack.atlas.entityTiles.get('minecraft:entity/conduit/closed_eye'))); assert.ok(uploads.at(-1).vertices.length >= 4 * 36 * 14);
  for (const position of ring) states.set(position.join(','), 24); age = 120n; visual.update(.2, [0, 2, 3], { direction: [1, 0, 0] }); assert.equal(conduit.hunting, true); assert.ok(textures(uploads.at(-1).vertices).has(pack.atlas.entityTiles.get('minecraft:entity/conduit/open_eye')));
  states.set('1,1,1', 0); age = 160n; visual.update(.25, [0, 2, 3]); assert.equal(conduit.active, false); assert.equal(visual.stats.activeConduits, 0); assert.equal(visual.stats.conduits, 1); assert.equal(visual.stats.vertices, 36, 'the last missing water position restores the native inactive shell');
});

test('gateway spawn and cooldown beams use native Age/event one and release the beam at the end of its forty ticks', () => {
  const { scene: visual, add, uploads, removed } = scene({ getGameTime: () => 15n, maxY: 320 }); add(21, 0, 0, 0, { Age: 100n }); visual.update(0, [0, 2, 3]);
  assert.equal(visual.stats.gatewayBeams, 1); assert.deepEqual(uploads[0].bounds.min.slice(1, 2), [-320]); assert.equal(uploads[0].bounds.max[1], 320); assert.equal(visual.stats.vertices, 48);
  const color = [0xc7, 0x4e, 0xbd].map(value => Math.fround(value / 255)); assert.deepEqual(Array.from(uploads[0].vertices.slice(6, 9)), color); assert.ok(uploads[0].vertices.some((value, index) => index % 14 === 9 && value === .125));
  visual.consume({ type: 'block-entity', x: 0, y: 0, z: 0, nbt: { Age: 1000n } }); visual.update(.1, [0, 2, 3]); assert.equal(visual.stats.gatewayBeams, 0); assert.equal(removed.length, 1);
  visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: 0 }); visual.update(.6, [0, 2, 3]); assert.equal(visual.entities.get('0,0,0').gatewayCooldown, 30); assert.equal(visual.stats.gatewayBeams, 1); assert.equal(uploads.at(-1).bounds.max[1], 35);
  visual.update(1.1, [0, 2, 3]); visual.update(1.6, [0, 2, 3]); visual.update(2.1, [0, 2, 3]); assert.equal(visual.entities.get('0,0,0').gatewayCooldown, 0); assert.equal(visual.stats.gatewayBeams, 0); assert.equal(visual.stats.vertices, 0); assert.equal(removed.length, 2);
});

test('native active conduit parts remain no-cull across all wind phases and eye states', () => {
  for (const ticks of [0, 65, 66, 131, 132, 197, 198]) for (const hunting of [false, true]) {
    const { scene: visual, add, uploads } = scene(); add(20);
    Object.assign(visual.entities.get('0,0,0').conduit, { active: true, hunting, ticks, activeRotation: 10 });
    visual.update(0, [0, 2, 3], { direction: [.2, -.3, -.9] }); const vertices = uploads[0].vertices;
    assert.equal(vertices.length / 14, 288); const tiles = [];
    for (let part = 0; part < 4; part++) {
      const start = part * 72 * 14; tiles.push(vertices[start + 12]);
      for (let triangle = 0; triangle < 36; triangle += 3) for (const [corner, reversed] of [[0, 0], [1, 2], [2, 1]]) assert.deepEqual(vertices.subarray(start + (triangle + corner) * 14, start + (triangle + corner + 1) * 14), vertices.subarray(start + (36 + triangle + reversed) * 14, start + (37 + triangle + reversed) * 14));
    }
    const wind = Math.trunc(ticks / 66) % 3 === 1 ? 'wind_vertical' : 'wind';
    assert.deepEqual(tiles, ['cage', wind, wind, hunting ? 'open_eye' : 'closed_eye'].map(name => pack.atlas.entityTiles.get(`minecraft:entity/conduit/${name}`)));
  }
});

test('conduit ticks retain native signed-int rollover and active float-counter saturation', () => {
  const { scene: visual, add } = scene({ getGameTime: () => 41n }); add(20); const state = visual.entities.get('0,0,0').conduit;
  Object.assign(state, { active: true, ticks: 2147483647, activeRotation: 16777216 }); visual.update(0, [0, 2, 3]); visual.update(.05, [0, 2, 3]);
  assert.equal(state.ticks, -2147483648); assert.equal(state.activeRotation, 16777216);
});

test('modern beacon/gateway profile preserves source height, distance width, scoping, alpha and integer color averages', () => {
  const options = { registry: { ...registry, version: { minecraftVersion: '1.21.11' } }, maxY: 8, getGameTime: () => -1n, getPartialTick: () => .5 };
  const { scene: visual, add, states, uploads } = scene(options); add(9); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) states.set(`${x},-1,${z}`, 10);
  visual.update(0, [192.5, 2, .5]); assert.equal(uploads[0].bounds.max[1], 2048); assert.deepEqual(uploads[0].bounds.min.slice(0, 1), [0]); assert.equal(uploads[0].bounds.max[0], 1);
  assert.equal(uploads[0].vertices[24 * 14 + 9], Math.fround(32 / 255)); assert.equal(uploads[0].vertices[13] & 8, 0);
  visual.update(.1, [192.5, 2, .5], { scoping: true }); assert.equal(uploads.at(-1).bounds.min[0], .25); assert.equal(uploads.at(-1).bounds.max[0], .75);
  states.set('0,2,0', 11); states.set('0,4,0', 12); visual.dirty = true; visual.entities.get('0,0,0').beamAt = -Infinity; visual.update(.2, [0, 2, 3]);
  assert.deepEqual(visual.entities.get('0,0,0').beamSections[2].color, [118, 57, 104].map(value => value / 255));
  const gateway = scene({ ...options, maxY: 320 }); gateway.add(21, 0, 0, 0, { Age: 100n }); gateway.scene.update(0, [0, 2, 3]); assert.equal(gateway.uploads[0].bounds.max[1], 319); assert.equal(gateway.uploads[0].bounds.min[1], -319);
});


test('lectern book obeys native has_book state with a static seven-part native model in every facing', () => {
  const { scene: visual, add, uploads } = scene();
  const id = 28, base = pack.materials.get(id), materials = new Map(pack.materials);
  visual.materials = materials;
  materials.set(id, { ...base, name: 'minecraft:lectern', properties: { has_book: 'false', facing: 'north' } });
  add(id); visual.update(0, [0, 2, 3]); assert.equal(visual.stats.lecternBooks, 0);
  for (const [index, facing] of ['north', 'east', 'south', 'west'].entries()) {
    materials.set(id, { ...base, name: 'minecraft:lectern', properties: { has_book: 'true', facing } });
    visual.consume({ type: 'block', x: 0, y: 0, z: 0, stateId: id }); visual.update((index + 1) * .1, [0, 2, 3]);
    assert.equal(visual.stats.lecternBooks, 1); assert.equal(uploads.at(-1).vertices.length, 7 * 36 * 14);
    assert.ok(uploads.at(-1).bounds.min[1] > .6 && uploads.at(-1).bounds.max[1] < 1.5);
  }
  const count = uploads.length; visual.update(1, [0, 2, 3]); assert.equal(uploads.length, count, 'unchanged lectern book is cached');
});

test('brushable item requires native dusted/hit_direction/item data and samples light on the exposed face', () => {
  const probes = [], { scene: visual, add, uploads } = scene({ getLight: (x, y, z) => { probes.push([x, y, z]); return { sky: 2, block: 11 }; } });
  const id = 29, base = pack.materials.get(id), materials = new Map(pack.materials); visual.materials = materials;
  materials.set(id, { ...base, name: 'minecraft:suspicious_sand', properties: { dusted: '0' } });
  add(id, 0, 0, 0, { item: { id: 'minecraft:beef', Count: 1 }, hit_direction: 5 }); visual.update(0, [0, 2, 3]); assert.equal(visual.stats.brushingItems, 0);
  materials.set(id, { ...base, name: 'minecraft:suspicious_sand', properties: { dusted: '3' } });
  const expectedCenters = [[.5, .045, .5], [.5, .975, .5], [.5, .5, .025], [.5, .5, .955], [.025, .5, .5], [.955, .5, .5]];
  for (let direction = 0; direction < 6; direction++) {
    add(id, 0, 0, 0, { item: { id: 'minecraft:beef', count: 1 }, hit_direction: direction }); visual.update((direction + 1) * .1, [0, 2, 3]);
    assert.equal(visual.stats.brushingItems, 1); const { min, max } = uploads.at(-1).bounds;
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs((min[axis] + max[axis]) / 2 - expectedCenters[direction][axis]) < 1e-6);
    assert.deepEqual(probes.at(-1), [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][direction]);
    assert.equal((uploads.at(-1).vertices[13] >> 14) & 15, 11);
  }
  add(id, 0, 0, 0, { item: { id: 'minecraft:beef', count: 1 } }); visual.update(.8, [0, 2, 3]); assert.equal(visual.stats.brushingItems, 0);
});

test('decorated pot event one runs seven/ten-tick native wobble then restores its cached static form', () => {
  for (const [style, seconds] of [[0, .35], [1, .5]]) {
    const { scene: visual, add, uploads, overrides } = scene(); add(6, 0, 0, 0, { sherds: Array(4).fill('minecraft:archer_pottery_sherd') }); visual.update(0, [0, 2, 3]);
    const rest = uploads.at(-1).vertices;
    visual.consume({ type: 'block-action', x: 0, y: 0, z: 0, actionId: 1, actionParam: style }); visual.update(seconds / 4, [0, 2, 3]);
    assert.equal(visual.stats.potWobbles, 1); assert.equal(overrides.at(-1).state, 0); assert.notDeepEqual(uploads.at(-1).vertices.slice(-rest.length), rest);
    for (let i = 0; i < uploads.at(-1).vertices.length; i += 14) assert.ok(Math.abs(Math.hypot(...uploads.at(-1).vertices.subarray(i + 3, i + 6)) - 1) < 1e-6);
    visual.update(seconds + .01, [0, 2, 3]); assert.equal(visual.stats.potWobbles, 0); assert.equal(overrides.at(-1).state, null); assert.deepEqual(uploads.at(-1).vertices, rest);
    const count = uploads.length; visual.update(seconds + .11, [0, 2, 3]); assert.equal(uploads.length, count, 'restored decoration is cached');
  }
});

test('in-world sign components preserve native component colors, bold offsets, italic shear and underline/strike', () => {
  const { scene: visual, add, uploads } = scene();
  add(4, 0, 0, 0, { front_text: { messages: [JSON.stringify({ text: 'A', color: '#12a4f0', bold: true, italic: true, underlined: true, strikethrough: true })], color: 'red' } }); visual.update(0, [0, 1, 3]);
  assert.equal(visual.stats.signGlyphs, 1); assert.equal(visual.stats.signDecorations, 2); assert.equal(visual.stats.signOutlines, 0);
  const vertices = uploads.at(-1).vertices; assert.equal(vertices.length, 4 * 6 * 14);
  assert.ok(Math.abs(vertices[6] - 0x12 / 255) < 1e-6 && Math.abs(vertices[7] - 0xa4 / 255) < 1e-6 && Math.abs(vertices[8] - 0xf0 / 255) < 1e-6);
  assert.ok(Math.abs(vertices[6 * 14] - vertices[0] - 1 / 96) < 1e-6, 'bold ink is duplicated one native pixel to the right');
  assert.ok(Math.abs(vertices[5 * 14] - vertices[0]) > .015, 'italic top and bottom have a native height-dependent shear');
  assert.ok(Math.abs((uploads.at(-1).bounds.min[0] + uploads.at(-1).bounds.max[0]) / 2 - .5) < .025);
});

test('block entities retain sub-block Y precision at native signed i32 dimension limits', () => {
  for (const y of [-2147483648, 2147483647]) {
    assert.ok(normalizeBlockEntity({ x: 0, y, z: 0 }));
    const { scene: visual, add, uploads } = scene(); add(4, 0, y, 0, { front_text: { messages: ['"A"'], color: 'white' } }); visual.update(0, [0, y + 1, 3]);
    assert.equal(visual.stats.signGlyphs, 1); const upload = uploads.at(-1), ys = [];
    for (let i = 1; i < upload.vertices.length; i += 14) ys.push(upload.vertices[i]);
    assert.ok(Math.abs(Math.max(...ys) - Math.min(...ys) - 8 / 96) < 1e-5);
    assert.ok(Math.abs(upload.bounds.max[1] - (y + 5 / 6 + 20 / 96)) < 1e-6);
  }
  assert.equal(normalizeBlockEntity({ x: 0, y: 2147483648, z: 0 }), null);
});


test('banner phase uses native signed i32 position arithmetic before adding long world age', () => {
  const age = 0n, high = 2147483647, phase = BigInt(Math.imul(high, 9));
  const native = scene({ getGameTime: () => age }), matched = scene({ getGameTime: () => phase });
  native.add(5, 0, high, 0); native.scene.update(0, [0, high + 2, 3]);
  matched.add(5, 0, 0, 0); matched.scene.update(0, [0, 2, 3]);
  const a = native.uploads.at(-1).vertices, b = matched.uploads.at(-1).vertices;
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 14) for (const axis of [0, 2, 3, 4, 5]) assert.ok(Math.abs(a[i + axis] - b[i + axis]) < 1e-6, 'same native phase has the same cloth wave');
});


test('native sign first-line wrapping breaks at a prior space and preserves legacy literal style codes', () => {
  const { scene: visual, add, uploads } = scene();
  add(4, 0, 0, 0, { front_text: { messages: [JSON.stringify({ text: 'A'.repeat(12) + ' ' + 'A'.repeat(10) })], color: 'white' } }); visual.update(0, [0, 1, 3]);
  assert.equal(visual.stats.signGlyphs, 12, 'native first line excludes the partial second word');
  add(4, 0, 0, 0, { front_text: { messages: [JSON.stringify({ text: '\u00a7a\u00a7lA' })], color: 'red' } }); visual.update(.1, [0, 1, 3]);
  assert.equal(visual.stats.signGlyphs, 1); assert.equal(uploads.at(-1).vertices.length, 12 * 14);
  const vertices = uploads.at(-1).vertices; assert.ok(Math.abs(vertices[6] - 0x55 / 255) < 1e-6); assert.equal(vertices[7], 1);
});


test('glowing sign fullbright flag survives the Float32 ABI with every native packed-light combination', () => {
  let sky = 0, block = 0; const { scene: visual, add, uploads } = scene({ getLight: () => ({ sky, block }) });
  for (sky = 0; sky < 16; sky++) for (block = 0; block < 16; block++) {
    add(4, 0, 0, 0, { front_text: { messages: ['"A"'], color: 'blue', has_glowing_text: true } }); visual.update((sky * 16 + block) * .1, [0, 1, 3]);
    const flags = uploads.at(-1).vertices[13]; assert.ok((flags & 16777216) !== 0); assert.ok((flags & 8) === 0, 'native text does not receive material emission');
    assert.equal((flags >> 10) & 15, sky); assert.equal((flags >> 14) & 15, block); assert.ok(flags & 32); assert.ok(flags & 512); assert.equal(flags % 32, 0);
  }
});
