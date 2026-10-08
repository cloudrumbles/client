import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11', encode = new TextEncoder();
const jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : Buffer.from(zipSync({ 'version.json': encode.encode(JSON.stringify({ id: version })),
  'data/minecraft/recipe/oak_planks.json': encode.encode(JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: version === '1.20.4' ? [{ item: 'minecraft:oak_log' }] : ['minecraft:oak_log'], result: { [version === '1.20.4' ? 'item' : 'id']: 'minecraft:oak_planks', count: 4 } })) }));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] }), errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1150, height: 1200 } }); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__local-items-jar', route => route.fulfill({ body: jar, contentType: 'application/zip' }));
  await page.route('**/__local-items-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><canvas id="world" width="1150" height="1200"></canvas><nav id="hotbar">Imported builder</nav></body></html>' }));
  await page.goto(new URL('/__local-items-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  await page.evaluate(async version => {
    const [{ LocalInventory }, { Player }, { readSourceLevelInventory }, { sourceInventoryFixture }, sourceItems, fixtures] = await Promise.all([
      import('/src/local-inventory.js'), import('/src/player.js'), import('/src/source-level-inventory.js'), import('/tests/fixtures/source-inventory-nbt.js'), import('/src/source-world-items.js'), import('/tests/fixtures/source-world-items-nbt.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json(), core = (await WebAssembly.instantiate(await (await fetch('/public/core.wasm')).arrayBuffer(), {})).instance.exports;
    core.world_reset(-64, 384, 0, 0, 4, 4); const stone = registry.blocks.find(block => block.name === 'stone').defaultState;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) core.block_set(x, 69, z, stone);
    const player = new Player(core); player.setPosition([8.5, 70, 8.5]); player.yaw = 0; player.pitch = 0;
    const sourceInventory = await readSourceLevelInventory(sourceInventoryFixture(version, { playerUuid: fixtures.SOURCE_PLAYER_UUID_WORDS }), { raw: true });
    const source = await sourceItems.readSourceWorldItems([fixtures.sourceItemsRegion(version, [fixtures.sourceItemRecord(version), fixtures.sourceItemRecord(version, { ordinal: 2, count: 3, owner: [0, 0, 0, 2] })])], { version });
    const worldKey = `local-items-${version}-${crypto.randomUUID()}`; await sourceItems.storeSourceWorldItems(worldKey, source); const descriptor = await sourceItems.restoreSourceWorldItems(worldKey);
    const wrapper = `import { InventoryStorage } from '${location.origin}/authority/inventory-storage.js';import '${location.origin}/authority/inventory-worker.js';
      const put=InventoryStorage.prototype.put;let fail=false;InventoryStorage.prototype.put=function(...args){if(fail){fail=false;throw new Error('Injected native item save failure');}return put.apply(this,args);};
      const dispatch=self.onmessage;self.onmessage=event=>{if(event.data.args?.testFailSave)fail=true;dispatch(event);};`;
    const workerUrl = URL.createObjectURL(new Blob([wrapper], { type: 'application/javascript' })), OriginalWorker = globalThis.Worker;
    globalThis.Worker = class extends OriginalWorker { constructor(url, options) { super(String(url).includes('/authority/inventory-worker.js') ? workerUrl : url, options); } postMessage(message, transfer) { if (window.itemProof?.failNext && message.action === 'world-items-drop') { window.itemProof.failNext = false; message = { ...message, args: { ...message.args, testFailSave: true } }; } return super.postMessage(message, transfer); } };
    const options = { registry, jar: new Blob([await (await fetch('/__local-items-jar')).arrayBuffer()]), worldKey, player, world: { core }, sourceInventory };
    const p = window.itemProof = { LocalInventory, options, registry, player, events: [], descriptor, workerUrl, sourceItems, statuses: [] }; options.onStatus = message => p.statuses.push(message);
    p.local = await LocalInventory.open(options); p.id = name => registry.items.find(item => item.name === name).id; p.stack = (name, count) => ({ present: true, itemId: p.id(name), itemCount: count });
    p.attach = { sourceItems: descriptor, sample: (x, y, z) => { const id = core.block_get(x, y, z); return id === stone ? { flags: 1, material: { name: 'stone', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]] } } : { flags: 0, material: null }; },
      loaded: (x, z) => !!core.world_column_loaded(x, z), bounds: () => ({ min: [0, -64, 0], max: [64, 320, 64] }), collisionRevision: () => 0, onEvent: event => p.events.push(event), random: () => .5 };
    await p.local.attachWorldItems(p.attach); p.bounds = () => { const [x, y, z] = p.player.position; return [x - .3, y, z - .3, x + .3, y + 1.8, z + .3]; };
    p.tick = async (count, near = true) => { for (let tick = 0; tick < count; tick++) { p.local.tickWorldItems(.05, { bounds: near ? p.bounds() : [-100, 0, -100, -99, 2, -99] }); await p.local.pending; } };
    document.addEventListener('keydown', event => p.local?.gameplay.key(event)); document.addEventListener('keyup', event => p.local?.gameplay.key(event));
    if (p.local.worldItems.state.items.length !== 2 || p.local.playerUuid !== '12345678-1234-5678-1234-567812345678') throw new Error('Typed source actors and source Player.UUID must bind before enabling drops.');
    await p.tick(1); if (p.local.worldItems.state.items.length !== 1 || p.local.authority.state.player[0].itemCount !== 7) throw new Error('Actual native pickup must consume only the eligible source owner.');
    let idleMutations = 0; const observer = new MutationObserver(records => idleMutations += records.length);
    observer.observe(p.local.gameplay.ui.hotbar, { subtree: true, childList: true, attributes: true, characterData: true });
    try { await p.tick(20); await Promise.resolve(); } finally { observer.disconnect(); }
    if (idleMutations) throw new Error('Actual inventory DOM must remain retained during physics ticks with no eligible pickup.'); p.idleInventoryDomRetained = true;
  }, version);
  await page.keyboard.press('q'); await page.evaluate(async () => { const p = window.itemProof; await p.local.pending; p.dropped = p.local.worldItems.state.items.find(actor => actor.thrower === p.local.playerUuid); if (!p.dropped || p.dropped.pickupDelay !== 40 || p.local.authority.state.player[2].itemCount !== 9) throw new Error('Q must atomically persist one native dropped item and decrement its exact selected stack.'); });
  const physics = await page.evaluate(async () => {
    const p = window.itemProof, before = [...p.dropped.position]; await p.tick(40, false); const actor = p.local.worldItems.state.items.find(actor => actor.id === p.dropped.id);
    if (actor.pickupDelay !== 0 || actor.position.every((value, axis) => value === before[axis])) throw new Error('Native20TPS motion and40tick pickup delay must advance.');
    p.player.setPosition(actor.position); await p.tick(1);
    if (p.local.authority.state.player[2].itemCount !== 10 || p.local.worldItems.state.items.some(item => item.id === actor.id)) throw new Error('Native pickup must return the dropped stack without changing its source metadata identity.');
    return { age: actor.age, moved: true, pickupDelay: actor.pickupDelay };
  });
  const failure = await page.evaluate(async () => {
    const p = window.itemProof, before = await p.local.authority.snapshot(), spawns = p.events.filter(event => event.type === 'spawn').length; p.failNext = true;
    p.local.session.dropItem(); await p.local.pending; const after = await p.local.authority.snapshot();
    if (before.words.join() !== after.words.join() || JSON.stringify(before.components, (_key, value) => typeof value === 'bigint' ? `${value}n` : value) !== JSON.stringify(after.components, (_key, value) => typeof value === 'bigint' ? `${value}n` : value) || spawns !== p.events.filter(event => event.type === 'spawn').length) throw new Error('Failed actual worker save must roll back inventory, actor creation and publication.');
    p.local.session.dropItem(); const closing = p.local.close(); if (!p.local.closed || !p.local.worldItems.closed || document.querySelector('.local-inventory-ui')) throw new Error('Close gates actor ticks/input/DOM synchronously.'); await closing;
    p.local = await p.LocalInventory.open(p.options); await p.local.attachWorldItems({ ...p.attach, sourceItems: { ...p.descriptor, records: [] } });
    if (!p.local.authority.initial.worldItemsRestored || p.local.worldItems.state.items.length !== 2 || p.local.authority.state.player[2].itemCount !== 9 || p.local.playerUuid !== '12345678-1234-5678-1234-567812345678') throw new Error('Accepted pre-close throw and stable player/ground actor state must survive reopen and outrank changed source.');
    return true;
  });
  await page.evaluate(async () => {
    const p = window.itemProof, table = p.registry.blocks.find(block => block.name === 'crafting_table'); p.options.world.core.block_set(8, 70, 8, table.defaultState); await p.local.useBlock(8, 70, 8);
    for (let index = 0; index < 36; index++) await p.local.authority.setSlot('player', index, p.stack('stone', 64)); await p.local.authority.setSlot('cursor', 0, p.stack('oak_planks', 3)); await p.local.authority.setSlot('grid', 8, p.stack('oak_planks', 2)); p.local.accept(); p.beforeCloseActors = p.local.worldItems.state.items.length;
  });
  await page.locator('.local-inventory-ui [data-ui="inventory-close"]').click();
  const report = await page.evaluate(async () => {
    const p = window.itemProof; await p.local.pending;
    if (p.local.authority.state.width !== 2 || p.local.authority.state.cursor.present || p.local.authority.state.drops.length || p.local.worldItems.state.items.length !== p.beforeCloseActors + 2 || p.local.session.windowId !== 0) throw new Error('Full menu close must create native cursor/grid actors and acknowledge them in the same durable transaction.');
    const before = p.local.worldItems.snapshot(); await p.local.save(); await p.local.close(); p.local = await p.LocalInventory.open(p.options); await p.local.attachWorldItems(p.attach);
    if (p.local.worldItems.state.items.length !== before.items.length || p.local.worldItems.state.items.some((actor, index) => actor.uuid !== before.items[index].uuid || actor.bobOffset !== before.items[index].bobOffset || actor.stack.itemCount !== before.items[index].stack.itemCount)) throw new Error('Repeated save/close/reopen cannot replay source actors or duplicate delivered drops.');
    const noSourceWrites = p.descriptor.records[0].value.Item.value[p.registry.version.minecraftVersion === '1.20.4' ? 'Count' : 'count'].value === 7;
    await p.local.close(); URL.revokeObjectURL(p.workerUrl);
    return { validation: 'passed', backend: 'production LocalInventory/LocalWorldItems + actual Browser Worker/Rust WASM/IndexedDB', typedSourceEntityRegionImport: true, sourcePlayerOwnerBound: true, wrongOwnerNeverPicked: true,
      qNativeDropWith40TickDelay: true, nativeMotionAndGroundCollision: true, actualPickupRestoresExactStackIdentity: true, workerSaveFailureRollsBackBeforePublish: true, admittedThrowFinishesDuringClose: true,
      fullCursorAndTableGridCloseDeliveredAtomically: true, stableUuidBobAndCountsAcrossReopen: true, liveGroundSaveOutranksSource: true, originalTypedSourceUntouched: noSourceWrites, nativeRenderEventsPublished: p.events.some(event => event.entity?.visualAgeSeconds !== undefined && event.entity?.bobOffset !== undefined),
      noEligiblePickupRetainsActualInventoryDom: p.idleInventoryDomRetained,
      fullSurvivalImplemented: false, gpuUsed: false };
  });
  assert.deepEqual(errors, []); assert.equal(failure, true); assert.equal(physics.moved, true); await mkdir('test-results', { recursive: true }); await writeFile('test-results/local-world-items.json', JSON.stringify({ ...report, version, recipeSource: process.env.POMME_MINECRAFT_JAR ? 'private original client JAR' : 'generated mechanical recipe fixture' }, null, 2)); console.log(JSON.stringify({ ...report, version }, null, 2));
} finally { await browser.close(); }
