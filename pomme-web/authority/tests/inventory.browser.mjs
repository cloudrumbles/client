import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const errors = [], jar = process.env.POMME_MINECRAFT_JAR ? await readFile(process.env.POMME_MINECRAFT_JAR) : null;
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.21.11';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  if (jar) await page.route('**/__inventory-native.jar', route => route.fulfill({ body: jar, contentType: 'application/zip' }));
  await page.goto(new URL('/authority/inventory.js', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const result = await page.evaluate(async ({ nativeJar, version }) => {
    const [{ InventoryAuthority }, { nativeFixtures }, { loadNativeCraftingData }] = await Promise.all([import('/authority/inventory-client.js'), import('/authority/tests/inventory-fixtures.js'), import('/authority/native-crafting-data.js')]);
    const registry = await (await fetch(`/data/${version}-registry.json`)).json(), id = name => registry.items.find(item => item.name === name).id;
    const data = nativeJar ? await loadNativeCraftingData(await (await fetch('/__inventory-native.jar')).arrayBuffer(), { registry }) : nativeFixtures(registry);
    const check = (value, message) => { if (!value) throw new Error(message); }, stack = (name, itemCount, extra = {}) => ({ present: true, itemId: id(name), itemCount, ...extra });
    const worldKey = `inventory-browser-${crypto.randomUUID()}`, events = [];
    let authority = await InventoryAuthority.open({ registry, data, worldKey, onEvents: values => events.push(...values) });
    try {
      await authority.setSlot('grid', 3, stack('oak_log', 2)); check(authority.state.recipeId === 'minecraft:oak_planks', 'Native shapeless output must be derived inside WASM.');
      await authority.craft(); check(authority.state.cursor.itemCount === 4 && authority.state.grid[3].itemCount === 1, 'Crafting must consume one log and produce exactly four planks.');
      await authority.click('grid', 0, 1); await authority.click('grid', 2, 1); await authority.setSlot('grid', 3, null);
      check(authority.state.recipeId === 'minecraft:stick', 'Native trimmed shape must match the two vertical plank inputs.');
      check((await authority.craft()).batches === 0 && authority.state.grid[0].itemCount === 1, 'An incompatible cursor must leave the recipe untouched.');
      await authority.click('player', 8); await authority.craft(); await authority.click('player', 7);
      const fields = { components: [{ type: 'minecraft:custom_name', data: { text: 'Kept in WASM', color: 'gold' } }], nbtData: { customLong: { type: 'long', value: 7n } } };
      await authority.setSlot('player', 6, stack('oak_log', 2, fields));
      const savedRevision = authority.state.revision; await authority.close();
      authority = await InventoryAuthority.open({ registry, data, worldKey, onEvents: values => events.push(...values) });
      check(authority.initial.restored && authority.state.revision === savedRevision, 'IndexedDB must restore authoritative slots and revision.');
      check(authority.state.player[7].itemId === id('stick') && authority.state.player[7].itemCount === 4, 'Crafted items must survive browser-worker reopen.');
      check(authority.state.player[6].components[0].data.text === 'Kept in WASM' && authority.state.player[6].nbtData.customLong.value === 7n, 'Native component/NBT data must survive structured save/reopen.');
      const eventCount = events.length, queued = authority.setSlot('grid', 0, stack('oak_log', 2)), closing = authority.close();
      await Promise.all([queued, closing]); check(events.length === eventCount, 'Close must immediately gate queued old-inventory events.');
      let cake = null, stew = null;
      if (nativeJar) {
        authority = await InventoryAuthority.open({ registry, data, worldKey: `${worldKey}-cake`, width: 3 });
        for (const [index, name] of ['milk_bucket', 'milk_bucket', 'milk_bucket', 'sugar', 'egg', 'sugar', 'wheat', 'wheat', 'wheat'].entries()) await authority.setSlot('grid', index, stack(name, 1));
        check(authority.state.recipeId === 'minecraft:cake', 'Original-JAR shaped recipe must resolve native egg tag.');
        await authority.craft(); check(authority.state.cursor.itemId === id('cake'), 'Cake result must use the exact native item ID.');
        check(authority.state.grid.slice(0, 3).every(slot => slot.itemId === id('bucket')) && authority.state.grid.slice(3).every(slot => !slot.present), 'Milk ingredients leave their source-derived native bucket remainders in the crafting grid.');
        await authority.close(); authority = await InventoryAuthority.open({ registry, data, worldKey: `${worldKey}-cake`, width: 3 });
        check(authority.state.cursor.itemId === id('cake') && authority.state.grid[0].itemId === id('bucket'), 'Result and remainder must survive worker reopen.');
        cake = { exactNativeResult: true, bucketRemainders: 3, persisted: true };
        if (version === '1.21.11') {
          await authority.setSlot('cursor', 0, null); for (let index = 0; index < 9; index++) await authority.setSlot('grid', index, null);
          for (const [index, name] of ['bowl', 'brown_mushroom', 'red_mushroom', 'allium'].entries()) await authority.setSlot('grid', index, stack(name, 1));
          check(authority.state.recipeId === 'minecraft:suspicious_stew_from_allium', 'Native shapeless recipe output component must be selected.');
          await authority.craft(); const effects = authority.state.cursor.components.find(component => component.type === 'minecraft:suspicious_stew_effects').data;
          check(effects[0].id === 'minecraft:fire_resistance' && effects[0].duration === 60, 'Native output effect and duration must be retained without rewriting the recipe.');
          await authority.close(); authority = await InventoryAuthority.open({ registry, data, worldKey: `${worldKey}-cake`, width: 3 });
          check(authority.state.cursor.components[0].data[0].duration === 60, 'Native recipe component survives source-reinitialized worker reopen.');
          stew = { nativeRecipeComponents: true, persisted: true };
        }
      }
      return { validation: 'passed', backend: 'Browser Worker + Rust/WASM + IndexedDB', version, nativeProcessRequired: false, nativeJarRecipes: nativeJar ? data.recipes.length : null, unsupportedSpecialRecipes: nativeJar ? data.unsupported.length : null,
        inputConsumption: true, trimmedShapedMatch: true, incompatibleCursorDoesNotConsume: true, nativeComponentsPersisted: true, inventorySaveReopen: true, closingSuppressesQueuedEvents: true, cake, stew, events: events.length };
    } finally { await authority.close(); }
  }, { nativeJar: !!jar, version });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true }); await writeFile('test-results/browser-authority-inventory.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
