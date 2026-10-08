import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
const encode = new TextEncoder(), version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
const fixture = {
  'version.json': encode.encode(JSON.stringify({ id: version })),
  'data/minecraft/recipe/oak_planks.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: version === '1.20.4' ? [{ item: 'minecraft:oak_log' }] : ['minecraft:oak_log'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:oak_planks', count: 4 } })),
  'data/minecraft/recipe/crafting_table.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shaped', key: { P: version === '1.20.4' ? { item: 'minecraft:oak_planks' } : 'minecraft:oak_planks' }, pattern: ['PP', 'PP'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:crafting_table', count: 1 } })),
  'data/minecraft/recipe/stick.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shaped', key: { P: version === '1.20.4' ? { item: 'minecraft:oak_planks' } : 'minecraft:oak_planks' }, pattern: ['P', 'P'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:stick', count: 4 } })),
};
const jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : Buffer.from(zipSync(fixture)), errors = [];
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__local-inventory-native.jar', route => route.fulfill({ body: jar, contentType: 'application/zip' }));
  await page.route('**/__local-inventory-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Local inventory proof</title></head><body style="margin:0;background:#253c39"><canvas id="world" width="1100" height="800"></canvas><nav id="hotbar">Imported building hotbar</nav></body></html>' }));
  await page.goto(new URL('/__local-inventory-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  await page.evaluate(async version => {
    const [{ LocalInventory }, { Player }] = await Promise.all([import('/src/local-inventory.js'), import('/src/player.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json(), core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    if (!core.world_reset(-64, 384, 0, 0, 4, 4)) throw new Error('Native renderer world bounds rejected.'); const player = new Player(core), table = registry.blocks.find(block => block.name === 'crafting_table'); if (!core.block_set(8, 70, 8, table.defaultState)) throw new Error('Native crafting table state rejected.');
    const jar = new Blob([await (await fetch('/__local-inventory-native.jar')).arrayBuffer()]), worldKey = `local-ui-${crypto.randomUUID()}`, selected = [];
    const proof = window.localProof = { registry, core, player, jar, worldKey, selected, LocalInventory, options: { registry, jar, worldKey, player, world: { core }, onSelectedBlock: value => selected.push(value) } };
    proof.inventory = await LocalInventory.open(proof.options);
    if (!proof.inventory) throw new Error('Local inventory must open from matching native recipe data.');
    document.addEventListener('keydown', event => proof.inventory?.gameplay.key(event)); document.addEventListener('keyup', event => proof.inventory?.gameplay.key(event));
  }, version);
  await page.keyboard.press('e'); await page.locator('.local-inventory-ui [data-ui="inventory"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.local-inventory-ui [data-ui="slots"]').getAttribute('data-menu'), 'player');
  await page.locator('.local-inventory-ui [data-creative-item="oak_planks"]').click();
  await page.waitForFunction(() => window.localProof.inventory.authority.state.player[0].itemId === window.localProof.registry.items.find(item => item.name === 'oak_planks').id);
  const slot = index => page.locator(`.local-inventory-ui [data-ui="slots"] [data-slot="${index}"]`);
  const ready = () => page.waitForFunction(() => performance.now() > (window.localProof.inventory.gameplay.ignoreInventoryClickUntil || 0));
  await slot(36).click(); await page.waitForFunction(() => window.localProof.inventory.authority.state.cursor.itemCount === 64);
  for (let index = 1; index <= 4; index++) { await ready(); await slot(index).click({ button: 'right' }); await page.waitForFunction(index => window.localProof.inventory.authority.state.grid[index - 1].itemCount === 1, index); }
  await ready(); await slot(36).click(); await page.waitForFunction(() => !window.localProof.inventory.authority.state.cursor.present);
  await ready(); await slot(0).click(); await page.waitForFunction(() => window.localProof.inventory.authority.state.cursor.itemId === window.localProof.registry.items.find(item => item.name === 'crafting_table').id);
  const first = await page.evaluate(() => ({ gridEmpty: window.localProof.inventory.authority.state.grid.every(slot => !slot.present), cursorCount: window.localProof.inventory.authority.state.cursor.itemCount }));
  assert.equal(first.gridEmpty, true); assert.equal(first.cursorCount, 1);
  await page.keyboard.press('e'); await page.waitForFunction(() => !window.localProof.inventory.authority.state.cursor.present);
  await page.evaluate(async () => { await window.localProof.inventory.useBlock(8, 70, 8); });
  assert.equal(await page.locator('.local-inventory-ui [data-ui="slots"]').getAttribute('data-menu'), 'crafting');
  await ready(); await slot(37).click(); await page.waitForFunction(() => window.localProof.inventory.authority.state.cursor.itemCount === 60);
  for (const index of [1, 2, 4, 5]) { await ready(); await slot(index).click({ button: 'right' }); await page.waitForFunction(index => window.localProof.inventory.authority.state.grid[index - 1].itemCount === 1, index); }
  await ready(); await slot(37).click(); await page.waitForFunction(() => !window.localProof.inventory.authority.state.cursor.present);
  await ready(); await slot(0).click({ modifiers: ['Shift'] }); await page.waitForFunction(() => window.localProof.inventory.authority.state.grid.every(slot => !slot.present));
  await page.screenshot({ path: 'test-results/local-inventory-ui.png' });
  const result = await page.evaluate(async () => {
    const p = window.localProof, tableId = p.registry.items.find(item => item.name === 'crafting_table').id;
    const check = (value, message) => { if (!value) throw new Error(message); };
    const tableTotal = p.inventory.authority.state.player.reduce((count, slot) => count + (slot.itemId === tableId ? slot.itemCount : 0), 0);
    check(tableTotal === 2, 'Both actual UI crafting transactions must preserve exactly two native crafting tables.');
    p.inventory.gameplay.closePanel(false); await p.inventory.pending;
    const tableSlot = p.inventory.authority.state.player.findIndex(slot => slot.itemId === tableId); p.tableSlot = tableSlot;
    await p.inventory.session.selectHotbar(tableSlot); await p.inventory.pending;
    check(p.inventory.heldBlock() === p.registry.blocks.find(block => block.name === 'crafting_table').defaultState, 'Native selected crafted item must feed placement.');
    const old = p.inventory, closed = old.close(); check(old.closed && !old.gameplay.root.isConnected, 'Close must synchronously gate input and remove old UI.'); await closed;
    p.inventory = await p.LocalInventory.open(p.options);
    check(p.inventory.authority.initial.restored && p.inventory.heldBlock() === p.registry.blocks.find(block => block.name === 'crafting_table').defaultState, 'Saved selected hand must survive reopen.');
    const stick = p.registry.items.find(item => item.name === 'stick'); p.inventory.session.setCreativeSlot(stick.id, 64, p.tableSlot); await p.inventory.pending;
    check(p.inventory.heldBlock() === null && p.selected.at(-1) === null, 'A non-block native item must explicitly disable block placement.');
    await p.inventory.save(); await p.inventory.close();
    const { InventoryAuthority } = await import('/authority/inventory-client.js'), original = InventoryAuthority.open;
    let active = true;
    InventoryAuthority.open = async options => { const authority = await original.call(InventoryAuthority, options); await authority.setSlot('player', p.tableSlot, null); active = false; return authority; };
    let stale;
    try { stale = await p.LocalInventory.open({ ...p.options, isCurrent: () => active }); } finally { InventoryAuthority.open = original; }
    check(stale === null && !document.querySelector('.local-inventory-ui'), 'A stale bootstrap must create no visible UI.');
    p.inventory = await p.LocalInventory.open(p.options);
    check(p.inventory.authority.state.player[p.tableSlot].itemId === stick.id, 'A canceled candidate must not save its private changes over current inventory.');
    await p.inventory.close();
    const fallback = await p.LocalInventory.open({ ...p.options, jar: new Blob(['texture-only pack']) });
    check(fallback === null && !document.getElementById('hotbar').hidden, 'Missing native recipes must leave imported building available.');
    return { validation: 'passed', nativeVersion: p.registry.version.minecraftVersion, ui: 'existing ServerGameplay/ContainerUI', backend: 'Browser Worker + Rust/WASM + IndexedDB', playerGrid: '2x2', tableGrid: '3x3', nativeCraftedTables: tableTotal,
      actualDomClicks: true, ingredientConsumption: true, shiftResultQuickMove: true, selectedBlockPersisted: true, nonBlockSelectionClearsPlacement: true, closeReturnsCursorAndGrid: true, saveReopen: true, closedUiRemovedImmediately: true,
      staleCandidateCannotOverwrite: true, missingRecipesPreserveBuilding: true, survivalSimulated: false };
  });
  assert.deepEqual(errors, []);
  const report = { ...result, source: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR recipe data' : 'generated mechanical recipe fixture', originalJar: !!process.env.POMME_MINECRAFT_JAR };
  await writeFile('test-results/local-inventory-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
