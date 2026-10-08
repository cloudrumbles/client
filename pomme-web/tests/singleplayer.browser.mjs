// Runs against an actual Pumpkin process; no simulated protocol server is used.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingleplayerManager } from '../scripts/singleplayer.mjs';
import { createGateway } from '../scripts/gateway.mjs';

const url = process.env.POMME_URL || 'http://127.0.0.1:5173';
const version = process.env.POMME_PUMPKIN_VERSION || '1.21.11';
const suppliedPort = Number(process.env.POMME_TEST_SERVER_PORT || 0);
const binary = process.env.POMME_PUMPKIN_BINARY;
const minimumColumns = Number(process.env.POMME_TEST_MIN_COLUMNS || 25);
if (!suppliedPort && !binary) throw new Error('Set POMME_PUMPKIN_BINARY to a compatible Pumpkin executable, or POMME_TEST_SERVER_PORT to an already-running Pumpkin world.');
const errors = [], events = [], report = { version, backend: 'Pumpkin', actualServer: true };
let manager, saveDirectory, gateway, browser, page, world, endpoint;
async function connect(endpoint) {
  gateway = await createGateway({ port: 0, allowedOrigins: [new URL(url).origin], allowDestinations: [`127.0.0.1:${endpoint.port}`] });
  await page.evaluate(async options => { await window.pomme.connectServer(options); }, { ...endpoint, gateway: `ws://127.0.0.1:${gateway.address.port}` });
  await page.evaluate(() => {
    const session = window.pomme.session, previous = session.callbacks.onEvent;
    window.pumpkinEvents = [];
    session.callbacks.onEvent = event => { if (window.pumpkinEvents.length < 512) window.pumpkinEvents.push({ type: event.type, message: event.message, text: event.text }); previous?.(event); };
  });
  try {
    // keys includes empty meshes queued while resetting the world. nearReady
    // records meshes whose native columns really arrived from the server.
    await page.waitForFunction(minimum => (window.pomme.session?.state.status === 'playing' && window.pomme.world.nearReady.size >= minimum && window.pomme.core.world_light_section_count() > 0 && window.pomme.renderer.stats().triangles > 0) || window.pomme.session?.state.status === 'disconnected', minimumColumns, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.pomme.session.state.status), 'playing');
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({ state: window.pomme.session?.state, events: window.pumpkinEvents, columns: window.pomme.session?.columns.size, meshes: window.pomme.world.keys.size, readyColumns: window.pomme.world.nearReady.size, lightSections: window.pomme.core.world_light_section_count(), status: document.querySelector('#world-status').textContent }));
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic)}`);
  }
}

try {
  if (!suppliedPort) {
    saveDirectory = await mkdtemp(join(tmpdir(), 'pomme-pumpkin-browser-'));
    manager = new SingleplayerManager({ savesDir: saveDirectory, server: { kind: 'pumpkin', version, command: binary, args: [], viewDistance: 2, simulationDistance: 2, configurationFormat: process.env.POMME_PUMPKIN_CONFIG || (version === '1.21.11' ? 'split' : 'merged') }, clientVersion: version, startupTimeoutMs: 120000 });
    world = await manager.createWorld({ name: 'Browser singleplayer verification', seed: '7', gameMode: 'creative', allowCommands: true });
    endpoint = await manager.startWorld(world.id, { username: 'PommeTest' });
  } else endpoint = { host: '127.0.0.1', port: suppliedPort, version, auth: 'offline', username: 'PommeTest' };
  const software = process.env.POMME_SOFTWARE_GPU === '1';
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
  page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const location = message.location().url;
    if (message.type() === 'error' && !message.text().includes('favicon.ico') && !/\/favicon\.ico(?:$|\?)/.test(location)) errors.push(`${message.text()}${location ? ` (${location})` : ''}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.engine === 'ready' || document.documentElement.dataset.engine === 'error', null, { timeout: 60000 });
  assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready', await page.locator('#error').textContent());
  await page.selectOption('#quality', 'low', { force: true });
  await page.evaluate(() => { document.querySelector('#adaptive').checked = false; });
  if (process.env.POMME_MINECRAFT_JAR) {
    await page.locator('#resource-pack').setInputFiles(process.env.POMME_MINECRAFT_JAR);
    await page.waitForFunction(() => document.querySelector('#pack-status').textContent.includes('block states'), null, { timeout: 120000 });
    const importedFrame = await page.evaluate(() => window.pomme.renderer.stats().frameCount);
    await page.waitForFunction(frame => window.pomme.renderer.stats().frameCount > frame + 1 || document.documentElement.dataset.engine === 'error', importedFrame, { timeout: 30000 });
    assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready', await page.locator('#error').textContent());
    report.resourcePack = await page.locator('#pack-status').textContent();
  }
  console.log('Joining the actual Pumpkin world through WebGPU, WASM and the TCP gateway.');
  await connect(endpoint);
  report.initial = await page.evaluate(() => ({ state: { ...window.pomme.session.state }, position: [...window.pomme.player.position], nativeY: [window.pomme.core.world_min_y(), window.pomme.core.world_height()], columns: window.pomme.session.columns.size, meshes: window.pomme.world.keys.size, lightSections: window.pomme.core.world_light_section_count(), renderer: window.pomme.renderer.stats() }));
  assert.equal(report.initial.state.version, version);
  assert.deepEqual(report.initial.nativeY, [-64, 384]);
  assert.equal(report.initial.state.gameMode, 1);
  assert.ok(report.initial.lightSections > 0);
  console.log(JSON.stringify({ phase: 'native-world-loaded', columns: report.initial.columns, nativeY: report.initial.nativeY, lightSections: report.initial.lightSections }));
  const target = await page.evaluate(() => {
    const registry = window.pomme.registry, stone = registry.items.find(item => item.name === 'stone');
    window.pomme.session.setCreativeSlot(stone.id, 32, 0);
    const position = window.pomme.player.position;
    return { x: Math.floor(position[0]) + 2, y: Math.floor(position[1]), z: Math.floor(position[2]), state: registry.blocks.find(block => block.name === 'glowstone').defaultState, stoneId: stone.id };
  });
  await page.waitForFunction(() => window.pomme.session.windows.get(0)?.slots[36]?.itemCount === 32, null, { timeout: 30000 });
  await page.evaluate(target => window.pomme.session.chat(`/setblock ${target.x} ${target.y} ${target.z} minecraft:glowstone`), target);
  await page.waitForFunction(target => window.pomme.core.block_get(target.x, target.y, target.z) === target.state, target, { timeout: 30000 });
  report.persistedBlock = target;
  assert.ok(await page.evaluate(() => window.pomme.session.clickWindow(36)));
  await page.waitForFunction(() => window.pomme.session.windows.get(0)?.cursor?.itemCount === 32, null, { timeout: 30000 });
  assert.ok(await page.evaluate(() => window.pomme.session.clickWindow(37)));
  await page.waitForFunction(() => window.pomme.session.windows.get(0)?.slots[37]?.itemCount === 32 && !window.pomme.session.windows.get(0)?.slots[36]?.present && !window.pomme.session.windows.get(0)?.cursor?.present, null, { timeout: 30000 });
  await page.evaluate(() => { document.querySelector('#welcome').hidden = true; document.querySelector('#pause').hidden = true; });
  // Review a populated native view after streaming, rather than taking the
  // first four-column loading frame as visual evidence for the entire world.
  const captureFrame = await page.evaluate(() => {
    window.pomme.session.setFlying(true);
    window.pomme.player.yaw = 0.6; window.pomme.player.pitch = -0.55;
    return window.pomme.renderer.stats().frameCount;
  });
  await page.waitForFunction(frame => window.pomme.renderer.stats().frameCount > frame + 2, captureFrame, { timeout: 30000 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/pumpkin-singleplayer.png' });
  report.gameplay = await page.evaluate(() => ({ inventory: window.pomme.session.windows.get(0), entityCount: window.pomme.session.entities.size, render: window.pomme.renderer.stats(), events: window.pumpkinEvents }));
  if (manager) {
    await page.evaluate(() => window.pomme.session.disconnect());
    await gateway.close(); gateway = null;
    report.saved = await manager.stopWorld();
    assert.equal(report.saved.saved, true);
    report.regionFiles = (await readdir(join(manager.worldPath(world.id), 'world', 'region'))).filter(name => name.endsWith('.mca'));
    assert.ok(report.regionFiles.length > 0);
    endpoint = await manager.startWorld(world.id, { username: 'PommeTest' });
    await connect(endpoint);
    await page.waitForFunction(target => window.pomme.core.block_get(target.x, target.y, target.z) === target.state, target, { timeout: 60000 });
    // This inventory arrives in the new login's actual window_items packet,
    // proving the creative edit and both clicks were accepted and persisted.
    await page.waitForFunction(target => { const inventory = window.pomme.session.windows.get(0); return inventory?.slots[37]?.itemId === target.stoneId && inventory.slots[37].itemCount === 32 && !inventory.slots[36]?.present; }, target, { timeout: 30000 });
    report.reopened = { blockPersisted: true, creativeInventoryAndClicksPersisted: true, sameWorldId: world.id };
  }
  events.push(...report.gameplay.events);
  assert.deepEqual(errors, []);
  assert.deepEqual(events.filter(event => event.type === 'error'), []);
  report.browserErrors = errors;
  await writeFile('test-results/pumpkin-singleplayer.json', JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log(JSON.stringify({ version, columns: report.initial.columns, nativeY: report.initial.nativeY, lightSections: report.initial.lightSections, blockUpdate: true, creativeInventory: true, inventoryClick: true, savedAndReopened: !!report.reopened, browserErrors: errors }));
} catch (error) {
  report.failure = error.message;
  if (page) {
    try { report.diagnostic = await page.evaluate(() => ({ state: window.pomme.session?.state, inventory: window.pomme.session?.windows.get(0), events: window.pumpkinEvents, readyColumns: window.pomme.world.nearReady.size, lightSections: window.pomme.core.world_light_section_count() })); } catch {}
  }
  report.browserErrors = errors;
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/pumpkin-singleplayer.json', JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  throw error;
} finally {
  if (page) { try { await page.evaluate(() => window.pomme.session?.disconnect()); } catch {} }
  if (browser) await browser.close();
  if (gateway) await gateway.close();
  if (manager) await manager.close();
  if (saveDirectory) await rm(saveDirectory, { recursive: true, force: true });
}
