import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { gzipSync, zlibSync, zipSync } from '../vendor/fflate.js';
import { encodeSourceItemNbt, sourceItemRecord, sourceItemsRegion, SOURCE_PLAYER_UUID_WORDS } from './fixtures/source-world-items-nbt.js';

const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', legacy = version === '1.20.4', encode = new TextEncoder();
const sourceCount = 10, playerUuid = '12345678-1234-5678-1234-567812345678';
const nativeStack = { id: [8, 'minecraft:oak_planks'], [legacy ? 'Count' : 'count']: [legacy ? 1 : 3, sourceCount],
  ...(legacy ? { tag: [10, { exact: [4, 7n] }] } : { components: [10, { max_stack_size: [3, 16] }] }) };
const level = gzipSync(encodeSourceItemNbt({ Data: [10, { DataVersion: [3, legacy ? 3700 : 4671], Version: [10, { Name: [8, version] }],
  SpawnX: [3, 8], SpawnY: [3, 16], SpawnZ: [3, 8], DayTime: [4, 6000n], LevelName: [8, 'Ground item main fixture'],
  Player: [10, { UUID: [11, SOURCE_PLAYER_UUID_WORDS], SelectedItemSlot: [3, 2], Inventory: [9, { type: 10, entries: [{ Slot: [1, 2], ...nativeStack }] }] }] }] }));
function terrain() {
  const sections = [0, 1].map(y => ({ Y: [1, y], SkyLight: [7, new Uint8Array(2048).fill(y ? 255 : 0)], BlockLight: [7, new Uint8Array(2048)],
    biomes: [10, { palette: [9, { type: 8, entries: ['minecraft:plains'] }] }], block_states: [10, { palette: [9, { type: 10, entries: [{ Name: [8, `minecraft:${y ? 'air' : 'stone'}`] }] }] }] }));
  const chunk = zlibSync(encodeSourceItemNbt({ DataVersion: [3, legacy ? 3700 : 4671], xPos: [3, 0], zPos: [3, 0],
    sections: [9, { type: 10, entries: sections }], block_entities: [9, { type: 10, entries: [] }] }));
  const count = Math.ceil((chunk.length + 5) / 4096), bytes = new Uint8Array((2 + count) * 4096), view = new DataView(bytes.buffer);
  view.setUint32(0, 2 << 8 | count); view.setUint32(8192, chunk.length + 1); bytes[8196] = 2; bytes.set(chunk, 8197); return bytes;
}
function fixturePack() {
  // A generated native block/item model exercises actual geometry without
  // redistributing Minecraft textures. Original JARs can replace this fixture.
  const faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all', cullface: face }]));
  const model = { textures: { all: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] };
  const files = { 'version.json': { id: version }, 'data/minecraft/recipe/oak_planks.json': { type: 'minecraft:crafting_shapeless',
    ingredients: legacy ? [{ item: 'minecraft:oak_log' }] : ['minecraft:oak_log'], result: { [legacy ? 'item' : 'id']: 'minecraft:oak_planks', count: 4 } } };
  for (const name of ['stone', 'oak_planks', 'crafting_table']) {
    files[`assets/minecraft/models/block/${name}.json`] = model;
    files[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `minecraft:block/${name}` } } };
    files[`assets/minecraft/models/item/${name}.json`] = { parent: `minecraft:block/${name}` };
    if (!legacy) files[`assets/minecraft/items/${name}.json`] = { model: { type: 'minecraft:model', model: `minecraft:item/${name}` } };
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, encode.encode(JSON.stringify(value))]))));
}
const jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : fixturePack();
const actors = sourceItemsRegion(version, [sourceItemRecord(version, { position: [8.5, 16, 4.5], delay: 32767 }),
  sourceItemRecord(version, { ordinal: 2, position: [9.5, 16, 5.5], delay: 32767, owner: [0, 0, 0, 2] })]);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(process.env.POMME_SOFTWARE_GPU === '1' ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } }); page.setDefaultTimeout(180000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/favicon\.ico/.test(message.text()) && !/favicon\.ico/.test(message.location().url)) errors.push(message.text()); });
  for (const [path, bytes] of [['pack', jar], ['terrain', terrain()], ['actors', actors], ['level', level]]) await page.route(`**/__main-items-${path}`, route => route.fulfill({ body: Buffer.from(bytes), contentType: 'application/octet-stream' }));
  await page.goto(process.env.POMME_URL ?? 'http://127.0.0.1:5173');
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.engine));
  assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready');
  await page.evaluate(async version => {
    const p = window.pomme; document.querySelector('#quality').value = 'low'; document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false;
    p.player.yaw = 0; p.player.pitch = -.2;
    const file = async (name, source, relative) => { const result = new File([await (await fetch(`/__main-items-${source}`)).arrayBuffer()], name, { lastModified: 123 }); if (relative) Object.defineProperty(result, 'webkitRelativePath', { value: relative }); return result; };
    window.itemMainFiles = await Promise.all([file('r.0.0.mca', 'terrain', 'world/region/r.0.0.mca'), file('r.0.0.mca', 'actors', 'world/entities/r.0.0.mca'),
      file('r.0.0.mca', 'terrain', 'world/DIM-1/region/r.0.0.mca'), file('level.dat', 'level', 'world/level.dat')]);
    window.itemMainPack = await file('client.jar', 'pack'); await p.loadPack(window.itemMainPack);
    const result = await p.importFiles(window.itemMainFiles, { version });
    if (result.chunks !== 1 || result.skipped) throw new Error('Folder classification must import one terrain chunk, excluding same-basename entities and other dimensions.');
    if (!p.localInventory?.itemAdapter || p.localInventory.playerUuid !== '12345678-1234-5678-1234-567812345678' || p.localInventory.worldItems.state.items.length !== 2) throw new Error('Production import must bind typed source ground actors and Player.UUID.');
    p.player.yaw = 0; p.player.pitch = -.2; document.activeElement?.blur();
  }, version);
  await page.waitForFunction(() => window.pomme.entities?.stats.vertices > 0 && window.pomme.entities.stats.visible === 2);
  const initial = await page.evaluate(() => ({ actors: window.pomme.localInventory.worldItems.state.items.length, vertices: window.pomme.entities.stats.vertices, uuid: window.pomme.localInventory.playerUuid }));
  await page.keyboard.press('q');
  await page.waitForFunction(() => window.pomme.localInventory.authority.state.player[2].itemCount === 9 && window.pomme.localInventory.worldItems.state.items.length === 3);
  const dropped = await page.evaluate(async () => { const p = window.pomme; await p.localInventory.pending; const actor = p.localInventory.worldItems.state.items.find(actor => actor.thrower === p.localInventory.playerUuid);
    if (!actor || actor.pickupDelay <= 0 || actor.pickupDelay > 40 || actor.stack.itemCount !== 1) throw new Error('Production Q must create one native delayed actor and decrement the selected exact source stack.');
    window.itemMainDroppedId = actor.id; window.itemMainDropPosition = [...actor.position]; return { id: actor.id, uuid: actor.uuid, bobOffset: actor.bobOffset, position: [...actor.position], pickupDelay: actor.pickupDelay }; });
  await page.waitForFunction(() => { const actor = window.pomme.localInventory.worldItems.state.items.find(actor => actor.id === window.itemMainDroppedId); return actor?.pickupDelay === 0 && actor.grounded; });
  await page.evaluate(async () => { const p = window.pomme; const actor = p.localInventory.worldItems.state.items.find(actor => actor.id === window.itemMainDroppedId); if (!actor || actor.position.every((value, axis) => value === window.itemMainDropPosition?.[axis])) throw new Error('Production source actor physics must advance.'); p.player.setPosition(actor.position); });
  await page.waitForFunction(() => window.pomme.localInventory.authority.state.player[2].itemCount === 10 && window.pomme.localInventory.worldItems.state.items.length === 2);
  const report = await page.evaluate(async () => {
    const p = window.pomme, state = p.localInventory.authority.state;
    const original = state.player[2]; await p.saveInventory(); const before = p.localInventory.worldItems.snapshot(), sourceUuid = p.localInventory.playerUuid;
    await p.loadPack(window.itemMainPack);
    if (!p.localInventory.authority.initial.worldItemsRestored || p.localInventory.worldItems.state.items.length !== before.items.length || p.localInventory.playerUuid !== sourceUuid) throw new Error('Pack rebuild must preserve initialized actor history and player binding.');
    for (let index = 0; index < before.items.length; index++) if (p.localInventory.worldItems.state.items[index].uuid !== before.items[index].uuid || p.localInventory.worldItems.state.items[index].bobOffset !== before.items[index].bobOffset) throw new Error('Pack rebuild must preserve source UUID and visual bob identity.');
    if (p.localInventory.authority.state.player[2].itemCount !== original.itemCount) throw new Error('Pack rebuild cannot replay the original source inventory.');
    await p.saveInventory(); await p.resumeImported();
    if (!p.localInventory.authority.initial.worldItemsRestored || p.localInventory.worldItems.state.items.length !== before.items.length || p.localInventory.playerUuid !== sourceUuid) throw new Error('Actual world reopen must restore durable ground actors without source replay.');
    return { validation: 'passed', version: p.registry.version.minecraftVersion, backend: 'production main.js + WebGPU EntityScene + actual Worker/Rust WASM/IndexedDB',
      folderSeparatesTerrainEntitiesAndDimensions: true, sourcePlayerUuidBound: true, initialSourceActors: before.items.length, nativeQDrop: true,
      nativeGravityGroundCollisionAnd40TickDelay: true, pickupPreservesSourceStackIdentity: true, stableActorUuidBobAcrossPackAndReopen: true,
      savedActorsOutrankSource: true, actualItemVertices: p.entities.stats.vertices, fullSurvivalImplemented: false, targetGpu60FpsVerified: false };
  });
  await page.waitForFunction(() => window.pomme.entities?.stats.vertices > 0);
  report.actualItemVertices = await page.evaluate(() => window.pomme.entities.stats.vertices);
  assert.deepEqual(errors, []); assert.equal(initial.uuid, playerUuid); assert.ok(initial.vertices > 0); assert.ok(report.actualItemVertices > 0); assert.ok(dropped.pickupDelay > 0);
  await mkdir('test-results', { recursive: true }); await writeFile(`test-results/local-world-items-main-${version}.json`, JSON.stringify({ ...report, sourceAssets: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated mechanical asset fixture' }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
