// Read-only diagnosis of a real managed Pumpkin world and privately supplied
// original client assets. Writes evidence only; no client modules are patched.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import minecraftData from 'minecraft-data';
import { SingleplayerManager } from '../scripts/singleplayer.mjs';
import { createGateway } from '../scripts/gateway.mjs';

const url = process.env.POMME_URL || 'http://127.0.0.1:5173', version = '1.21.11';
const binary = process.env.POMME_PUMPKIN_BINARY || '/workspace/Pumpkin-1.21.11/target/debug/pumpkin';
const jar = process.env.POMME_MINECRAFT_JAR || '/workspace/scratch/minecraft-1.21.11-client.jar';
const pumpkinBlocks = JSON.parse(await readFile(process.env.POMME_PUMPKIN_BLOCKS || '/workspace/Pumpkin-1.21.11/assets/blocks.json', 'utf8')).blocks;
const data = minecraftData(version), ranges = pumpkinBlocks.map(block => ({ name: block.name, min: block.states[0].id, max: block.states.at(-1).id, defaultState: block.default_state_id }));
const registryMismatches = ranges.filter(block => { const native = data.blocksByName[block.name]; return !native || native.minStateId !== block.min || native.maxStateId !== block.max || native.defaultState !== block.defaultState; });
assert.deepEqual(registryMismatches, []);
const report = { version, actualServer: true, originalAssets: true, registryComparison: { blocks: ranges.length, states: ranges.at(-1).max + 1, mismatches: registryMismatches }, errors: [] };
let manager, directory, gateway, browser, page;
try {
  directory = await mkdtemp(join(tmpdir(), 'pomme-visual-diagnostic-'));
  manager = new SingleplayerManager({ savesDir: directory, server: { kind: 'pumpkin', version, command: binary, args: [], viewDistance: 2, simulationDistance: 2, configurationFormat: 'split' }, clientVersion: version, startupTimeoutMs: 120000 });
  const world = await manager.createWorld({ name: 'Read-only native visual diagnosis', seed: '7', gameMode: 'creative', allowCommands: true });
  const endpoint = await manager.startWorld(world.id, { username: 'PommeTest' });
  gateway = await createGateway({ port: 0, allowedOrigins: [new URL(url).origin], allowDestinations: [`127.0.0.1:${endpoint.port}`] });
  const software = process.env.POMME_SOFTWARE_GPU === '1';
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
  page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(url); await page.waitForFunction(() => document.documentElement.dataset.engine === 'ready', null, { timeout: 60000 });
  await page.selectOption('#quality', 'low', { force: true });
  await page.evaluate(() => { document.querySelector('#adaptive').checked = false; });
  await page.locator('#resource-pack').setInputFiles(jar);
  await page.waitForFunction(() => document.querySelector('#pack-status').textContent.includes('block states'), null, { timeout: 120000 });
  await page.evaluate(async options => window.pomme.connectServer(options), { ...endpoint, gateway: `ws://127.0.0.1:${gateway.address.port}` });
  await page.waitForFunction(() => window.pomme.session?.state.status === 'playing' && window.pomme.world.nearReady.size >= 49, null, { timeout: 180000 });
  const frame = await page.evaluate(() => {
    window.pomme.session.setFlying(true); window.pomme.player.yaw = .6; window.pomme.player.pitch = -.55;
    document.querySelector('#welcome').hidden = true; document.querySelector('#pause').hidden = true;
    return window.pomme.renderer.stats().frameCount;
  });
  await page.waitForFunction(frame => window.pomme.renderer.stats().frameCount > frame + 3, frame, { timeout: 60000 });
  report.live = await page.evaluate(ranges => {
    const p = window.pomme, byId = new Map(), names = new Map(), states = new Map(), topNames = new Map(), mismatches = [], unsupported = new Map(), examples = new Map();
    for (const block of p.registry.blocks) for (let id = block.minStateId; id <= block.maxStateId; id++) byId.set(id, block);
    const actualServerName = id => ranges.find(block => id >= block.min && id <= block.max)?.name;
    let blocks = 0, unknown = 0, missingMaterials = 0, coreChecks = 0, coreMismatches = 0, nonAirCountMismatches = 0;
    const mapAdd = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    for (const column of p.session.columns.values()) {
      const tops = new Map();
      for (const section of column.sections) {
        let nonAir = 0;
        for (let index = 0; index < section.blocks.length; index++) {
          const id = section.blocks[index], block = byId.get(id), name = block?.name || `unknown:${id}`;
          blocks++; mapAdd(states, id); mapAdd(names, name);
          if (!block) unknown++;
          if (!['air', 'cave_air', 'void_air'].includes(name)) nonAir++;
          if (id && !p.assets.materials.has(id)) missingMaterials++;
          const material = p.assets.materials.get(id);
          if (material && material.name.replace(/^minecraft:/, '') !== name && mismatches.length < 128) mismatches.push({ id, name, material: material.name, pumpkin: actualServerName(id) });
          if (material?.unsupported) mapAdd(unsupported, name);
          const x = column.x * 16 + (index & 15), y = section.sectionY * 16 + (index >> 8), z = column.z * 16 + (index >> 4 & 15);
          if (!['air', 'cave_air', 'void_air'].includes(name)) {
            const key = index & 255; if (!tops.has(key) || y > tops.get(key).y) tops.set(key, { y, name });
            if (!examples.has(name) && y > 48) examples.set(name, { id, position: [x, y, z] });
          }
          if (index % 97 === 0) { coreChecks++; if (p.core.block_get(x, y, z) !== id) coreMismatches++; }
        }
        if (Number.isInteger(section.nonAirCount) && section.nonAirCount !== nonAir) nonAirCountMismatches++;
      }
      for (const top of tops.values()) mapAdd(topNames, top.name);
    }
    const describe = (id, count) => {
      const block = byId.get(id), material = p.assets.materials.get(id);
      const tiles = [...new Set(Object.values(material?.faces || {}).map(face => face.tile))].map(tile => ({ id: tile, name: p.assets.atlas.tiles[tile]?.name }));
      return { id, count, native: block?.name, pumpkin: actualServerName(id), material: material?.name, properties: material?.properties, flags: material?.flags, fullCube: material?.fullCube, unsupported: material?.unsupported, tiles };
    };
    const sorted = map => [...map].sort((a, b) => b[1] - a[1]);
    const eye = p.player.eye, forward = p.player.direction, right = [Math.cos(p.player.yaw), 0, Math.sin(p.player.yaw)], up = [-Math.sin(p.player.pitch) * Math.sin(p.player.yaw), Math.cos(p.player.pitch), Math.sin(p.player.pitch) * Math.cos(p.player.yaw)];
    const rays = [];
    for (const [screenX, screenY] of [[596, 215], [458, 202], [389, 175], [663, 172], [640, 210], [748, 226], [280, 220], [400, 225]]) {
      const vertical = Math.tan(75 * Math.PI / 360), x = (screenX / 400 - 1) * vertical * 800 / 450, y = (1 - screenY / 225) * vertical;
      let direction = forward.map((v, i) => v + right[i] * x + up[i] * y), length = Math.hypot(...direction); direction = direction.map(v => v / length);
      for (let distance = .1; distance < 96; distance += .025) {
        const position = eye.map((v, i) => Math.floor(v + direction[i] * distance)), id = p.core.block_get(...position), material = p.assets.materials.get(id);
        if (!id || !material || material.flags & 128) continue;
        rays.push({ screen: [screenX, screenY], position, distance, ...describe(id, 1) }); break;
      }
    }
    return { registry: p.registry.version.minecraftVersion, materialCount: p.assets.materials.size, packStatus: document.querySelector('#pack-status').textContent, packDiagnostics: p.assets.diagnostics, columns: p.session.columns.size, meshes: p.world.nearReady.size, position: [...p.player.position], camera: { eye: [...eye], direction: [...forward], yaw: p.player.yaw, pitch: p.player.pitch }, blocks, unknown, missingMaterials, materialNameMismatches: mismatches, coreChecks, coreMismatches, nonAirCountMismatches, frequencies: sorted(names), surfaceFrequencies: sorted(topNames), states: sorted(states).slice(0, 80).map(([id, count]) => describe(id, count)), unsupportedPresent: sorted(unsupported), examples: [...examples].map(([name, value]) => ({ name, ...value })), rays, entities: [...p.session.entities.values()].map(entity => ({ id: entity.id, name: p.registry.entities.find(definition => definition.id === entity.entityType)?.name, position: [entity.x, entity.y, entity.z] })), entityStats: { ...p.entities.stats }, renderer: p.renderer.stats() };
  }, ranges);
  await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/visual-diagnostic-all.png' });
  report.isolation = await page.evaluate(async () => {
    const p = window.pomme, before = p.renderer.stats().frameCount;
    p.entities.update = () => p.entities.stats; p.firstPerson.update = () => p.firstPerson.stats;
    p.renderer.removeMesh('__minecraft_entities'); p.renderer.clearFirstPersonMesh();
    return { before, oldEntityTriangles: p.renderer.stats().entityTriangles };
  });
  await page.waitForFunction(frame => window.pomme.renderer.stats().frameCount > frame + 2, report.isolation.before, { timeout: 60000 });
  await page.screenshot({ path: 'test-results/visual-diagnostic-terrain.png' });
  report.isolation.after = await page.evaluate(() => ({ renderer: window.pomme.renderer.stats(), pageError: document.querySelector('#error').textContent }));
  assert.equal(report.live.registry, version); assert.equal(report.live.materialCount, ranges.at(-1).max + 1); assert.equal(report.live.unknown, 0); assert.equal(report.live.missingMaterials, 0); assert.deepEqual(report.live.materialNameMismatches, []); assert.equal(report.live.coreMismatches, 0); assert.deepEqual(report.errors, []);
  console.log(JSON.stringify({ materialCount: report.live.materialCount, columns: report.live.columns, nativeNames: report.live.frequencies.slice(0, 18), topBlocks: report.live.surfaceFrequencies, unsupportedPresent: report.live.unsupportedPresent, rays: report.live.rays, entities: report.live.entities, nativeCoreChecks: report.live.coreChecks, coreMismatches: report.live.coreMismatches }, null, 2));
} catch (error) { report.failure = error.message; throw error; }
finally {
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/visual-diagnostic.json', JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  if (page) { try { await page.evaluate(() => window.pomme.session?.disconnect()); } catch {} }
  if (browser) await browser.close(); if (gateway) await gateway.close(); if (manager) await manager.close(); if (directory) await rm(directory, { recursive: true, force: true });
}
