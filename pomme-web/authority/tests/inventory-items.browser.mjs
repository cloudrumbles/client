import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-gpu'] }), errors = [];
try {
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__inventory-items-proof', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Atomic inventory and world item persistence</body></html>' }));
  await page.goto(new URL('/__inventory-items-proof', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const reports = await page.evaluate(async () => {
    const [{ InventoryAuthority }, { nativeFixtures }, { createWorldItemsSnapshot, appendWorldItemDrops }] = await Promise.all([import('/authority/inventory-client.js'), import('/authority/tests/inventory-fixtures.js'), import('/src/local-world-items-state.js')]);
    // This only injects a storage failure. All transfers, native mutation,
    // rollback and persistence still execute the production worker modules.
    const wrapper = `import { InventoryStorage } from '${location.origin}/authority/inventory-storage.js'; import '${location.origin}/authority/inventory-worker.js';
      const put = InventoryStorage.prototype.put; let fail = false;
      InventoryStorage.prototype.put = function(...args) { if (fail) { fail = false; throw new Error('Injected actual Worker storage failure'); } return put.apply(this, args); };
      const dispatch = self.onmessage; self.onmessage = event => { if (event.data.args?.testFailSave) fail = true; dispatch(event); };`;
    const workerUrl = URL.createObjectURL(new Blob([wrapper], { type: 'application/javascript' }));
    const WorkerClass = class { constructor(_url, options) { return new Worker(workerUrl, options); } };
    const check = (condition, message) => { if (!condition) throw new Error(message); }, equal = (a, b) => a.length === b.length && a.every((entry, index) => entry === b[index]);
    const reports = [];
    for (const version of ['1.20.4', '1.21.11']) {
      const registry = await (await fetch(`/data/${version}-registry.json`)).json(), data = nativeFixtures(registry), events = [], worldKey = `item-worker-${version}-${crypto.randomUUID()}`;
      const stack = (name, count, fields = {}) => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: count, ...fields });
      const options = { registry, data, worldKey, WorkerClass, onEvents: changes => events.push(...changes) }; let authority = await InventoryAuthority.open(options);
      check(authority.initial.worldItems.items.length === 0, 'Existing inventory init must expose an empty optional companion.');
      await authority.setSlot('player', 9, stack('oak_planks', 10));
      const context = { position: [-24.5, 72.2, 40_003.5], velocity: [.1, .2, -.1], pickupDelay: 0 }, empty = createWorldItemsSnapshot(registry);
      const dropped = await authority.dropWorldItems({ worldItems: empty, expectedItemsRevision: 0, slot: 9, options: { mode: 4, button: 0, width: 2 }, context });
      check(dropped.worldItems.items.length === 1 && dropped.state.player[9].itemCount === 9 && dropped.state.drops.length === 0, 'Native throw, actor creation and prefix acknowledgment must commit together.');
      const before = await authority.snapshot(), count = events.length; let failed = false;
      try { await authority.dropWorldItems({ worldItems: dropped.worldItems, expectedItemsRevision: dropped.worldItems.revision, slot: 9, options: { mode: 4, button: 1 }, context, testFailSave: true }); } catch (error) { failed = /Worker storage failure/.test(error.message); }
      const after = await authority.snapshot(); check(failed && events.length === count && equal(Array.from(before.words), Array.from(after.words)) && after.worldItems.items.length === 1, 'A failed durable throw must roll back before publishing any inventory or actor changes.');
      await authority.close(); authority = await InventoryAuthority.open(options); check(authority.initial.restored && authority.initial.worldItems.items.length === 1 && authority.state.player[9].itemCount === 9, 'Reopen must recover one committed actor and its exact decremented source.');
      let sidecar = await authority.worldItems(); sidecar = appendWorldItemDrops(sidecar, [stack('oak_planks', 20)], { ...context, position: [40_000.5, 73, -30.5] }, registry);
      await authority.commitWorldItems({ worldItems: sidecar, expectedItemsRevision: authority.initial.worldItems.revision });
      for (let index = 0; index < 36; index++) await authority.setSlot('player', index, stack('stone', 64));
      await authority.select(2); await authority.setSlot('player', 2, stack('oak_planks', 60)); await authority.setSlot('player', 40, stack('oak_planks', 63));
      const actor = sidecar.items.at(-1), picked = await authority.pickupWorldItem({ worldItems: sidecar, expectedItemsRevision: sidecar.revision, actorId: actor.id, actorRevision: actor.revision });
      check(picked.moved === 5 && picked.worldItems.items.at(-1).stack.itemCount === 15 && picked.state.player[2].itemCount === 64 && picked.state.player[40].itemCount === 64, 'Partial pickup must use actual native moved count and selected/offhand ordering.');
      const source = picked.worldItems.items.at(-1), saved = await authority.snapshot(); let rejected = false;
      try { await authority.pickupWorldItem({ worldItems: sidecar, expectedItemsRevision: sidecar.revision, actorId: source.id, actorRevision: 0 }); } catch (error) { rejected = /stale/.test(error.message); }
      check(rejected && equal(Array.from(saved.words), Array.from((await authority.snapshot()).words)), 'Replayed source acknowledgment must reject before duplication.');
      let noSpaceSidecar = picked.worldItems;
      for (let index = 0; index < 20; index++) {
        const fields = version === '1.20.4' ? { nbtData: { type: 'compound', value: { probe: { type: 'int', value: index } } } } : { components: [{ type: 'custom_data', data: { probe: index } }] };
        const candidate = appendWorldItemDrops(noSpaceSidecar, [stack('oak_planks', 7, fields)], context, registry); candidate.tick++;
        const actor = candidate.items.at(-1), accepted = await authority.pickupWorldItem({ worldItems: candidate, expectedItemsRevision: noSpaceSidecar.revision, actorId: actor.id, actorRevision: actor.revision });
        const snapshot = await authority.snapshot();
        check(accepted.moved === 0 && equal(Array.from(saved.words), Array.from(snapshot.words)) && JSON.stringify(snapshot.components) === JSON.stringify(saved.components), 'Repeated rejected pickups must not consume native component capacity or change inventory.');
        check(accepted.worldItems.tick === index + 1 && accepted.worldItems.items.at(-1).stack.itemCount === 7, 'A no-space pickup must still commit the latest actor physics without consuming its source.');
        noSpaceSidecar = accepted.worldItems;
      }
      await authority.save(); await authority.close(); authority = await InventoryAuthority.open(options);
      check(authority.initial.worldItems.items.find(actor => actor.id === source.id).stack.itemCount === 15 && authority.state.player[2].itemCount === 64, 'Normal save/close must retain both sides of a committed partial pickup.');
      check(authority.initial.worldItems.tick === 20 && authority.initial.worldItems.items.length === noSpaceSidecar.items.length, 'Rejected pickups must preserve their committed ground actors and physics through reopen.');
      await authority.close();
      reports.push({ version, nativeThrowAndActorCommitTogether: true, saveFailureRollsBackBeforeEvents: true, committedGroundActorsSurviveReopen: true, actualPartialPickup: 5, selectedAndOffhandRouting: true, staleAcknowledgmentCannotDuplicate: true, normalSaveAndCloseRetainCompanion: true, consecutiveNoSpacePickupsPreserveNativeComponents: 20, noSpacePhysicsPersistsThroughReopen: true });
    }
    URL.revokeObjectURL(workerUrl); return reports;
  });
  assert.deepEqual(errors, []); const report = { validation: 'passed', backend: 'actual production Browser Worker + Rust/WASM + IndexedDB', source: 'generated mechanical ordinary-stack fixture', injectedStorageFailure: true,
    mainActorHooksInstalled: false, productionUiDropsEnabled: false, fullSurvivalImplemented: false, gpuUsed: false, versions: reports };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/inventory-items-worker.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
