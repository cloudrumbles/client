// Production source fog: actual native protocol and imported save lifecycle.
// Default assets are generated; matching original client JARs remain private.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { zipSync, zlibSync, gzipSync } from 'fflate';
import { createGateway } from '../scripts/gateway.mjs';
import { sourceInventoryFixture } from './fixtures/source-inventory-nbt.js';

const version = process.env.POMME_MINECRAFT_VERSION ?? '1.20.4', data = minecraftData(version), stone = data.blocksByName.stone.defaultState, encode = new TextEncoder();
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
    { Y: [1, 0], SkyLight: [7, new Uint8Array(2048).fill(255)], BlockLight: [7, new Uint8Array(2048)], block_states: [10, { palette: [9, { type: 10, entries: [{ Name: [8, 'minecraft:water'], Properties: [10, { level: [8, '0'] }] }] }] }] },
  ] }] })), sectors = Math.ceil((chunk.length + 5) / 4096), region = Buffer.alloc((2 + sectors) * 4096);
  region.writeUInt32BE(2 * 256 + sectors, 0); region.writeUInt32BE(chunk.length + 1, 8192); region[8196] = 2; region.set(chunk, 8197);
  const source = sourceInventoryFixture(version), spawn = payload(10, { SpawnX: [3, 8], SpawnY: [3, 2], SpawnZ: [3, 8], LevelName: [8, 'Main source inventory fixture'], DayTime: [4, 7000000000000000004n] });
  // Both final END tags close Data and root. Insert ordinary world metadata
  // inside Data while retaining the source fixture's original typed Player.
  const level = gzipSync(unavailable ? nbt({ Data: [10, { DataVersion: [3, 3700], Version: [10, { Name: [8, version] }], SpawnX: [3, 8], SpawnY: [3, 2], SpawnZ: [3, 8], LevelName: [8, 'Mechanical unread source inventory'], Player: [8, 'Invalid source Player type'] }] }) : concat([source.subarray(0, source.length - 2), spawn.subarray(0, spawn.length - 1), source.subarray(source.length - 2)]));
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
  for (const name of ['stone', 'oak_planks', 'crafting_table', 'water', 'lava', 'powder_snow']) { files[`assets/minecraft/models/block/${name}.json`] = model; files[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `minecraft:block/${name}` } } }; }
  files['data/minecraft/worldgen/biome/plains.json'] = { effects: { water_fog_color: 0x123456 }, attributes: { 'minecraft:visual/water_fog_color': '#123456' } };
  files['data/example/dimension_type/wet.json'] = { attributes: {}, timelines: ['example:day'] };
  files['data/example/timeline/day.json'] = { period_ticks: 10, tracks: { 'minecraft:visual/water_fog_end_distance': { keyframes: [{ ticks: 0, value: 20 }, { ticks: 8, value: 100 }] } } };
  files['data/minecraft/tags/worldgen/biome/has_closer_water_fog.json'] = { replace: true, values: ['minecraft:plains'] };
  for (let stage = 0; stage < 10; stage++) files[`assets/minecraft/textures/block/destroy_stage_${stage}.png`] = texture(stage);
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, value instanceof Uint8Array ? value : encode.encode(JSON.stringify(value))]))));
}
const modern = version !== '1.20.4', varint = input => { let value = input >>> 0; const bytes = []; do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value); return bytes; };
const water = data.blocksByName.water.defaultState, plains = data.biomesByName.plains.id;
const section = (state, filled) => concat([[filled ? 16 : 0, 0, 0], varint(state), modern ? [] : [0], [0], varint(plains), modern ? [] : [0]]);
const chunkData = concat(Array.from({ length: 24 }, (_, index) => section(index === 4 ? water : 0, index === 4)));
const url = process.env.POMME_URL ?? 'http://127.0.0.1:5173', software = process.env.POMME_SOFTWARE_GPU === '1', errors = [], packets = [];
let browser, gateway, joined, page, teleportId = 0;
const server = minecraftProtocol.createServer({ host: '127.0.0.1', port: 0, version, 'online-mode': false, keepAlive: false, hideErrors: true, maxPlayers: 2 });
server.on('error', error => errors.push(error.message)); await once(server, 'listening'); const port = server.socketServer.address().port;
function position(y) { joined.write('position', { x: 8.5, y, z: 8.5, yaw: 180, pitch: 0, flags: modern ? {} : 0, teleportId: ++teleportId, ...(modern ? { dx: 0, dy: 0, dz: 0 } : {}) }); }
function effect(name, duration = -1, options = {}) {
  const id = data.effectsArray.find(effect => effect.name.toLowerCase().replaceAll('_', '') === name.replaceAll('_', ''))?.id;
  assert.ok(Number.isInteger(id), `Missing source effect ${name}.`);
  joined.write('entity_effect', { entityId: 42, effectId: id, amplifier: 0, duration, ...(modern ? { flags: 8 } : { hideParticles: 0, factorCodec: null }), ...options });
  return id;
}
const remove = id => joined.write('remove_entity_effect', { entityId: 42, effectId: id });
const block = (y, state) => joined.write('block_change', { location: { x: 8, y, z: 8 }, type: state });
server.on('playerJoin', client => {
  joined = client; client.on('packet', (params, metadata) => packets.push({ name: metadata.name, params })); client.on('error', error => errors.push(error.message));
  client.write('login', { ...data.loginPacket, entityId: 42, ...(modern ? { worldState: { ...data.loginPacket.worldState, gamemode: 'spectator', isFlat: false, hashedSeed: 1650n } } : { gameMode: 3, hashedSeed: 1650n }) });
  position(1.88);
  client.write('chunk_batch_start', {}); client.write('map_chunk', { x: 0, z: 0, heightmaps: modern ? [] : { type: 'compound', value: {} }, chunkData, blockEntities: [], skyLightMask: [32n], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [32n], skyLight: [Array(2048).fill(255)], blockLight: [] }); client.write('chunk_batch_finished', { batchSize: 1 });
  if (version === '26.1') {
    const entries = (data.registryCodec ?? data.loginPacket.dimensionCodec)['minecraft:world_clock'].entries;
    client.write('update_time', { age: 1000n, clockUpdates: [{ id: entries.findIndex(entry => entry.key === 'minecraft:overworld'), totalTicks: 7000000000000000004n, partialTick: 0, rate: 0 }] });
  } else client.write('update_time', { age: 1000n, time: modern ? 7000000000000000004n : -7000000000000000004n, ...(modern ? { tickDayTime: false } : {}) });
});
try {
  gateway = await createGateway({ port: 0, allowedOrigins: [new URL(url).origin], allowDestinations: [`127.0.0.1:${port}`] });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
  page = await browser.newPage({ viewport: { width: 480, height: 270 } }); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { const location = message.location().url; if (message.type() === 'error' && !message.text().includes('favicon.ico') && !location?.endsWith('/favicon.ico')) errors.push(`${message.text()}${location ? ` at ${location}` : ''}`); });
  await page.goto(url); await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.engine)); assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready');
  await page.evaluate(() => { document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false; document.querySelector('#quality').value = 'low'; const scale = document.querySelector('#resolution'); scale.value = '.5'; scale.dispatchEvent(new Event('input')); for (const id of ['fog-pack', 'fog-region']) { const input = document.createElement('input'); input.type = 'file'; input.id = id; input.multiple = true; document.body.append(input); } });
  await page.locator('#fog-pack').setInputFiles(process.env.POMME_MINECRAFT_JAR ?? { name: 'fog-fixture.zip', mimeType: 'application/zip', buffer: fixturePack() });
  console.log(`Main fog ${version}: admitting pack.`);
  await deadline(page.evaluate(version => window.pomme.loadPack(document.querySelector('#fog-pack').files[0], { version }), version), 'User pack admission');
  await deadline(page.evaluate(options => window.pomme.connectServer(options), { host: '127.0.0.1', port, username: 'FogBrowser', auth: 'offline', gateway: `ws://127.0.0.1:${gateway.address.port}`, version }), 'Native protocol connection');
  await page.waitForFunction(state => window.pomme.ready && window.pomme.session?.state.status === 'playing' && window.pomme.core.block_get(8, 3, 8) === state && window.pomme.renderer.stats().environmentFog?.type === 'water', water);
  await page.waitForFunction(() => window.pomme.environment.stats().waterVisionTime >= 100);
  const initial = await page.evaluate(() => ({ environment: window.pomme.environment.stats(), rendererFog: window.pomme.renderer.stats().environmentFog, seed: String(window.pomme.world.biomeSeed), eye: window.pomme.player.eye }));
  assert.equal(initial.environment.version, version); assert.equal(initial.environment.attributes.resolved, true); assert.equal(initial.seed, '1650'); assert.equal(initial.rendererFog.type, 'water');
  const dryBefore = initial.environment.waterVisionTime; position(2.30); block(4, 0);
  await page.waitForFunction(() => window.pomme.environment.stats().fog === null && window.pomme.renderer.stats().environmentFog === null);
  block(4, water); await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'water');
  const fullAbove = await page.evaluate(() => ({ eye: window.pomme.player.eye, type: window.pomme.environment.stats().fog.type })); assert.ok(fullAbove.eye[1] > 3 + 8 / 9 && fullAbove.eye[1] < 4);
  position(1.88); block(4, 0); block(3, data.blocksByName.lava.defaultState);
  await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'lava');
  const fire = effect('fire_resistance'); await page.waitForFunction(() => window.pomme.environment.stats().fog?.end === window.pomme.renderer.stats().farPlane * .5);
  // Spectator priority uses the render-distance range even with fire resistance.
  const lava = await page.evaluate(() => window.pomme.environment.stats().fog); assert.equal(lava.start, -8); remove(fire);
  block(3, data.blocksByName.powder_snow.defaultState); await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'powder-snow');
  const night = effect('night_vision'); await page.waitForFunction(() => Math.max(...window.pomme.environment.stats().fog.color) > .999);
  const snowNight = await page.evaluate(() => window.pomme.environment.stats().fog.color);
  const dark = effect('darkness', 1000, modern ? { flags: 0 } : { factorCodec: null });
  await page.waitForFunction(() => Math.max(...window.pomme.environment.stats().fog.color) < .9);
  const presence = await page.evaluate(() => ({ fog: window.pomme.environment.stats().fog, darkness: window.pomme.environment.stats().darkness }));
  assert.ok(Math.max(...presence.fog.color) < .9); if (modern) assert.equal(presence.darkness.factor, 1); else assert.equal(presence.darkness, null);
  remove(night); remove(dark); block(3, water); await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'water' && window.pomme.player.eyesInWater && window.pomme.environment.stats().waterVisionTime >= 100);
  console.log(`Main fog ${version}: native immersion/effects passed; replacing pack.`);
  const beforePack = await page.evaluate(() => ({ water: window.pomme.environment.stats().waterVisionTime, seed: String(window.pomme.world.biomeSeed) }));
  await deadline(page.evaluate(version => window.pomme.loadPack(document.querySelector('#fog-pack').files[0], { version }), version), 'Pack replacement');
  await page.waitForFunction(() => window.pomme.ready && window.pomme.renderer.stats().environmentFog?.type === 'water');
  const afterPack = await page.evaluate(() => ({ water: window.pomme.environment.stats().waterVisionTime, seed: String(window.pomme.world.biomeSeed), attributes: window.pomme.environment.stats().attributes }));
  assert.ok(afterPack.water >= beforePack.water, JSON.stringify({ beforePack, afterPack })); assert.equal(afterPack.seed, beforePack.seed); assert.equal(afterPack.attributes.resolved, true);
  let airEffects = null;
  if (process.env.POMME_FOG_AIR === '1') {
    block(3, 0); block(4, 0); await page.waitForFunction(() => window.pomme.environment.stats().fog === null);
    const blind = effect('blindness');
    await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'none' && window.pomme.renderer.stats().environmentFog?.code === 4);
    const blindness = await page.evaluate(() => window.pomme.environment.stats().fog);
    assert.equal(blindness.end, 5); assert.equal(blindness.start, 1.25); assert.deepEqual(blindness.color, [0, 0, 0]);
    remove(blind); await page.waitForFunction(() => window.pomme.environment.stats().fog === null);
    const darkness = effect('darkness', 1000, modern ? { flags: 0 } : { factorCodec: null });
    await page.waitForFunction(() => window.pomme.environment.stats().fog?.type === 'none' && window.pomme.environment.stats().fog.end === (window.pomme.environment.version === '1.20.4' ? 0 : 15));
    const dark = await page.evaluate(() => ({ fog: window.pomme.environment.stats().fog, attributes: window.pomme.environment.stats().attributes }));
    assert.deepEqual(dark.fog.color, [0, 0, 0]); assert.equal(dark.attributes.resolved, true);
    remove(darkness); await page.waitForFunction(() => window.pomme.environment.stats().fog === null);
    block(3, water); await page.waitForFunction(() => window.pomme.player.eyesInWater && window.pomme.environment.stats().waterVisionTime >= 100);
    airEffects = { actualNativeEffectWire: true, blindness, darkness: dark, nativeHandFogNone: 'separate renderer pixel control' };
  }
  await page.evaluate(() => document.querySelector('#disconnect').click()); await page.waitForFunction(() => !window.pomme.session && window.pomme.environment.stats().waterVisionTime === 0);
  console.log(`Main fog ${version}: pack lifecycle/detach passed; importing source.`);
  await page.locator('#fog-region').setInputFiles(fixtureRegions()); await deadline(page.evaluate(({ version, original }) => window.pomme.importFiles([...document.querySelector('#fog-region').files], { version, dimensionType: original ? 'minecraft:overworld' : 'example:wet' }), { version, original: Boolean(process.env.POMME_MINECRAFT_JAR) }), 'Native source import');
  await page.evaluate(() => { window.pomme.player.fly = true; window.pomme.player.noclip = true; });
  await page.waitForFunction(() => window.pomme.ready && window.pomme.environment.stats().fog?.type === 'water' && window.pomme.authority?.state.daytime === 7000000000000000004n);
  const imported = await page.evaluate(() => ({ fullSourceLong: String(window.pomme.authority.state.daytime), attributes: window.pomme.environment.stats().attributes, fog: window.pomme.environment.stats().fog, seed: String(window.pomme.world.biomeSeed) }));
  assert.equal(imported.attributes.resolved, true); if (modern && !process.env.POMME_MINECRAFT_JAR) assert.equal(imported.attributes.waterFogEnd, 60);
  await deadline(page.evaluate(() => window.pomme.resumeImported()), 'Source save reopen');
  await page.evaluate(() => { window.pomme.player.fly = true; window.pomme.player.noclip = true; });
  await page.waitForFunction(() => window.pomme.ready && window.pomme.environment.stats().fog?.type === 'water');
  const reopened = await page.evaluate(() => ({ fullSourceLong: String(window.pomme.authority.state.daytime), waterVisionTime: window.pomme.environment.stats().waterVisionTime, attributes: window.pomme.environment.stats().attributes }));
  assert.equal(reopened.fullSourceLong, imported.fullSourceLong); assert.equal(reopened.attributes.resolved, true);
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await page.screenshot({ path: `test-results/environment-main-${version}.png` });
  const proof = { validation: 'passed', version, assets: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated fixture', actualNativeTcpProtocol: true, initial, fullAbove, lava, snowNight, darknessPresence: presence, packReplacement: { before: beforePack, after: afterPack }, disconnectResetsVision: true, airEffects, imported, reopened, bounds: { biomeMaps: 4096, timelines: 32, gaussianSamples: 216, diagnostics: 32 }, errors, softwareGPU: software };
  await writeFile(`test-results/environment-main-${version}.json`, JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  console.error('Main fog diagnostic:', { error: error.message, errors, joined: Boolean(joined), packets: packets.map(packet => packet.name) });
  if (page && !page.isClosed()) console.error(await deadline(page.evaluate(() => ({ engine: document.documentElement.dataset.engine, error: document.querySelector('#error')?.textContent, ready: window.pomme?.ready, mode: window.pomme?.mode, environment: window.pomme?.environment?.stats(), rendererFog: window.pomme?.renderer?.stats().environmentFog, eye: window.pomme?.player?.eye, state: window.pomme?.session?.state })), 'Failure diagnostic', 5000).catch(diagnostic => diagnostic.message));
  throw error;
} finally { await browser?.close(); joined?.end(); await gateway?.close(); server.close(); }
