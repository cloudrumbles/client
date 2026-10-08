import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { MinecraftMaps, mapColorRGBA, mapItemId, MAP_COLORS } from '../src/maps.js';

const registry = { version: { minecraftVersion: '1.20.4' }, items: [{ id: 1, name: 'filled_map' }, { id: 2, name: 'stone' }] };
const slot = id => ({ present: true, itemId: 1, itemCount: 1, nbtData: { type: 'compound', value: { map: { type: 'int', value: id } } } });
function renderer() {
  const images = new Map(); let next = 0;
  return { images, appendAtlasTile({ pixelsRGBA, width, height }) { const id = next++; images.set(id, pixelsRGBA.slice()); return { id, width, height }; },
    updateAtlasTile(id, { pixelsRGBA }) { assert.ok(images.has(id)); images.set(id, pixelsRGBA.slice()); } };
}
function atlas() {
  const width = 128, height = 128, pixelsRGBA = new Uint8Array(width * height * 4);
  const color = (type, rgba) => { const x = type % 16 * 8, y = Math.floor(type / 16) * 8; for (let row = y; row < y + 8; row++) for (let column = x; column < x + 8; column++) pixelsRGBA.set(rgba, (row * width + column) * 4); };
  color(0, [255, 0, 0, 255]); color(1, [0, 255, 0, 255]);
  return { width, height, pixelsRGBA, tiles: [{ id: 0, x: 0, y: 0, width, height }], tileByName: new Map([['minecraft:map/map_icons', 0], ['minecraft:map/map_background', 10], ['minecraft:map/map_background_checkerboard', 11]]) };
}
const pixel = (image, x, y) => Array.from(image.subarray((y * 128 + x) * 4, (y * 128 + x + 1) * 4));
const full = (id, packed) => ({ itemDamage: id, scale: 0, locked: false, columns: 128, rows: 128, x: 0, y: 0, data: new Uint8Array(16384).fill(packed) });

test('native map palette preserves brightness order, RGBA channel order and NONE transparency', () => {
  assert.equal(MAP_COLORS.length, 64);
  assert.deepEqual([0, 1, 2, 3, 248, 255].map(mapColorRGBA), Array(6).fill([0, 0, 0, 0]));
  assert.deepEqual(mapColorRGBA(4 * 4), [180, 0, 0, 255]);
  assert.deepEqual(mapColorRGBA(4 * 4 + 1), [220, 0, 0, 255]);
  assert.deepEqual(mapColorRGBA(4 * 4 + 2), [255, 0, 0, 255]);
  assert.deepEqual(mapColorRGBA(4 * 4 + 3), [135, 0, 0, 255]);
  assert.deepEqual(mapColorRGBA(12 * 4 + 2), [64, 64, 255, 255]);
  assert.deepEqual(mapColorRGBA(-2), [0, 0, 0, 0], 'signed Java bytes have unsigned packed interpretation');
});

test('map IDs support native legacy NBT and modern data components without treating other items as maps', () => {
  assert.equal(mapItemId(slot(42), registry), 42);
  assert.equal(mapItemId({ present: true, itemId: 1, components: [{ type: 'map_id', data: 900 }] }, registry), 900);
  assert.equal(mapItemId({ ...slot(42), itemId: 2 }, registry), null);
  assert.equal(mapItemId(slot(-1), registry), null);
  assert.equal(mapItemId({ ...slot(42), present: false }, registry), null);
});

test('map rectangle patches retain other pixels and optional icons, and invalid updates are atomic', async () => {
  const gpu = renderer(), maps = new MinecraftMaps({ renderer: gpu, registry, indexedDB: null }); maps.setAssets(atlas());
  assert.ok(maps.consume({ ...full(7, 18), icons: [{ type: 0, x: 0, z: 0, direction: 0 }] }));
  const initial = maps.tileForItem(slot(7)); assert.equal(initial.backgroundTile, 11); assert.equal(maps.stats().uploads, 1);
  assert.equal(maps.tileForItem(slot(7)).tile, initial.tile); assert.equal(maps.stats().uploads, 1, 'unchanged map has no upload');
  assert.ok(maps.consume({ itemDamage: 7, scale: 3, locked: true, columns: 2, rows: 2, x: 126, y: 126, data: new Uint8Array([50, 34, 6, 10]), icons: null }));
  const after = maps.tileForItem(slot(7)); assert.equal(after.tile, initial.tile); assert.equal(after.scale, 3); assert.equal(after.locked, true);
  const image = gpu.images.get(after.tile); assert.deepEqual(pixel(image, 126, 126), [64, 64, 255, 255]); assert.deepEqual(pixel(image, 127, 126), [255, 255, 255, 255]);
  assert.deepEqual(pixel(image, 125, 126), [255, 0, 0, 255]); assert.equal(maps.maps.get(7).icons.length, 1);
  const before = maps.maps.get(7).colors.slice(), revision = after.revision;
  assert.equal(maps.consume({ itemDamage: 7, icons: [], columns: 2, rows: 2, x: 127, y: 0, data: new Uint8Array(4) }), false);
  assert.deepEqual(maps.maps.get(7).colors, before); assert.equal(maps.maps.get(7).icons.length, 1); assert.equal(maps.maps.get(7).revision, revision);
  assert.ok(maps.consume({ itemDamage: 7, columns: 0, icons: [] })); assert.equal(maps.maps.get(7).icons.length, 0);
  await maps.close();
});

test('held maps show player markers; frames filter them and preserve frame markers at native positions', async () => {
  const gpu = renderer(), maps = new MinecraftMaps({ renderer: gpu, registry, indexedDB: null }); maps.setAssets(atlas());
  maps.consume({ itemDamage: 4, columns: 0, icons: [{ type: 0, x: 0, z: 0, direction: 0 }, { type: 1, x: 40, z: 0, direction: 0 }] });
  const held = gpu.images.get(maps.tileForItem(slot(4)).tile), frame = gpu.images.get(maps.tileForItem(slot(4), { frame: true }).tile);
  assert.deepEqual(pixel(held, 64, 64), [255, 0, 0, 255]); assert.deepEqual(pixel(frame, 64, 64), [0, 0, 0, 0]);
  assert.deepEqual(pixel(frame, 84, 64), [0, 255, 0, 255]); assert.deepEqual(pixel(frame, 80, 61), [0, 255, 0, 255]);
  assert.deepEqual(pixel(frame, 78, 61), [0, 0, 0, 0]); assert.deepEqual(pixel(frame, 84, 60), [0, 0, 0, 0]);
  assert.equal(maps.stats().gpuMaps, 2); await maps.close();
});

test('decoration rotation follows native sixteen directions and supports individual modern sprites', async () => {
  const gpu = renderer(), maps = new MinecraftMaps({ renderer: gpu, registry, indexedDB: null });
  const pixelsRGBA = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
  maps.setAssets({ width: 2, height: 2, pixelsRGBA, tiles: [{ id: 1, x: 0, y: 0, width: 2, height: 2 }], tileByName: new Map([['minecraft:gui/sprites/map/decorations/player', 1]]) });
  maps.consume({ itemDamage: 0, columns: 0, icons: [{ type: 0, x: 0, z: 0, direction: 0 }] });
  const noRotation = gpu.images.get(maps.tileForItem(slot(0)).tile); assert.deepEqual(pixel(noRotation, 61, 62), [0, 0, 255, 255]); assert.deepEqual(pixel(noRotation, 65, 67), [0, 255, 0, 255]);
  maps.consume({ itemDamage: 0, columns: 0, icons: [{ type: 0, x: 0, z: 0, direction: 4 }] });
  const quarterTurn = gpu.images.get(maps.tileForItem(slot(0)).tile); assert.deepEqual(pixel(quarterTurn, 65, 61), [0, 0, 255, 255]); assert.deepEqual(pixel(quarterTurn, 61, 65), [0, 255, 0, 255]);
  await maps.close();
});

test('unknown map data uses blank native paper and resident eviction reuses runtime GPU tiles', async () => {
  const gpu = renderer(), maps = new MinecraftMaps({ renderer: gpu, registry, indexedDB: null, maxMaps: 1 }); maps.setAssets(atlas());
  const unknown = maps.tileForItem(slot(8)); assert.equal(unknown.backgroundTile, 10); assert.equal(gpu.images.get(unknown.tile).some(Boolean), false);
  maps.consume(full(8, 18)); assert.equal(maps.tileForItem(slot(8)).backgroundTile, 11);
  maps.consume(full(9, 50)); const next = maps.tileForItem(slot(9)); assert.equal(next.tile, unknown.tile); assert.equal(gpu.images.size, 1); assert.equal(maps.stats().maps, 1);
  assert.deepEqual(pixel(gpu.images.get(next.tile), 64, 64), [64, 64, 255, 255]);
  maps.tileForItem(slot(8)); assert.equal(gpu.images.size, 1); assert.equal(maps.stats().maps, 1); await maps.close();
});

test('map persistence survives reopening, scope changes and patches arriving before IndexedDB is ready', async () => {
  const indexedDB = new IDBFactory(), gpu = renderer();
  const maps = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'server:a:25565:1.20.4', indexedDB });
  maps.consume(full(0, 18)); maps.consume({ itemDamage: 0, columns: 1, rows: 1, x: 7, y: 9, data: new Uint8Array([50]) }); await maps.close();
  const reopened = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'server:a:25565:1.20.4', indexedDB }); await reopened.ready();
  assert.deepEqual(pixel(gpu.images.get(reopened.tileForItem(slot(0)).tile), 7, 9), [64, 64, 255, 255]);
  await reopened.setWorldKey('server:b:25565:1.20.4'); const blank = reopened.tileForItem(slot(0)); assert.equal(gpu.images.get(blank.tile).some(Boolean), false);
  reopened.consume(full(0, 34)); await reopened.flush(); await reopened.setWorldKey('server:a:25565:1.20.4');
  assert.deepEqual(pixel(gpu.images.get(reopened.tileForItem(slot(0)).tile), 1, 1), [255, 0, 0, 255]); await reopened.close();
  const early = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'server:a:25565:1.20.4', indexedDB });
  early.consume(full(0, 34)); await early.ready(); assert.deepEqual(pixel(gpu.images.get(early.tileForItem(slot(0)).tile), 1, 1), [255, 255, 255, 255]); await early.close();
});

test('disk count and byte budgets remove the oldest maps across all world identities', async () => {
  const indexedDB = new IDBFactory(), maps = new MinecraftMaps({ registry, worldKey: 'budget', indexedDB, maxStoredMaps: 3, maxStoredBytes: 16384 * 2 });
  await maps.ready(); for (let id = 0; id < 6; id++) maps.consume(full(id, 18)); await maps.close();
  const reopened = new MinecraftMaps({ registry, worldKey: 'budget', indexedDB, maxStoredMaps: 3, maxStoredBytes: 16384 * 2 }); await reopened.ready();
  assert.deepEqual([...reopened.catalog.keys()].sort(), [4, 5]); assert.ok(reopened.stats().memoryBytes <= 16384 * 2); await reopened.close();
});

test('early partial updates merge with persisted explored pixels and preserve optional decorations', async () => {
  const indexedDB = new IDBFactory(), gpu = renderer(), first = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'partial', indexedDB });
  first.consume({ ...full(5, 18), scale: 2, locked: true, icons: [{ type: 1, x: 40, z: 0, direction: 0 }] }); await first.close();
  const reopened = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'partial', indexedDB }); reopened.setAssets(atlas());
  reopened.consume({ itemDamage: 5, columns: 1, rows: 1, x: 5, y: 5, data: new Uint8Array([50]), icons: null }); await reopened.flush();
  const result = reopened.tileForItem(slot(5)); assert.deepEqual(pixel(gpu.images.get(result.tile), 5, 5), [64, 64, 255, 255]);
  assert.deepEqual(pixel(gpu.images.get(result.tile), 6, 5), [255, 0, 0, 255]); assert.equal(result.scale, 2); assert.equal(result.locked, true); assert.equal(reopened.maps.get(5).icons.length, 1);
  await reopened.close();
  const final = new MinecraftMaps({ renderer: gpu, registry, worldKey: 'partial', indexedDB }); await final.ready();
  assert.deepEqual(pixel(gpu.images.get(final.tileForItem(slot(5)).tile), 6, 5), [255, 0, 0, 255]); await final.close();
});

test('failed IndexedDB does not prevent rendering or stall queued map writes', async () => {
  const statuses = [], gpu = renderer(), maps = new MinecraftMaps({ renderer: gpu, registry, indexedDB: { open() { throw new Error('Storage disabled'); } }, onStatus: message => statuses.push(message) });
  assert.ok(maps.consume(full(1, 18))); await maps.flush(); assert.equal(maps.stats().persistent, false); assert.equal(maps.stats().cacheErrors, 1); assert.match(statuses[0], /memory-only/);
  assert.deepEqual(pixel(gpu.images.get(maps.tileForItem(slot(1)).tile), 1, 1), [255, 0, 0, 255]); await maps.close();
});
