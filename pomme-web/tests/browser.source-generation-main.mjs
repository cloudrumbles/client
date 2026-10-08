import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [], original = process.env.POMME_MINECRAFT_JAR;
const faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all', cullface: face }]));
const model = { textures: { all: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }] };
const fixtureFiles = { 'version.json': { id: '1.21.11' }, 'data/minecraft/recipe/oak_planks.json': { type: 'minecraft:crafting_shapeless', ingredients: ['minecraft:oak_log'], result: { id: 'minecraft:oak_planks', count: 4 } } };
for (const name of ['stone', 'oak_planks', 'gold_block']) {
  fixtureFiles[`assets/minecraft/models/block/${name}.json`] = model;
  fixtureFiles[`assets/minecraft/blockstates/${name}.json`] = { variants: { '': { model: `minecraft:block/${name}` } } };
  fixtureFiles[`assets/minecraft/models/item/${name}.json`] = { parent: `minecraft:block/${name}` };
  fixtureFiles[`assets/minecraft/items/${name}.json`] = { model: { type: 'minecraft:model', model: `minecraft:item/${name}` } };
}
const fixture = zipSync(Object.fromEntries(Object.entries(fixtureFiles).map(([path, value]) => [path, new TextEncoder().encode(JSON.stringify(value))])));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } }); page.setDefaultTimeout(180000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text()); });
  const url = process.env.POMME_URL ?? 'http://127.0.0.1:5173';
  const setup = async () => {
    await page.goto(url);
    await page.waitForFunction(() => window.pomme?.ready || document.documentElement.dataset.engine === 'error');
    assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready');
    await page.evaluate(() => {
      document.querySelector('#adaptive').checked = false; document.querySelector('#quality').value = 'low';
      const scale = document.querySelector('#resolution'); scale.value = '.5'; scale.dispatchEvent(new Event('input'));
      const input = document.createElement('input'); input.type = 'file'; input.id = 'generation-assets'; input.hidden = true; document.body.append(input);
    });
  };
  await setup();
  assert.equal(await page.evaluate(() => window.pomme.mode), 'demo', 'Browser native generation must preserve the original demo default.');
  await page.locator('#generation-assets').setInputFiles(original ?? { name: 'native-generation-fixture.zip', mimeType: 'application/zip', buffer: Buffer.from(fixture) });
  await page.evaluate(() => window.pomme.loadPack(document.querySelector('#generation-assets').files[0], { version: '1.21.11' }));
  await page.evaluate(() => {
    document.querySelector('#browser-world-name').value = 'Browser source terrain proof';
    document.querySelector('#browser-world-seed').value = '-9223372036854775808';
    document.querySelector('#browser-world-dimension').value = 'minecraft:overworld';
    document.querySelector('#browser-world-form').requestSubmit();
  });
  await page.waitForFunction(() => window.pomme.generated && window.pomme.ready && window.pomme.localInventory?.worldItems);
  const initial = await page.evaluate(async () => {
    const p = window.pomme, check = (value, message) => { if (!value) throw new Error(message); };
    const spawn = p.player.position.slice();
    check(p.generatedSettings.seed === '-9223372036854775808' && p.registry.version.minecraftVersion === '1.21.11', 'Exact seed and source registry must reach the production native worker.');
    check(p.core.world_column_loaded(Math.floor(spawn[0] / 16), Math.floor(spawn[2] / 16)), 'Native generation must load the spawn column before player ticks.');
    check(!p.core.collides_aabb(spawn[0] - .3, spawn[1], spawn[2] - .3, spawn[0] + .3, spawn[1] + 1.8, spawn[2] + .3), 'Native generated spawn must leave the player outside terrain collision.');
    const item = p.registry.items.find(item => item.name === 'stone'), state = p.registry.blocks.find(block => block.name === 'gold_block').defaultState;
    await p.localInventory.run(() => p.localInventory.authority.setSlot('player', 0, { present: true, itemId: item.id, itemCount: 19 }));
    check(p.localInventory.session.dropItem(false), 'Production local inventory must admit the native Q drop.');
    await p.localInventory.pending;
    check(p.localInventory.authority.state.player[0].itemCount === 18 && p.localInventory.worldItems.state.items.length === 1, 'Drop must atomically transfer one item from native inventory into the world.');
    const position = [Math.floor(spawn[0]) + 2, Math.floor(spawn[1]) + 3, Math.floor(spawn[2])];
    await p.edit(...position, state); await p.saveAuthority(); await p.saveInventory();
    document.querySelector('#cycle').checked = false; await p.authority.authority.setTime(7000000000000000004n, false);
    await p.saveGeneratedLocation();
    const actor = p.localInventory.worldItems.state.items[0];
    const { restoreSourceWorld } = await import('/generation/source-world-state.js');
    const stored = await restoreSourceWorld(p.generatedSettings.worldKey);
    check(stored.dayTime === '7000000000000000004' && stored.seed === p.generatedSettings.seed, 'Durable generation metadata must preserve exact long seed and full day time.');
    return { worldKey: p.generatedSettings.worldKey, seed: p.generatedSettings.seed, dimension: p.generatedSettings.dimension, spawn, minY: p.core.world_min_y(), height: p.core.world_height(),
      position, state, itemId: item.id, itemCount: 18, playerUuid: p.localInventory.playerUuid, actorUuid: actor.uuid, storedDayTime: stored.dayTime,
      nativeInventory: true, nativeItemDrop: true, nativeAuthority: true, safeLoadedSpawn: true };
  });
  await page.waitForFunction(() => window.pomme.renderer.stats().totalChunks > 0);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: `test-results/source-generation-main-${original ? 'original' : 'fixture'}.png` });
  await setup();
  await page.evaluate(() => document.querySelector('#resume-generated').click());
  await page.waitForFunction(() => window.pomme.generated && window.pomme.ready && window.pomme.localInventory?.worldItems);
  const reopened = await page.evaluate(initial => {
    const p = window.pomme, actor = p.localInventory.worldItems.state.items.find(actor => actor.uuid === initial.actorUuid);
    if (p.generatedSettings.worldKey !== initial.worldKey || p.generatedSettings.seed !== initial.seed || p.generatedSettings.dimension !== initial.dimension || p.generatedSettings.dayTime !== initial.storedDayTime) throw new Error(`Native terrain context and full day time must survive a complete page reload: ${JSON.stringify({ initial, reopened: p.generatedSettings })}`);
    if (p.core.block_get(...initial.position) !== initial.state) throw new Error('Saved native authority edits must win over generated base terrain.');
    if (p.localInventory.authority.state.player[0].itemCount !== initial.itemCount || p.localInventory.playerUuid !== initial.playerUuid || !actor) throw new Error('Native inventory, item identity and local player UUID must survive reopen.');
    return { worldKey: p.generatedSettings.worldKey, seed: p.generatedSettings.seed, dayTime: p.generatedSettings.dayTime, storedEdit: true, nativeInventory: true, groundItem: true, playerUuid: p.localInventory.playerUuid };
  }, initial);
  const dimensions = [];
  for (const dimension of ['minecraft:the_nether', 'minecraft:the_end']) {
    await page.evaluate(dimension => window.pomme.createGeneratedWorld({ name: dimension, seed: '42', dimension }), dimension);
    dimensions.push(await page.evaluate(() => {
      const p = window.pomme, spawn = p.player.position;
      if (!p.ready || !p.generated || p.core.world_height() !== 256 || p.core.world_min_y() !== 0 || !p.core.world_column_loaded(Math.floor(spawn[0] / 16), Math.floor(spawn[2] / 16))) throw new Error('Native dimension bounds and loaded spawn must match source data.');
      if (p.core.collides_aabb(spawn[0] - .3, spawn[1], spawn[2] - .3, spawn[0] + .3, spawn[1] + 1.8, spawn[2] + .3)) throw new Error('Dimension spawn intersects native terrain.');
      return { dimension: p.generatedSettings.dimension, minY: p.core.world_min_y(), height: p.core.world_height(), spawn: spawn.slice(), hasSkylight: p.world.hasSkylight, nativeInventory: Boolean(p.localInventory), noServer: p.session === null };
    }));
  }
  assert.deepEqual(errors, []);
  const evidence = { validation: 'passed', minecraftVersion: '1.21.11', sourceCommit: '70b31323967bb99fd4feefab8e96124be369cd6f', stages: ['biomes', 'noise', 'surface'],
    assets: original ? 'private matching native client JAR' : 'generated crafting fixture with procedural native materials', defaultDemoPreserved: true, actualProductionUI: true, actualWebGPU: true,
    nativeProcesses: 0, initial, reopened, dimensions, errors, softwareGPU: software, targetHardwareVerified: false };
  await writeFile(`test-results/source-generation-main-${original ? 'original' : 'fixture'}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
