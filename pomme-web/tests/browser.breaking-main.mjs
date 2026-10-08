// Actual named Java packets → TCP gateway → production main/renderer.
// Default assets/save are generated; an optional 1.20.4 client JAR stays private.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { zipSync, zlibSync, gzipSync } from 'fflate';
import { createGateway } from '../scripts/gateway.mjs';
import { sourceInventoryFixture } from './fixtures/source-inventory-nbt.js';

const version = '1.20.4', data = minecraftData(version), stone = data.blocksByName.stone.defaultState, encode = new TextEncoder();
async function deadline(promise, label, milliseconds = 120000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function waitPacket(predicate, label) {
  const until = Date.now() + 5000;
  while (!packets.some(predicate)) {
    if (Date.now() >= until) throw new Error(`Missing native ${label} packet.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const concat = values => Buffer.concat(values.map(value => Buffer.from(value)));
function number(size, value) { const bytes = Buffer.alloc(size); if (size === 1) bytes.writeInt8(value); else if (size === 2) bytes.writeInt16BE(value); else if (size === 4) bytes.writeInt32BE(value); else bytes.writeBigInt64BE(BigInt(value)); return bytes; }
const string = value => { const bytes = encode.encode(value); return concat([number(2, bytes.length), bytes]); };
function payload(type, value) {
  if (type >= 1 && type <= 4) return number([0, 1, 2, 4, 8][type], value);
  if (type === 8) return string(value);
  if (type === 7) return concat([number(4, value.length), value]);
  if (type === 10) return concat([...Object.entries(value).map(([key, [child, content]]) => concat([number(1, child), string(key), payload(child, content)])), [0]]);
  if (type === 9) return concat([number(1, value.type), number(4, value.entries.length), ...value.entries.map(entry => payload(value.type, entry))]);
  throw new Error('Unsupported fixture tag.');
}
const nbt = value => concat([[10, 0, 0], payload(10, value)]);
function fixtureRegions({ unavailable = false } = {}) {
  const chunk = zlibSync(nbt({ DataVersion: [3, 3700], xPos: [3, 0], zPos: [3, 0], sections: [9, { type: 10, entries: [
    { Y: [1, 0], SkyLight: [7, new Uint8Array(2048).fill(255)], BlockLight: [7, new Uint8Array(2048)], block_states: [10, { palette: [9, { type: 10, entries: [{ Name: [8, 'minecraft:stone'] }] }] }] },
  ] }] })), sectors = Math.ceil((chunk.length + 5) / 4096), region = Buffer.alloc((2 + sectors) * 4096);
  region.writeUInt32BE(2 * 256 + sectors, 0); region.writeUInt32BE(chunk.length + 1, 8192); region[8196] = 2; region.set(chunk, 8197);
  const source = sourceInventoryFixture(version), spawn = payload(10, { SpawnX: [3, 8], SpawnY: [3, 18], SpawnZ: [3, 8], LevelName: [8, 'Main source inventory fixture'], DayTime: [4, 6000n] });
  // Both final END tags close Data and root. Insert ordinary world metadata
  // inside Data while retaining the source fixture's original typed Player.
  const level = gzipSync(unavailable ? nbt({ Data: [10, { DataVersion: [3, 3700], Version: [10, { Name: [8, version] }], SpawnX: [3, 8], SpawnY: [3, 18], SpawnZ: [3, 8], LevelName: [8, 'Mechanical unread source inventory'], Player: [8, 'Invalid source Player type'] }] }) : concat([source.subarray(0, source.length - 2), spawn.subarray(0, spawn.length - 1), source.subarray(source.length - 2)]));
  return [{ name: 'r.0.0.mca', mimeType: 'application/octet-stream', buffer: region }, { name: 'level.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(level) }];
}
function fixturePack() {
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let bit = 0; bit < 8; bit++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, bytes) => { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(name, 4); out.set(bytes, 8); out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; };
  const texture = stage => { const header = Buffer.alloc(13), rows = Buffer.alloc(16 * 65); header.writeUInt32BE(16); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 6;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const gray = stage < 0 ? 180 : (x + y * 3) % (12 - stage) === 0 ? 32 : 128; rows.set([gray, gray, gray, 255], y * 65 + x * 4 + 1); }
    return concat([[137, 80, 78, 71, 13, 10, 26, 10], chunk('IHDR', header), chunk('IDAT', zlibSync(rows)), chunk('IEND', Buffer.alloc(0))]); };
  const faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all', cullface: face }]));
  const model = { textures: { all: 'minecraft:block/fixture' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] }, files = {
    'version.json': { id: version }, 'assets/minecraft/textures/block/fixture.png': texture(-1),
    'data/minecraft/recipe/oak_planks.json': { type: 'minecraft:crafting_shapeless', ingredients: [{ item: 'minecraft:oak_log' }], result: { item: 'minecraft:oak_planks', count: 4 } },
  };
  for (const name of ['stone', 'oak_planks', 'crafting_table']) { files[`assets/minecraft/models/block/${name}.json`] = model; files[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `minecraft:block/${name}` } } }; }
  for (let stage = 0; stage < 10; stage++) files[`assets/minecraft/textures/block/destroy_stage_${stage}.png`] = texture(stage);
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, value instanceof Uint8Array ? value : encode.encode(JSON.stringify(value))]))));
}
const varint = input => { let value = input >>> 0; const bytes = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value); return bytes; };
const chunkData = concat(Array.from({ length: 24 }, (_, index) => index === 4 ? concat([[16, 0, 0], varint(stone), [0, 0], varint(data.biomesByName.plains.id), [0]]) : [0, 0, 0, 0, 0, 0, 1, 0]));
const url = process.env.POMME_URL ?? 'http://127.0.0.1:5173', software = process.env.POMME_SOFTWARE_GPU === '1', errors = [], packets = [];
let browser, gateway, joined, page;
const server = minecraftProtocol.createServer({ host: '127.0.0.1', port: 0, version, 'online-mode': false, keepAlive: false, hideErrors: true, maxPlayers: 2 });
server.on('error', error => errors.push(error.message)); await once(server, 'listening'); const port = server.socketServer.address().port;
server.on('playerJoin', client => {
  joined = client; client.on('packet', (params, metadata) => packets.push({ name: metadata.name, params })); client.on('error', error => errors.push(error.message));
  client.write('login', { ...data.loginPacket, entityId: 42, gameMode: 0, hashedSeed: 1650n });
  client.write('position', { x: 8.5, y: 16.01, z: 8.5, yaw: 0, pitch: 90, flags: 0, teleportId: 1 });
  client.write('chunk_batch_start', {}); client.write('map_chunk', { x: 0, z: 0, heightmaps: { type: 'compound', value: {} }, chunkData, blockEntities: [], skyLightMask: [32n], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [32n], skyLight: [Array(2048).fill(255)], blockLight: [] }); client.write('chunk_batch_finished', { batchSize: 1 });
  client.write('update_time', { age: 1000n, time: -6000n });
  client.write('window_items', { windowId: 0, stateId: 1, items: Array.from({ length: 46 }, () => ({ present: false })), carriedItem: { present: false } });
});
try {
  gateway = await createGateway({ port: 0, allowedOrigins: [new URL(url).origin], allowDestinations: [`127.0.0.1:${port}`] });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
  page = await browser.newPage({ viewport: { width: 480, height: 270 } }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => {
    const location = message.location().url;
    if (message.type() === 'error' && !message.text().includes('favicon.ico') && !location?.endsWith('/favicon.ico')) errors.push(`${message.text()}${location ? ` at ${location}` : ''}`);
  });
  await page.goto(url); await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.engine)); assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready');
  await page.evaluate(() => { document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false; document.querySelector('#quality').value = 'low'; const scale = document.querySelector('#resolution'); scale.value = '.5'; scale.dispatchEvent(new Event('input'));
    for (const id of ['mining-pack', 'mining-region']) { const input = document.createElement('input'); input.type = 'file'; input.id = id; input.multiple = true; document.body.append(input); } });
  await page.locator('#mining-pack').setInputFiles(process.env.POMME_MINECRAFT_JAR ?? { name: 'mining-fixture.zip', mimeType: 'application/zip', buffer: fixturePack() });
  console.log('Main proof: loading user pack.');
  await deadline(page.evaluate(() => window.pomme.loadPack(document.querySelector('#mining-pack').files[0], { version: '1.20.4' })), 'User pack admission');
  console.log('Main proof: connecting native protocol.');
  await deadline(page.evaluate(options => window.pomme.connectServer(options), { host: '127.0.0.1', port, username: 'MiningBrowser', auth: 'offline', gateway: `ws://127.0.0.1:${gateway.address.port}`, version }), 'Native protocol connection');
  console.log('Main proof: protocol connection opened; waiting for terrain.');
  await page.waitForFunction(state => window.pomme.ready && window.pomme.session?.state.status === 'playing' && window.pomme.core.block_get(8, 15, 8) === state && window.pomme.breaking, stone);
  console.log('Main proof: native terrain ready; waiting for initial cached lighting.');
  await page.waitForFunction(() => { const cache = window.pomme.world.irradiance; return !cache || cache.stats().volumeUploads > 0 && !cache.stats().busy && !cache.stats().pending; });
  await page.evaluate(async () => { window.pomme.player.pitch = -Math.PI / 2; await document.querySelector('#world').requestPointerLock(); });
  await page.waitForFunction(() => Boolean(document.pointerLockElement)); await page.mouse.down();
  await page.waitForFunction(() => window.pomme.breaking.records.get(42)?.stage >= 0 && window.pomme.renderer.stats().breaking.meshes === 1);
  const local = await page.evaluate(() => ({ record: window.pomme.breaking.records.get(42), duration: window.pomme.gameplay.digging.duration, stage: window.pomme.breaking.records.get(42).stage }));
  await page.mouse.up(); await page.waitForFunction(() => !window.pomme.breaking.records.has(42));
  await waitPacket(packet => packet.name === 'block_dig' && packet.params.status === 0, 'start digging');
  await waitPacket(packet => packet.name === 'block_dig' && packet.params.status === 1, 'cancel digging');
  console.log('Main proof: local hold/cancel passed; testing remote lifecycle.');
  await page.evaluate(() => document.exitPointerLock()); const before = await page.evaluate(() => ({ revision: window.pomme.core.world_revision(), shadowUpdates: window.pomme.renderer.stats().shadowUpdates }));
  const position = { x: 8, y: 15, z: 8 }; joined.write('block_break_animation', { entityId: 99, location: position, destroyStage: 4 });
  await page.waitForFunction(() => window.pomme.breaking.records.get(99)?.stage === 4 && window.pomme.renderer.stats().breaking.meshes === 1);
  const remote = await page.evaluate(() => ({ revision: window.pomme.core.world_revision(), shadowUpdates: window.pomme.renderer.stats().shadowUpdates, stage: window.pomme.breaking.records.get(99).stage, renderer: window.pomme.renderer.stats().breaking }));
  assert.equal(remote.revision, before.revision); assert.equal(remote.shadowUpdates, before.shadowUpdates);
  joined.write('block_break_animation', { entityId: 99, location: position, destroyStage: 8 }); await page.waitForFunction(() => window.pomme.breaking.records.get(99)?.stage === 8);
  joined.write('block_change', { location: position, type: 0 }); await page.waitForFunction(() => window.pomme.core.block_get(8, 15, 8) === 0 && !window.pomme.breaking.records.has(99));
  joined.write('block_change', { location: position, type: stone }); await page.waitForFunction(state => window.pomme.core.block_get(8, 15, 8) === state, stone);
  joined.write('block_break_animation', { entityId: 99, location: position, destroyStage: 4 }); await page.waitForFunction(() => window.pomme.breaking.records.has(99));
  const replaced = await deadline(page.evaluate(async () => { const p = window.pomme, old = p.breaking; await p.loadPack(document.querySelector('#mining-pack').files[0], { version: '1.20.4' }); return old.destroyed && p.breaking !== old && old.progress(99, [8, 15, 8], 8) === false; }), 'Pack reload'); assert.equal(replaced, true);
  joined.write('block_break_animation', { entityId: 99, location: position, destroyStage: 9 }); await page.waitForFunction(() => window.pomme.breaking.records.get(99)?.stage === 9);
  joined.write('block_break_animation', { entityId: 99, location: position, destroyStage: -1 }); await page.waitForFunction(() => !window.pomme.breaking.records.has(99));
  // The connection controls live in the hidden welcome panel after joining;
  // dispatch its real action to exercise production detach without opening UI.
  await page.evaluate(() => document.querySelector('#disconnect').click()); await page.waitForFunction(() => !window.pomme.session && !window.pomme.breaking && window.pomme.renderer.stats().breaking.meshes === 0);
  console.log('Main proof: remote replacement/reload/disconnect passed; importing source inventory.');
  await page.locator('#mining-region').setInputFiles(fixtureRegions()); await deadline(page.evaluate(() => window.pomme.importFiles([...document.querySelector('#mining-region').files], { version: '1.20.4' })), 'Native world import');
  await page.waitForFunction(() => Boolean(window.pomme.localInventory));
  const sourceInventory = await deadline(page.evaluate(async () => {
    const p = window.pomme, local = p.localInventory, state = local.authority.state, item = name => p.registry.items.find(item => item.name === name).id;
    if (state.selected !== 2 || state.player[2].itemId !== item('oak_planks') || state.player[2].itemCount !== 10 || state.player[39].itemId !== item('diamond_helmet') || state.player[40].itemId !== item('shield') || state.player[0].present) throw new Error('Main import replaced source inventory with starter slots.');
    local.session.setCreativeSlot(item('stone'), 7, 2); await local.pending; await p.saveInventory(); await p.resumeImported();
    const restored = p.localInventory.authority.state;
    if (!local.closed || !p.localInventory.authority.initial.restored || restored.player[2].itemId !== item('stone') || restored.player[2].itemCount !== 7 || restored.selected !== 2) throw new Error('Main reopen replaced confirmed native inventory with original source.');
    const { restoreSourceLevelInventory } = await import('/src/source-level-inventory.js'), cached = await restoreSourceLevelInventory(p.world.worldKey);
    if (!cached?.present || cached.player.value.Inventory.value.entries[0].value.Count.value !== 10) throw new Error('Main source bootstrap cache lost its original typed descriptor.');
    return { selected: 2, sourcePlanks: 10, armorAndOffhandRetained: true, emptySlotRetained: true, nativeSaveOutranksSource: true, sourceCacheRetained: true };
  }), 'Source inventory save/reopen');
  console.log('Main proof: source bootstrap/save/reopen passed; testing unread source fallback.');
  await page.locator('#mining-region').setInputFiles(fixtureRegions({ unavailable: true }));
  const unreadSource = await deadline(page.evaluate(async () => {
    const p = window.pomme, previousKey = p.world.worldKey;
    const files = [...document.querySelector('#mining-region').files].map(file => new File([file], file.name, { type: file.type, lastModified: file.lastModified + 1000 }));
    await p.importFiles(files, { version: '1.20.4' });
    if (p.world.worldKey === previousKey || !p.ready || p.core.block_get(8, 15, 8) === 0 || p.localInventory) throw new Error('Unread source inventory stopped terrain import or seeded a starter UI.');
    const { restoreSourceLevelInventory } = await import('/src/source-level-inventory.js'), marker = await restoreSourceLevelInventory(p.world.worldKey);
    if (marker?.present !== true || marker.player !== null || !marker.unavailable?.reason) throw new Error('Unread source marker was not persisted.');
    await p.resumeImported();
    if (p.localInventory || !p.ready) throw new Error('Unread source marker became starter inventory on resume.');
    const [{ InventoryAuthority }, { loadNativeCraftingData }] = await Promise.all([import('/authority/inventory-client.js'), import('/authority/native-crafting-data.js')]);
    const data = await loadNativeCraftingData(document.querySelector('#mining-pack').files[0], { registry: p.registry });
    const clean = await InventoryAuthority.open({ registry: p.registry, data, worldKey: p.world.worldKey });
    try { if (clean.initial.restored) throw new Error('Unread source fallback wrote a starter inventory save.'); }
    finally { await clean.close({ save: false }); }
    return { terrainImported: true, markerRetained: true, builderRemainsAvailable: true, resumeRetainsDefer: true, starterSaveWritten: false };
  }), 'Unread source inventory import/reopen');
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/breaking-main.png' });
  const proof = { version, assets: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated fixture', local, remote, replacementCleared: true, packReloadRetiresOldOverlay: replaced, packetRemove: true, disconnectClears: true, sourceInventory, unreadSource, errors, softwareGPU: software };
  await writeFile('test-results/breaking-main.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  console.error('Main proof diagnostic:', { error: error.message, errors, joined: Boolean(joined), packets: packets.map(packet => packet.name) });
  if (page && !page.isClosed()) console.error(await deadline(page.evaluate(() => ({ engine: document.documentElement.dataset.engine,
    error: document.querySelector('#error')?.textContent, connection: document.querySelector('#connection-status')?.textContent,
    ready: window.pomme?.ready, mode: window.pomme?.mode, block: window.pomme?.core?.block_get(8, 15, 8),
    state: window.pomme?.session?.state?.status, breaking: window.pomme?.breaking?.stats(), renderer: window.pomme?.renderer?.stats(),
    irradiance: window.pomme?.world?.irradiance?.stats() })), 'Failure diagnostic', 5000).catch(diagnostic => diagnostic.message));
  throw error;
} finally { await browser?.close(); joined?.end(); await gateway?.close(); server.close(); }
