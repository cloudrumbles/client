import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', encode = new TextEncoder();
const jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : Buffer.from(zipSync({
  'version.json': encode.encode(JSON.stringify({ id: version })),
  'data/minecraft/recipe/oak_planks.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: version === '1.20.4' ? [{ item: 'minecraft:oak_log' }] : ['minecraft:oak_log'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:oak_planks', count: 4 } })),
}));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] }), errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1150, height: 1200 } }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__native-menu-jar', route => route.fulfill({ body: jar, contentType: 'application/zip' }));
  await page.route('**/__native-menu-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas id="world" width="1150" height="1200"></canvas><nav id="hotbar">Imported builder</nav></body></html>' }));
  await page.goto(new URL('/__native-menu-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  await page.evaluate(async version => {
    const [{ LocalInventory }, { Player }] = await Promise.all([import('/src/local-inventory.js'), import('/src/player.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json(), core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    core.world_reset(-64, 384, 0, 0, 4, 4); const player = new Player(core), jar = new Blob([await (await fetch('/__native-menu-jar')).arrayBuffer()]);
    const options = { registry, jar, worldKey: `native-menu-${crypto.randomUUID()}`, player, world: { core } };
    const p = window.menuProof = { options, LocalInventory, registry, local: await LocalInventory.open(options), id: name => registry.items.find(item => item.name === name).id };
    p.stack = (name, count = 1, fields = {}) => ({ present: true, itemId: p.id(name), itemCount: count, ...fields });
    p.seed = async ({ player = {}, grid = {}, cursor = { present: false } } = {}) => {
      await p.local.pending;
      for (let index = 0; index < 41; index++) await p.local.authority.setSlot('player', index, player[index] ?? { present: false });
      for (let index = 0; index < p.local.authority.state.width ** 2; index++) await p.local.authority.setSlot('grid', index, grid[index] ?? { present: false });
      await p.local.authority.setSlot('cursor', 0, cursor); p.local.accept();
    };
    document.addEventListener('keydown', event => p.local?.gameplay.key(event)); document.addEventListener('keyup', event => p.local?.gameplay.key(event));
    await p.seed({ player: { 9: p.stack('oak_planks', 10) } });
  }, version);
  const slot = index => page.locator(`.local-inventory-ui [data-ui="slots"] [data-slot="${index}"]`);
  const ready = () => page.waitForFunction(() => performance.now() > (window.menuProof.local.gameplay.ignoreInventoryClickUntil || 0));
  const settled = () => page.evaluate(async () => { await window.menuProof.local.pending; });
  await page.keyboard.press('e'); await slot(9).click({ modifiers: ['Shift'] }); await settled();
  assert.equal(await page.evaluate(() => window.menuProof.local.authority.state.player[0].itemCount), 10);
  await page.evaluate(async () => { const p = window.menuProof; await p.seed({ player: { 9: p.stack('oak_planks', 3), 1: p.stack('stone', 8) } }); });
  await slot(9).hover(); await page.keyboard.press('Digit2'); await settled();
  assert.deepEqual(await page.evaluate(() => { const p = window.menuProof, s = p.local.authority.state; return [s.player[9].itemId === p.id('stone'), s.player[9].itemCount, s.player[1].itemId === p.id('oak_planks'), s.player[1].itemCount]; }), [true, 8, true, 3]);
  await page.evaluate(async () => { const p = window.menuProof; await p.seed({ player: { 9: p.stack('oak_planks', 3), 40: p.stack('stone', 8) } }); });
  await slot(9).hover(); await page.keyboard.press('f'); await settled();
  assert.deepEqual(await page.evaluate(() => { const p = window.menuProof, s = p.local.authority.state; return [s.player[9].itemId === p.id('stone'), s.player[40].itemId === p.id('oak_planks')]; }), [true, true]);
  await page.evaluate(async () => { const p = window.menuProof; await p.seed({ cursor: p.stack('oak_planks', 10) }); });
  await ready(); const boxes = await Promise.all([9, 10, 11].map(index => slot(index).boundingBox()));
  await page.mouse.move(boxes[0].x + boxes[0].width / 2, boxes[0].y + boxes[0].height / 2); await page.mouse.down();
  for (const box of boxes.slice(1)) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.up(); await settled();
  assert.deepEqual(await page.evaluate(() => { const s = window.menuProof.local.authority.state; return [s.player[9].itemCount, s.player[10].itemCount, s.player[11].itemCount, s.cursor.itemCount]; }), [3, 3, 3, 1]);
  await page.evaluate(async () => { const p = window.menuProof; p.local.gameplay.inventoryLastClick = null; await p.seed({ player: { 9: p.stack('oak_planks', 20), 10: p.stack('oak_planks', 40), 11: p.stack('oak_planks', 64) } }); });
  await ready(); await slot(9).click(); await settled(); await slot(9).click(); await settled();
  assert.deepEqual(await page.evaluate(() => { const s = window.menuProof.local.authority.state; return [s.player[9].present, s.player[10].present, s.player[11].itemCount, s.cursor.itemCount]; }), [false, false, 60, 64]);
  await page.evaluate(async () => { const p = window.menuProof; await p.seed({ grid: { 0: p.stack('oak_log', 1) } }); });
  await ready(); await slot(0).click({ button: 'right' }); await settled();
  assert.deepEqual(await page.evaluate(() => { const s = window.menuProof.local.authority.state; return [s.grid[0].present, s.result.present, s.cursor.itemCount]; }), [false, false, 4]);
  await page.evaluate(async () => { const p = window.menuProof; await p.seed({ player: { 0: p.stack('oak_planks', 3), 40: p.stack('stone', 8) } }); });
  await page.keyboard.press('e'); await settled(); await page.keyboard.press('f'); await settled();
  assert.deepEqual(await page.evaluate(() => { const p = window.menuProof, s = p.local.authority.state; return [s.player[0].itemId === p.id('stone'), s.player[40].itemId === p.id('oak_planks')]; }), [true, true]);
  const report = await page.evaluate(async () => {
    const p = window.menuProof, before = await p.local.authority.snapshot();
    const dropsRejected = p.local.session.dropItem() === false && p.local.session.clickWindow(36, { mode: 4 }) === false;
    await p.local.pending; const after = await p.local.authority.snapshot(); if (before.words.join() !== after.words.join()) throw new Error('Disabled world drop input must retain exact native inventory.');
    await p.local.close(); p.local = await p.LocalInventory.open(p.options);
    if (!p.local.authority.initial.restored || p.local.authority.state.player[0].itemId !== p.id('stone') || p.local.authority.state.player[40].itemId !== p.id('oak_planks')) throw new Error('Accepted hand swaps must save/reopen natively.');
    return { validation: 'passed', backend: 'actual DOM + Browser Worker + Rust/WASM + IndexedDB', shiftMove: true, numberSwap: true, hoveredOffhandSwap: true, handSwap: true, leftDrag: true, doubleCollectPartialFirst: true, rightResultFullOutput: true, acceptedMenuStateSavedAndRestored: true, disabledWorldDropsPreserveState: dropsRejected, fullSurvivalImplemented: false, gpuUsed: false };
  });
  await page.evaluate(async () => {
    const p = window.menuProof, table = p.registry.blocks.find(block => block.name === 'crafting_table');
    p.options.world.core.block_set(8, 70, 8, table.defaultState); await p.local.useBlock(8, 70, 8);
    const player = Object.fromEntries(Array.from({ length: 36 }, (_, index) => [index, p.stack('stone', 64)]));
    await p.seed({ player, grid: { 8: p.stack('oak_planks', 2) }, cursor: p.stack('oak_planks', 3) });
    p.fullMenuSnapshot = await p.local.authority.snapshot();
  });
  assert.equal(await page.locator('.local-inventory-ui [data-ui="slots"]').getAttribute('data-menu'), 'crafting');
  await page.locator('.local-inventory-ui [data-ui="inventory-close"]').click(); await settled();
  await page.waitForFunction(() => window.menuProof.local.gameplay.menu === 'inventory');
  await page.evaluate(async () => {
    const p = window.menuProof, before = p.fullMenuSnapshot, after = await p.local.authority.snapshot(), state = p.local.authority.state;
    if (p.local.session.windowId !== 1 || state.width !== 3 || state.cursor.itemCount !== 3 || state.grid[8].itemCount !== 2 || state.drops.length || before.words.join() !== after.words.join()) throw new Error('Rejected table closure must reopen the same UI and retain exact cursor/grid state without hidden drops.');
    await p.local.close(); p.local = await p.LocalInventory.open(p.options);
    const reopened = p.local.authority.state;
    if (p.local.session.windowId !== 1 || reopened.width !== 3 || reopened.cursor.itemCount !== 3 || reopened.grid[8].itemCount !== 2 || reopened.drops.length) throw new Error('Shutdown and reopen must retain the intact full table when native returns require a drop.');
    await p.local.close();
  });
  report.fullInventoryTableCloseReopensWithExactCursorAndGrid = true;
  report.overflowingMenuShutdownAndReopenPreserveState = true;
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-menu-ui.json', JSON.stringify({ ...report, version, recipeSource: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated mechanical recipe fixture' }, null, 2)); console.log(JSON.stringify({ ...report, version }, null, 2));
} finally { await browser.close(); }
