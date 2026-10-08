import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
import { sourceInventoryFixture } from './fixtures/source-inventory-nbt.js';
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', encode = new TextEncoder();
const jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : Buffer.from(zipSync({
  'version.json': encode.encode(JSON.stringify({ id: version })),
  'data/minecraft/recipe/oak_planks.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: version === '1.20.4' ? [{ item: 'minecraft:oak_log' }] : ['minecraft:oak_log'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:oak_planks', count: 4 } })),
}));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] }), errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__source-inventory-jar', route => route.fulfill({ body: jar, contentType: 'application/zip' }));
  for (const [name, options] of [['initial', {}], ['changed', { count: 4 }], ['deferred', { deferred: true }]]) await page.route(`**/__source-inventory-${name}.nbt`, route => route.fulfill({ body: Buffer.from(sourceInventoryFixture(version, options)), contentType: 'application/octet-stream' }));
  await page.route('**/__source-inventory-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas id="world" width="1000" height="700"></canvas><nav id="hotbar">Imported builder</nav></body></html>' }));
  await page.goto(new URL('/__source-inventory-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async version => {
    const [{ LocalInventory }, sourceModule, { Player }, { InventoryAuthority }, { loadNativeCraftingData }] = await Promise.all([import('/src/local-inventory.js'), import('/src/source-level-inventory.js'), import('/src/player.js'), import('/authority/inventory-client.js'), import('/authority/native-crafting-data.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json(), core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    core.world_reset(-64, 384, 0, 0, 4, 4); const player = new Player(core), jar = new Blob([await (await fetch('/__source-inventory-jar')).arrayBuffer()]);
    const read = async name => sourceModule.readSourceLevelInventory(await (await fetch(`/__source-inventory-${name}.nbt`)).arrayBuffer(), { raw: true });
    const source = await read('initial'), changed = await read('changed'), worldKey = `source-ui-${crypto.randomUUID()}`, selected = [];
    const options = { registry, jar, worldKey, player, world: { core }, onSelectedBlock: state => selected.push(state), sourceInventory: source };
    const check = (value, message) => { if (!value) throw new Error(message); }, item = name => registry.items.find(item => item.name === name).id;
    await sourceModule.storeSourceLevelInventory(worldKey, source); options.sourceInventory = await sourceModule.restoreSourceLevelInventory(worldKey);
    let local = await LocalInventory.open(options); check(local && !local.authority.initial.restored, 'Source must bootstrap an unsaved native authority.');
    check(local.authority.state.selected === 2 && local.authority.state.player[2].itemCount === 10 && !local.authority.state.player[0].present, 'Source selection and explicit empty hotbar slots must replace starter semantics.');
    check(local.authority.state.player[39].itemId === item('diamond_helmet') && local.authority.state.player[40].itemId === item('shield'), 'Original version-specific source armor/offhand must be retained.');
    check(local.heldBlock() === registry.blocks.find(block => block.name === 'oak_planks').defaultState, 'Initial source hand must feed native building selection.');
    if (version === '1.20.4') check(local.authority.state.player[2].nbtData.value.seed.value === 7n && local.authority.state.player[2].nbtData.value.byte.type === 'byte' && local.authority.state.player[2].nbtData.value.integer.type === 'int', 'Legacy typed source identity must survive worker loading.');
    else check(local.authority.state.player[2].components[0].type === 'minecraft:max_stack_size' && local.authority.state.player[2].components[0].data === 16, 'Source maximum patch must convert through the native codec boundary.');
    local.gameplay.openPanel('inventory'); check(local.gameplay.ui.slots.dataset.menu === 'player', 'Source inventory must use actual player UI.');
    local.session.setCreativeSlot(item('stone'), 12, 2); await local.pending; await local.close();
    local = await LocalInventory.open({ ...options, sourceInventory: changed });
    check(local.authority.initial.restored && local.authority.state.player[2].itemId === item('stone') && local.authority.state.player[2].itemCount === 12, 'Confirmed saved inventory must outrank changed original source.'); await local.close();
    let active = true; const staleKey = `${worldKey}-stale`, original = InventoryAuthority.prototype.bootstrapPlayer;
    InventoryAuthority.prototype.bootstrapPlayer = async function(...args) { const state = await original.apply(this, args); active = false; return state; };
    let stale; try { stale = await LocalInventory.open({ ...options, worldKey: staleKey, isCurrent: () => active }); } finally { InventoryAuthority.prototype.bootstrapPlayer = original; }
    check(stale === null && !document.querySelector('.local-inventory-ui'), 'A stale source candidate must create no visible UI.');
    const data = await loadNativeCraftingData(jar, { registry }), clean = await InventoryAuthority.open({ registry, data, worldKey: staleKey });
    check(!clean.initial.restored && clean.state.player.every(stack => !stack.present), 'Stale source candidate must not save a private bootstrap snapshot.'); await clean.close({ save: false });
    let deferredPreserved = null;
    if (version !== '1.20.4') {
      const deferred = await read('deferred'), deferredKey = `${worldKey}-deferred`; await sourceModule.storeSourceLevelInventory(deferredKey, deferred);
      const unavailable = await LocalInventory.open({ ...options, worldKey: deferredKey, sourceInventory: deferred });
      check(unavailable === null && !document.getElementById('hotbar').hidden, 'Unported source components must leave the builder available.');
      const retained = await sourceModule.restoreSourceLevelInventory(deferredKey); check(retained.player.value.Inventory.value.entries[0].value.components.value['minecraft:custom_data'].value.seed.value === 7n, 'Deferred native component source must remain exact in the cache.');
      const clean = await InventoryAuthority.open({ registry, data, worldKey: deferredKey }); check(!clean.initial.restored, 'Deferred source must not create a starter inventory save.'); await clean.close({ save: false }); deferredPreserved = true;
    }
    let failure; try { await sourceModule.readSourceLevelInventory(new Uint8Array([10, 0, 0]), { raw: true }); } catch (error) { failure = error; }
    check(failure, 'Malformed source must fail its bounded parser.');
    const unavailableKey = `${worldKey}-unavailable`, marker = sourceModule.unavailableSourceLevelInventory(failure, { version, dataVersion: registry.version.dataVersion });
    await sourceModule.storeSourceLevelInventory(unavailableKey, marker);
    const unread = await LocalInventory.open({ ...options, worldKey: unavailableKey, sourceInventory: await sourceModule.restoreSourceLevelInventory(unavailableKey) });
    check(unread === null && !document.getElementById('hotbar').hidden, 'Unread source marker must leave building available without a replacement inventory.');
    const fresh = await InventoryAuthority.open({ registry, data, worldKey: unavailableKey }); check(!fresh.initial.restored, 'Unread source candidate must not save starter slots.'); await fresh.close({ save: false });
    const accepted = await LocalInventory.open({ ...options, sourceInventory: marker }); check(accepted.authority.initial.restored, 'An existing confirmed save outranks an unread source marker.'); await accepted.close();
    return { validation: 'passed', version, sourcePlayerNbt: 'generated mechanical source fixture checked against original native classes', originalSourceSaveModified: false,
      backend: 'actual Browser Worker + Rust/WASM + IndexedDB', sourceSelectionAndEmptySlots: true, armorOffhandRetained: true, selectedSourceHand: true, nativeSourceComponents: true,
      savedStateOutranksOriginalSource: true, staleSourceCandidateCannotSave: true, deferredSourcePreserved: deferredPreserved, malformedSourceRetainsBuilderWithoutStarterSave: true, savedStateOutranksUnreadSourceMarker: true, fullSurvivalImplemented: false, gpuUsed: false };
  }, version);
  assert.deepEqual(errors, []); const report = { ...result, recipeSource: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated mechanical recipe fixture' };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/source-inventory-ui.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
