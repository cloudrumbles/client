import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import minecraftProtocol from 'minecraft-protocol';
import minecraftData from 'minecraft-data';
import { zipSync } from '../vendor/fflate.js';
import { encodeValue } from '../scripts/gateway.mjs';
import { createResourcePackProxy } from '../scripts/resource-pack-proxy.mjs';

// Use actual packet codecs through a named gateway fixture, while controlling
// file-read timing to expose queued world reset/connection lifecycle races.
const base = process.env.POMME_URL ?? 'http://127.0.0.1:5173', origin = new URL(base).origin;
const version = '1.20.4', registry = minecraftData(version), encoder = new TextEncoder();
const writer = minecraftProtocol.createSerializer({ state: 'play', isServer: true, version });
const reader = minecraftProtocol.createDeserializer({ state: 'play', isServer: false, version });
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const soundPack = zipSync({
  'assets/minecraft/sounds.json': encoder.encode(JSON.stringify({ 'integration.server': { sounds: ['integration/server'] } })),
  'assets/minecraft/sounds/integration/server.ogg': new Uint8Array([79, 103, 103, 83]),
});
const localPack = zipSync({ 'assets/minecraft/sounds.json': encoder.encode('{}') });
const proxy = createResourcePackProxy({ allowedOrigins: [origin], allowPrivateHosts: ['127.0.0.1'] });
const gateway = createServer(async (req, res) => {
  if (req.url === '/sound.zip') { res.writeHead(200, { 'Content-Length': soundPack.length }); res.end(soundPack); return; }
  if (!await proxy.handleRequest(req, res)) res.writeHead(404).end();
});
const sockets = [], packets = [], websocket = new WebSocketServer({ server: gateway });
websocket.on('connection', socket => {
  sockets.push(socket); socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); packets.push(message);
    if (message.type === 'connect') socket.send(JSON.stringify({ type: 'connected', version, username: 'Audit', uuid: '00000000-0000-0000-0000-000000000009' }));
  });
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const gatewayUrl = `ws://127.0.0.1:${gateway.address().port}`;
function send(socket, name, params, extra = {}) {
  const bytes = writer.createPacketBuffer({ name, params });
  if (name === 'respawn') bytes[bytes.length - 1] = Number(params.copyMetadata);
  const packet = reader.parsePacketBuffer(bytes).data;
  if (name === 'respawn') packet.params.copyMetadata = bytes.at(-1);
  socket.send(JSON.stringify(encodeValue({ type: 'packet', name: packet.name, data: { ...packet.params, ...extra }, state: 'play' })));
}
function login(socket) {
  send(socket, 'login', registry.loginPacket);
  send(socket, 'position', { x: 0.5, y: 70, z: 0.5, yaw: 180, pitch: 0, flags: 0, teleportId: 1 });
}
const software = process.env.POMME_SOFTWARE_GPU === '1';
const launchBrowser = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
let browser = await launchBrowser();
const errors = [], proof = {};
async function freshPage(context) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.evaluate(() => { document.querySelector('#quality').value = 'low'; document.querySelector('#cycle').checked = false; document.querySelector('#adaptive').checked = false; });
  await page.waitForFunction(() => Boolean(window.pomme) || document.documentElement.dataset.engine === 'error', null, { timeout: 60000 });
  assert.ok(await page.evaluate(() => Boolean(window.pomme)), await page.locator('#error').textContent());
  return page;
}
try {
  const context = await browser.newContext({ viewport: { width: 480, height: 270 } });
  const page = await freshPage(context);
  console.log('Checking queued world reset hydration.');
  await page.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'delayed-local-pack.zip');
    const read = file.arrayBuffer.bind(file);
    window.releaseLocalRead = null;
    Object.defineProperty(file, 'arrayBuffer', { value: async () => {
      window.localReadStarted = true;
      await new Promise(resolve => { window.releaseLocalRead = resolve; });
      return read();
    } });
    const input = document.querySelector('#resource-pack');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new Event('change'));
  }, [...localPack]);
  await page.waitForFunction(() => window.localReadStarted);
  await page.evaluate(gateway => window.pomme.connectServer({ host: 'fixture.invalid', username: 'Audit', auth: 'offline', version: '1.20.4', resourcePacks: 'enabled', gateway }), gatewayUrl);
  login(sockets[0]);
  send(sockets[0], 'entity_effect', { entityId: registry.loginPacket.entityId, effectId: 24, amplifier: 1, duration: 1200, hideParticles: 0, factorCodec: undefined });
  await page.waitForFunction(() => window.pomme.session?.state.effects?.some(effect => effect.id === 24));
  const pendingGeneration = await page.evaluate(() => window.pomme.world.generation);
  await page.evaluate(() => window.releaseLocalRead());
  await page.waitForFunction(generation => window.pomme.world.generation > generation && window.pomme.player.effectLevel('levitation') === 2 && window.pomme.player.position[0] === 0.5, pendingGeneration, { timeout: 60000 });
  proof.queuedReset = await page.evaluate(() => ({ generation: window.pomme.world.generation, localEffectLevel: window.pomme.player.effectLevel('levitation'), sessionEffects: window.pomme.session.state.effects, entityId: window.pomme.session.state.entityId }));
  console.log('Checking same-dimension respawn retention and different-dimension reset.');
  const chunkData = Buffer.concat(Array.from({ length: 24 }, (_, index) => Buffer.from(index === 0 ? [16, 0, 0, registry.blocksByName.stone.defaultState, 0, 0, registry.biomesByName.plains.id, 0] : [0, 0, 0, 0, 0, 0, registry.biomesByName.plains.id, 0])));
  send(sockets[0], 'map_chunk', { x: 0, z: 0, heightmaps: { type: 'compound', value: {} }, chunkData, blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
  send(sockets[0], 'spawn_entity', { entityId: 44, objectUUID: '12345678-1234-1234-1234-123456789012', type: registry.entitiesByName.pig.id, x: 2, y: 70, z: 2, pitch: 0, yaw: 0, headPitch: 0, objectData: 0, velocity: { x: 0, y: 0, z: 0 } });
  await page.waitForFunction(() => window.pomme.world.columns.has('0,0') && window.pomme.entities.entities.has(44));
  const retainedGeneration = await page.evaluate(() => window.pomme.world.generation);
  const respawn = { dimension: 'minecraft:overworld', worldName: 'minecraft:overworld', hashedSeed: 1n, gamemode: 0, previousGamemode: 0, isDebug: false, isFlat: false, portalCooldown: 0, copyMetadata: 3 };
  send(sockets[0], 'respawn', respawn);
  send(sockets[0], 'position', { x: 3.5, y: 70, z: 3.5, yaw: 180, pitch: 0, flags: 0, teleportId: 2 });
  await page.waitForFunction(() => window.pomme.ready && window.pomme.player.position[0] === 3.5 && window.pomme.session.state.status === 'playing');
  proof.sameLevelRespawn = await page.evaluate(() => ({ generation: window.pomme.world.generation, worldColumns: window.pomme.world.columns.size, sessionColumns: window.pomme.session.columns.size, remoteEntity: window.pomme.entities.entities.has(44), block: window.pomme.core.block_get(0, -64, 0), effects: window.pomme.player.effects.size }));
  assert.equal(proof.sameLevelRespawn.generation, retainedGeneration); assert.equal(proof.sameLevelRespawn.worldColumns, 1); assert.equal(proof.sameLevelRespawn.sessionColumns, 1); assert.equal(proof.sameLevelRespawn.remoteEntity, true); assert.equal(proof.sameLevelRespawn.block, registry.blocksByName.stone.defaultState); assert.equal(proof.sameLevelRespawn.effects, 0);
  send(sockets[0], 'respawn', { ...respawn, dimension: 'minecraft:the_nether', worldName: 'minecraft:the_nether', copyMetadata: 0 });
  send(sockets[0], 'position', { x: 4.5, y: 70, z: 4.5, yaw: 180, pitch: 0, flags: 0, teleportId: 3 });
  await page.waitForFunction(generation => window.pomme.ready && window.pomme.world.generation > generation && window.pomme.player.position[0] === 4.5, retainedGeneration);
  proof.changedLevelRespawn = await page.evaluate(() => ({ generation: window.pomme.world.generation, worldColumns: window.pomme.world.columns.size, sessionColumns: window.pomme.session.columns.size, remoteEntities: window.pomme.entities.entities.size }));
  assert.equal(proof.changedLevelRespawn.worldColumns, 0); assert.equal(proof.changedLevelRespawn.sessionColumns, 0); assert.equal(proof.changedLevelRespawn.remoteEntities, 0);
  await page.close(); await context.close();
  // Separate browser processes release the software GPU device completely
  // while ensuring the audio restoration scenario starts with fresh storage.
  await browser.close(); browser = await launchBrowser();

  // Fresh browser storage proves removing the server stack restores a null
  // base and clears both sound registration and retained OGG memory.
  const secondContext = await browser.newContext({ viewport: { width: 480, height: 270 } });
  const secondPage = await freshPage(secondContext);
  console.log('Checking removal of server audio assets without a local base.');
  await secondPage.evaluate(gateway => window.pomme.connectServer({ host: 'fixture.invalid', username: 'Audit', auth: 'offline', version: '1.20.4', resourcePacks: 'enabled', gateway }), gatewayUrl);
  login(sockets[1]);
  await secondPage.waitForFunction(() => window.pomme.world.mode === 'server' && window.pomme.session.state.status === 'playing', null, { timeout: 60000 });
  const advertised = proxy.registerAdvertisedPack({ uuid, url: `${gatewayUrl.replace('ws:', 'http:')}/sound.zip`, hash: createHash('sha1').update(soundPack).digest('hex'), forced: false }, 'integration-audio');
  send(sockets[1], 'add_resource_pack', advertised, { download: advertised.download });
  await secondPage.waitForFunction(() => window.pomme.serverPacks.stats().loaded === 1, null, { timeout: 60000 });
  const loaded = await secondPage.evaluate(() => ({ event: window.pomme.audio.library.events.has('minecraft:integration.server'), sounds: window.pomme.audio.library.files.size, bytes: window.pomme.audio.library.bytes }));
  assert.equal(loaded.event, true); assert.equal(loaded.sounds, 1); assert.equal(loaded.bytes, 4);
  send(sockets[1], 'remove_resource_pack', { uuid });
  await secondPage.waitForFunction(() => window.pomme.serverPacks.stats().requested === 0 && window.pomme.audio.library.events.size === 0 && window.pomme.audio.library.files.size === 0, null, { timeout: 60000 });
  proof.removedAudio = await secondPage.evaluate(() => ({ events: window.pomme.audio.library.events.size, files: window.pomme.audio.library.files.size, bytes: window.pomme.audio.library.bytes, packets: window.pomme.serverPacks.stats() }));
  await secondPage.close(); await secondContext.close();
  assert.deepEqual(errors, []);
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/integration-lifecycle.json', JSON.stringify({ ...proof, errors }, null, 2));
  console.log(JSON.stringify({ ...proof, errors }, null, 2));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(await page.evaluate(() => ({ error: document.querySelector('#error')?.textContent, engine: document.documentElement.dataset.engine,
      status: document.querySelector('#world-status')?.textContent, session: window.pomme?.session?.state, playerEffects: window.pomme?.player ? [...window.pomme.player.effects] : null,
      generation: window.pomme?.world?.generation, mode: window.pomme?.world?.mode, localReadStarted: window.localReadStarted, pack: window.pomme?.serverPacks?.stats(), audio: window.pomme?.audio?.stats() })).catch(() => ({ closed: true })));
  }
  throw error;
} finally {
  await browser.close(); proxy.close(); for (const socket of sockets) socket.terminate();
  await new Promise(resolve => websocket.close(resolve)); await new Promise(resolve => gateway.close(resolve));
}
