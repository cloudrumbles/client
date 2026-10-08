import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { chromium } from 'playwright';
import { gzipSync, zlibSync, zipSync } from '../vendor/fflate.js';

// A native Anvil fixture keeps the main-app lifecycle proof runnable without
// distributing a client JAR. POMME_AUTHORITY_REGIONS can supply real saves.
const join = arrays => {
  const bytes = new Uint8Array(arrays.reduce((sum, value) => sum + value.length, 0));
  let offset = 0; for (const value of arrays) { bytes.set(value, offset); offset += value.length; } return bytes;
};
const integer = (length, number) => {
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer);
  if (length === 1) view.setInt8(0, number); else if (length === 2) view.setInt16(0, number);
  else if (length === 4) view.setInt32(0, number); else view.setBigInt64(0, BigInt(number));
  return bytes;
};
const text = value => { const bytes = new TextEncoder().encode(value); return join([integer(2, bytes.length), bytes]); };
function payload(type, value) {
  if ([1, 2, 3, 4].includes(type)) return integer(({ 1: 1, 2: 2, 3: 4, 4: 8 })[type], value);
  if (type === 8) return text(value);
  if (type === 7) return join([integer(4, value.length), value]);
  if (type === 10) return join([...Object.entries(value).map(([name, [childType, child]]) => join([integer(1, childType), text(name), payload(childType, child)])), integer(1, 0)]);
  if (type === 9) return join([integer(1, value.type), integer(4, value.values.length), ...value.values.map(entry => payload(value.type, entry))]);
  throw new Error(`Unsupported fixture NBT type ${type}`);
}
const nbt = value => join([integer(1, 10), text(''), payload(10, value)]);
function regionFixture(floor = 'stone', { minY = 0, expand = false } = {}) {
  const chunks = Array.from({ length: expand ? 2 : 1 }, (_, x) => {
    const sections = [0, 1].map(offset => {
      const sectionY = minY / 16 + x * 2 + offset;
      return { Y: [sectionY >= -128 && sectionY <= 127 ? 1 : 3, sectionY], SkyLight: [7, new Uint8Array(2048).fill(offset ? 255 : 0)],
        BlockLight: [7, new Uint8Array(2048)], biomes: [10, { palette: [9, { type: 8, values: ['minecraft:plains'] }] }],
        block_states: [10, { palette: [9, { type: 10, values: [{ Name: [8, `minecraft:${offset ? 'air' : x ? 'gold_block' : floor}`] }] }] }] };
    });
    const compressed = zlibSync(nbt({ DataVersion: [3, 4671], xPos: [3, x], zPos: [3, 0], sections: [9, { type: 10, values: sections }], block_entities: [9, { type: 10, values: [] }] }));
    return { compressed, sectors: Math.ceil((compressed.length + 5) / 4096) };
  });
  const bytes = new Uint8Array((chunks.reduce((sum, chunk) => sum + chunk.sectors, 0) + 2) * 4096), view = new DataView(bytes.buffer);
  let sector = 2;
  for (const [x, { compressed, sectors }] of chunks.entries()) {
    view.setUint32(x * 4, sector * 256 + sectors); view.setUint32(sector * 4096, compressed.length + 1); bytes[sector * 4096 + 4] = 2; bytes.set(compressed, sector * 4096 + 5); sector += sectors;
  }
  return bytes;
}
const levelFixture = (minY = 0) => gzipSync(nbt({ Data: [10, { SpawnX: [3, 8], SpawnY: [3, minY + 18], SpawnZ: [3, 8], LevelName: [8, 'Authority main-app fixture'],
  DataVersion: [3, 4671], Version: [10, { Name: [8, '1.21.11'] }], DayTime: [4, 6000n], WorldGenSettings: [10, { seed: [4, 1650n] }] }] }));
const software = process.env.POMME_SOFTWARE_GPU === '1';
const jar = process.env.POMME_MINECRAFT_JAR;
const regionPaths = process.env.POMME_AUTHORITY_REGIONS?.split('|').filter(Boolean).map(path => resolve(path)) ?? [];
const levelPath = process.env.POMME_AUTHORITY_LEVEL;
const version = process.env.POMME_AUTHORITY_VERSION ?? '1.21.11';
const inputs = regionPaths.length ? [...regionPaths, ...(levelPath ? [resolve(levelPath)] : [])]
  : [{ name: 'r.0.0.mca', mimeType: 'application/octet-stream', buffer: Buffer.from(regionFixture()) }, { name: 'level.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(levelFixture()) }];
const minimalPack = zipSync({
  'pack.mcmeta': new TextEncoder().encode(JSON.stringify({ pack: { pack_format: 15, description: 'Lifecycle fixture' } })),
  'assets/minecraft/lang/en_us.json': new TextEncoder().encode('{"fixture.authority":"Browser authority lifecycle"}'),
});
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 270 } }); page.setDefaultTimeout(180000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon.ico') && !/\/favicon\.ico(?:\?|$)/.test(message.location().url)) errors.push(message.text()); });
  await page.goto(process.env.POMME_URL ?? 'http://127.0.0.1:5173');
  await page.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.engine));
  assert.equal(await page.locator('html').getAttribute('data-engine'), 'ready', await page.locator('#error').textContent());
  await page.evaluate(() => {
    document.querySelector('#adaptive').checked = false; document.querySelector('#cycle').checked = false;
    document.querySelector('#quality').value = 'low';
    const scale = document.querySelector('#resolution'); scale.value = '.5'; scale.dispatchEvent(new Event('input'));
    for (const id of ['authority-assets', 'authority-rejected', 'authority-regions', 'authority-alternate', 'authority-dimension']) {
      const input = document.createElement('input'); input.type = 'file'; input.id = id; input.multiple = true; input.hidden = true; document.body.append(input);
    }
  });
  await page.locator('#authority-assets').setInputFiles(jar ? resolve(jar) : { name: 'fixture.zip', mimeType: 'application/zip', buffer: Buffer.from(minimalPack) });
  console.log(`Loading ${jar ? basename(jar) : 'generated asset fixture'} locally.`);
  await page.evaluate(async version => window.pomme.loadPack(document.querySelector('#authority-assets').files[0], { version }), version);
  await page.locator('#authority-rejected').setInputFiles({ name: 'rejected-fixture.zip', mimeType: 'application/zip', buffer: Buffer.from(minimalPack) });
  const assetRejection = await page.evaluate(async () => {
    const p = window.pomme, { restoreResourcePack } = await import('/src/pack-store.js'), previous = p.assets, previousRegistry = p.registry, cached = await restoreResourcePack(), original = p.renderer.setTextureAtlas;
    let rejected = false;
    p.renderer.setTextureAtlas = () => { throw new Error('Fixture GPU atlas admission rejected'); };
    try { await p.loadPack(document.querySelector('#authority-rejected').files[0], { version: p.registry.version.minecraftVersion === '1.20.4' ? '1.21.11' : '1.20.4' }); }
    catch (error) { if (error.message !== 'Fixture GPU atlas admission rejected') throw error; rejected = true; }
    finally { p.renderer.setTextureAtlas = original; }
    const after = await restoreResourcePack();
    if (!rejected || p.assets !== previous || p.registry !== previousRegistry || after?.name !== cached?.name || after?.size !== cached?.size) throw new Error('Rejected GPU atlases must retain the last accepted registry, runtime pack and persistent asset file.');
    return { rejectedAtlasPreservesRegistry: true, rejectedAtlasPreservesRuntimePack: true, rejectedAtlasPreservesCachedPack: true };
  });
  await page.locator('#authority-regions').setInputFiles(inputs);
  console.log(`Importing ${regionPaths.length || 1} native Anvil region files.`);
  const imported = await page.evaluate(async version => window.pomme.importFiles([...document.querySelector('#authority-regions').files], { version }), version);
  assert.ok(imported.chunks > 0);
  await page.waitForFunction(() => window.pomme.authority && window.pomme.ready && window.pomme.renderer.stats().totalChunks > 0);
  let localInventory = null;
  if (jar) {
    await page.waitForFunction(() => window.pomme.localInventory && window.pomme.gameplay?.active);
    assert.equal(await page.evaluate(() => window.pomme.session), null, 'Imported inventory must not create a network session.');
    await page.keyboard.press('KeyE');
    await page.locator('[data-ui="inventory"]').waitFor({ state: 'visible' });
    await page.locator('[data-ui="creative-search"]').fill('oak_planks');
    await page.locator('[data-ui="creative-items"] .server-slot').first().click();
    await page.waitForFunction(() => {
      const p = window.pomme, item = p.registry.items.find(item => item.name === 'oak_planks');
      return p.localInventory.session.windows.get(0).slots[36]?.itemId === item.id;
    });
    await page.keyboard.press('Escape');
    const tablePosition = await page.evaluate(async () => {
      const p = window.pomme, column = [...p.world.columns.values()].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
      const x = column.x * 16 + 12, z = column.z * 16 + 8, y = Math.min(p.core.world_min_y() + p.core.world_height() - 3, p.core.terrain_height(x, z) + 2);
      const table = p.registry.blocks.find(block => block.name === 'crafting_table').defaultState;
      await p.edit(x, y, z, table); p.player.setPosition([x + .5, y + 2, z + 4]); p.player.fly = true;
      if (!await p.useBlock(x, y, z)) throw new Error('Imported native crafting tables must open the local 3×3 inventory.');
      return [x, y, z];
    });
    await page.waitForFunction(() => window.pomme.localInventory.session.state.windowId !== 0);
    const slots = page.locator('[data-ui="slots"]');
    await slots.locator('[data-slot="37"]').click();
    for (const slot of [1, 2, 4, 5]) await slots.locator(`[data-slot="${slot}"]`).click({ button: 'right' });
    await slots.locator('[data-slot="37"]').click();
    await page.waitForFunction(() => {
      const p = window.pomme, item = p.registry.items.find(item => item.name === 'crafting_table');
      return p.localInventory.session.windows.get(p.localInventory.session.state.windowId).slots[0]?.itemId === item.id;
    });
    await slots.locator('[data-slot="0"]').click();
    await slots.locator('[data-slot="38"]').click();
    await page.keyboard.press('Escape'); await page.keyboard.press('Digit2');
    await page.waitForFunction(() => window.pomme.localInventory.session.state.selectedSlot === 1);
    await page.evaluate(() => window.pomme.saveInventory());
    localInventory = await page.evaluate(() => {
      const p = window.pomme, slots = p.localInventory.session.windows.get(0).slots, plank = p.registry.items.find(item => item.name === 'oak_planks'), table = p.registry.items.find(item => item.name === 'crafting_table');
      if (slots[36]?.itemId !== plank.id || slots[36].itemCount !== 60 || slots[37]?.itemId !== table.id || slots[37].itemCount !== 1) throw new Error('Native local crafting must consume four planks and place one table in the player inventory.');
      return { nativeCreativeSelection: true, nativeThreeByThreeCrafting: true, consumedPlanks: 4, outputItem: table.id, outputCount: 1, selectedSlot: 1, networkSession: false };
    });
    const previousClosed = await page.evaluate(async () => {
      const p = window.pomme, previous = p.localInventory;
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      try { await p.resumeImported(); await p.authority.authority.pause(); }
      finally { delete document.hidden; }
      const slots = p.localInventory.session.windows.get(0).slots, table = p.registry.items.find(item => item.name === 'crafting_table');
      if (!previous.closed || p.localInventory === previous || slots[37]?.itemId !== table.id || slots[37].itemCount !== 1 || p.localInventory.session.state.selectedSlot !== 1) throw new Error('Inventory save/reopen must close the previous UI and preserve crafted items and selected hand.');
      return true;
    });
    localInventory.restoredItemsAndSelectedHand = true; localInventory.previousInventoryClosed = previousClosed; localInventory.tablePosition = tablePosition;
  }
  console.log(`Imported ${imported.chunks} chunks; checking main-app native ticks and persistence.`);
  const ticks = await page.evaluate(async () => {
    const check = (value, message) => { if (!value) throw new Error(message); };
    const p = window.pomme, bridge = p.authority, { registryStates } = await import('/src/anvil.js'), states = registryStates(p.registry);
    await bridge.authority.pause();
    const columns = [...p.world.columns.values()].sort((a, b) => Math.hypot(a.x * 16 + 8 - p.player.position[0], a.z * 16 + 8 - p.player.position[2]) - Math.hypot(b.x * 16 + 8 - p.player.position[0], b.z * 16 + 8 - p.player.position[2]));
    let position;
    for (const column of columns) {
      const x = column.x * 16 + 8, z = column.z * 16 + 8, y = Math.min(p.core.world_min_y() + p.core.world_height() - 3, Math.max(p.core.world_min_y() + 2, p.core.terrain_height(x, z) + 2));
      if (bridge.covers(x, y, z) && bridge.covers(x + 1, y, z)) { position = [x, y, z]; break; }
    }
    check(position, 'A visible imported column must have an authority-covered fixture position.');
    const [x, y, z] = position;
    p.player.setPosition([x + .5, y + 2, z + 4]); p.player.fly = true; p.player.yaw = 0; p.player.pitch = -.2;
    const stone = p.registry.blocks.find(block => block.name === 'stone').defaultState;
    const lamp = states.lookup('redstone_lamp', { lit: 'false' }), lit = states.lookup('redstone_lamp', { lit: 'true' });
    const off = states.lookup('stone_button', { face: 'floor', facing: 'north', powered: 'false' }), on = states.lookup('stone_button', { face: 'floor', facing: 'north', powered: 'true' });
    for (const [dx, id] of [[0, off], [1, lamp]]) { await p.edit(x + dx, y - 1, z, stone); check(await p.edit(x + dx, y, z, id), 'Main edits must route into the authority.'); }
    const fallback = [x + 3, y, z, x + 3, y + 1, z];
    await p.edit(x + 3, y, z, stone); await p.edit(x + 3, y + 1, z, 0);
    check(await p.place(fallback, stone), 'Unsupported block use must retain ordinary placement.');
    const before = p.core.block_get(x, y + 1, z);
    check(await p.place([x, y, z, x, y + 1, z], stone), 'Right-click must use a native button before placement.');
    check(p.core.block_get(x, y + 1, z) === before && p.core.block_get(x, y, z) === on && p.core.block_get(x + 1, y, z) === lit, 'Button use must light the lamp without placing a block.');
    await bridge.step(7); await p.saveAuthority();
    const key = `pomme-web-edits:${p.world.worldKey}`;
    check(JSON.parse(localStorage.getItem(key) ?? '[]').every(block => !bridge.covers(...block.slice(0, 3))), 'Saved authority positions must retire the legacy edit overlay.');
    const age = String(bridge.state.age), scope = bridge.stats();
    // Simulate a stale legacy edit left by an older browser build.
    localStorage.setItem(key, JSON.stringify([[x, y, z, off]]));
    window.authorityFixture = { position, stone, lamp, lit, off, on, age, key };
    return { position, age, scope, stateIds: { stone, lamp, lit, off, on }, placementFallback: true, useBeforePlacement: true, legacyOverlayRetired: true };
  });
  await page.evaluate(async () => {
    // A large software-rendered view can delay the next CDP command. Hold the
    // tab paused through reopen so exact saved deadlines are compared in ticks.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    try { await window.pomme.resumeImported(); await window.pomme.authority.authority.pause(); }
    finally { delete document.hidden; }
  });
  const restored = await page.evaluate(async () => {
    const p = window.pomme, f = window.authorityFixture, [x, y, z] = f.position, check = (value, message) => { if (!value) throw new Error(message); };
    await p.authority.authority.pause(); p.player.fly = true;
    check(p.authority.authority.initial.restored, 'Main resume must reopen the saved worker authority.');
    check(p.core.block_get(x, y, z) === f.on && p.core.block_get(x + 1, y, z) === f.lit, 'Saved authoritative button/lamp states must beat stale legacy overlays.');
    check(JSON.parse(localStorage.getItem(f.key) ?? '[]').length === 0, 'Covered stale legacy localStorage edits must be retired only after the authority save.');
    const elapsed = Number(p.authority.state.age - BigInt(f.age));
    check(elapsed === 0, `Resume must retain the saved clock while paused: saved ${f.age}, restored ${p.authority.state.age}, delta ${elapsed}.`);
    await p.authority.step(12 - elapsed);
    check(p.core.block_get(x, y, z) === f.on, 'Saved button remains pressed through native tick 19.');
    await p.authority.step(); check(p.core.block_get(x, y, z) === f.off && p.core.block_get(x + 1, y, z) === f.lit, 'Button releases on native tick 20 while the lamp turnoff is delayed.');
    await p.authority.step(4); check(p.core.block_get(x + 1, y, z) === f.lamp, 'Lamp turns off four ticks after loss of power.');
    await p.saveAuthority();
    let outside;
    for (const column of p.world.columns.values()) for (let sectionY = Math.floor(p.core.world_min_y() / 16); sectionY < (p.core.world_min_y() + p.core.world_height()) / 16; sectionY++) {
      const target = [column.x * 16 + 2, sectionY * 16 + 2, column.z * 16 + 2];
      if (!p.authority.covers(...target)) { outside = target; break; }
    }
    if (outside) {
      const stateId = p.core.block_get(...outside) === f.stone ? f.lamp : f.stone;
      check(await p.edit(...outside, stateId), 'A valid outside-scope position must retain synchronous local editing.');
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      check(JSON.parse(localStorage.getItem(f.key) ?? '[]').some(block => block.slice(0, 3).join(',') === outside.join(',')), 'Outside-scope edits retain their legacy persistence.');
    }
    return { restored: true, staleOverlayRetired: true, delayedTicksPreserved: true, outsideScopeFallback: Boolean(outside), pendingTicks: p.authority.state.pendingTicks };
  });
  console.log('Native scheduled ticks survived resume; checking pack replacement and bounded incremental admission.');
  await page.evaluate(() => window.pomme.loadPack(document.querySelector('#authority-assets').files[0]));
  const replaced = await page.evaluate(async () => {
    const p = window.pomme, f = window.authorityFixture, [x, y, z] = f.position, check = (value, message) => { if (!value) throw new Error(message); };
    await p.authority.authority.pause(); p.player.fly = true;
    check(p.authority.authority.initial.restored && p.core.block_get(x + 1, y, z) === f.lamp, 'Pack replacement must reattach the saved authority to the new mesh world.');
    const before = p.authority.stats(), bounds = p.world.bounds();
    let columnPosition;
    for (let cx = Math.ceil(bounds.min[0] / 16); cx < bounds.max[0] / 16 && !columnPosition; cx++) for (let cz = Math.ceil(bounds.min[2] / 16); cz < bounds.max[2] / 16; cz++) if (!p.world.columns.has(`${cx},${cz}`)) { columnPosition = [cx, cz]; break; }
    if (columnPosition && before.sections < before.maxSections) {
      const [cx, cz] = columnPosition, sectionY = Math.floor(y / 16), blocks = new Uint16Array(4096), index = 2 * 256 + 2 * 16 + 2;
      blocks[index] = f.stone;
      let callbacks = 0; const original = p.world.onColumn; p.world.onColumn = column => { if (column.x === cx && column.z === cz) callbacks++; original(column); };
      p.world.ingestColumn({ x: cx, z: cz, sections: [{ sectionY, blocks }] });
      for (let i = 0; i < 200 && !p.authority.covers(cx * 16 + 2, sectionY * 16 + 2, cz * 16 + 2); i++) await new Promise(resolve => setTimeout(resolve, 10));
      check(p.authority.covers(cx * 16 + 2, sectionY * 16 + 2, cz * 16 + 2), 'Incrementally streamed near columns must enter the available bounded authority scope.');
      await new Promise(resolve => setTimeout(resolve, 100)); p.world.onColumn = original;
      check(callbacks <= 2, 'Authority mirror ingestion must not recursively queue its own column.');
      check(await p.authority.authority.blockAt(cx * 16 + 2, sectionY * 16 + 2, cz * 16 + 2) === f.stone, 'Incremental source blocks must reach native authority.');
      return { reopened: true, incrementalAdmission: true, callbacks, sections: p.authority.stats().sections, maxSections: before.maxSections };
    }
    check(before.sections <= before.maxSections, 'Imported scope must stay within its resident section limit.');
    return { reopened: true, incrementalAdmission: false, scopeFull: before.sections === before.maxSections, sections: before.sections, maxSections: before.maxSections };
  });
  await page.locator('#authority-alternate').setInputFiles([
    { name: 'r.0.0.mca', mimeType: 'application/octet-stream', buffer: Buffer.from(regionFixture('gold_block')) },
    { name: 'level.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(levelFixture()) },
  ]);
  const stale = await page.evaluate(async () => {
    const p = window.pomme, { BrowserAuthority } = await import('/authority/client.js'), original = BrowserAuthority.open;
    let release, entered, delayed = true; const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; });
    BrowserAuthority.open = async function (options) { if (delayed) { delayed = false; entered(); await gate; } return original.call(this, options); };
    const previous = p.authority;
    const pending = p.resumeImported(); await waiting;
    const newWorld = p.importFiles([...document.querySelector('#authority-alternate').files], { version: p.registry.version.minecraftVersion });
    await newWorld; await p.authority.authority.pause(); p.player.fly = true;
    const generation = p.world.generation, current = p.authority;
    release(); await pending; BrowserAuthority.open = original;
    const gold = p.registry.blocks.find(block => block.name === 'gold_block').defaultState;
    if (p.authority !== current || p.world.generation !== generation || p.core.block_get(1, 1, 1) !== gold || !previous.closed) throw new Error('A delayed old-world authority must never alter the replacement imported world.');
    await p.saveAuthority();
    return { oldAuthorityClosedImmediately: previous.closed, staleBootstrapDiscarded: true, replacementNativeState: gold, generation };
  });
  await page.locator('#authority-dimension').setInputFiles([
    { name: 'r.0.0.mca', mimeType: 'application/octet-stream', buffer: Buffer.from(regionFixture('stone', { minY: 40000, expand: true })) },
    { name: 'level.dat', mimeType: 'application/octet-stream', buffer: Buffer.from(levelFixture(40000)) },
  ]);
  await page.evaluate(() => window.pomme.importFiles([...document.querySelector('#authority-dimension').files], { version: window.pomme.registry.version.minecraftVersion, hasSkylight: false }));
  const dimension = await page.evaluate(async () => {
    const p = window.pomme; await p.authority.authority.pause(); p.player.fly = true;
    const check = (value, message) => { if (!value) throw new Error(message); };
    const stone = p.registry.blocks.find(block => block.name === 'stone').defaultState, gold = p.registry.blocks.find(block => block.name === 'gold_block').defaultState;
    check(p.core.world_min_y() === 40000 && p.core.world_height() === 64 && p.world.hasSkylight === false, 'Source bounds must replace the default range and expand before later chunk sections.');
    check(p.core.block_get(1, 40001, 1) === stone && p.core.block_get(17, 40033, 1) === gold, 'Expanding imports must preserve both earlier and later native sections.');
    const saved = JSON.parse(localStorage.getItem('pomme-last-import'));
    check(saved.minY === 40000 && saved.height === 64 && saved.hasSkylight === false, 'Saved imports must retain their exact dimension range and skylight policy.');
    await p.resumeImported(); await p.authority.authority.pause(); p.player.fly = true;
    check(p.core.world_min_y() === 40000 && p.core.world_height() === 64 && !p.world.hasSkylight && p.core.block_get(1, 40001, 1) === stone && p.core.block_get(17, 40033, 1) === gold, 'Resume must retain the imported custom dimension and earlier source chunks.');
    return { minY: p.core.world_min_y(), height: p.core.world_height(), hasSkylight: p.world.hasSkylight, sourceExpansionPreservedEarlierChunks: true, restored: true };
  });
  const explicitDimension = await page.evaluate(async () => {
    const p = window.pomme;
    await p.importFiles([...document.querySelector('#authority-alternate').files], { version: p.registry.version.minecraftVersion, minY: 0, height: 256, hasSkylight: false });
    await p.authority.authority.pause(); p.player.fly = true;
    const key = p.world.worldKey;
    await p.resumeImported(); await p.authority.authority.pause(); p.player.fly = true;
    if (p.core.world_min_y() !== 0 || p.core.world_height() !== 256 || p.world.hasSkylight || p.world.worldKey !== key) throw new Error('Explicit dimension bounds and skylight must remain authoritative across import and resume.');
    return { minY: p.core.world_min_y(), height: p.core.world_height(), hasSkylight: p.world.hasSkylight, restored: true };
  });
  await page.waitForFunction(() => window.pomme.renderer.stats().totalChunks > 0);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/import-authority.png' });
  const renderer = await page.evaluate(async () => { const p = window.pomme; await p.renderer.readPixels(); return p.renderer.stats(); });
  assert.equal(renderer.lastError, null); assert.deepEqual(errors, []);
  const proof = { source: regionPaths.length ? 'actual saved Anvil regions' : 'generated native Anvil fixture', nativeVersion: version, privateAssets: jar ? basename(jar) : null,
    nativeProcessRequired: false, assetRejection, imported, localInventory, ticks, restored, replaced, stale, dimension, explicitDimension, renderedChunks: renderer.totalChunks, adapter: renderer.adapterInfo, softwareGPU: software, errors };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/import-authority.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
