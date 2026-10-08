import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { InventoryRuntime } from '../authority/inventory.js';
import { InventoryItemTransactions } from '../authority/inventory-items.js';
import { nativeFixtures } from '../authority/tests/inventory-fixtures.js';
import { LocalInventory } from '../src/local-inventory.js';
import { LocalInventorySession } from '../src/local-inventory-session.js';
import { nativeLocalDropContext } from '../src/local-inventory-items.js';
import { readSourceWorldItems } from '../src/source-world-items.js';
import { sourceItemsRegion, sourceItemRecord, SOURCE_PLAYER_UUID_WORDS } from './fixtures/source-world-items-nbt.js';
const wasmBytes = await readFile(new URL('../authority/authority.wasm', import.meta.url));
for (const version of ['1.20.4', '1.21.11']) {
  const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url))), stack = (name, count) => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount: count });
  async function setup(records = [sourceItemRecord(version)], { attachItems = true } = {}) {
    const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }), sourceItems = await readSourceWorldItems([sourceItemsRegion(version, records)], { version });
    const storage = { count: 0, async put(_key, snapshot) { if (this.fail) { this.fail = false; throw new Error('Simulated durable storage failure'); } this.count++; this.saved = structuredClone(snapshot); } };
    const transactions = new InventoryItemTransactions({ runtime, registry, storage, worldKey: 'adapter-test' });
    const authority = { get state() { return runtime.state(); }, initial: { worldItems: transactions.state() }, async worldItems() { return transactions.state(); },
      menuClick: (...args) => runtime.menuClick(...args), async dropWorldItems(args) { return transactions.transaction('drop', args); }, async switchWorldItemsGrid(args) { return transactions.transaction('grid', args); },
      async commitWorldItems(args) { return transactions.transaction('commit', args); }, pickupCalls: 0, async pickupWorldItem(args) { this.pickupCalls++; return transactions.transaction('pickup', args); },
      async deliverWorldItems(args) { return transactions.transaction('deliver', args); }, async close({ save = true } = {}) { if (save) await storage.put('adapter-test', transactions.snapshot()); } };
    const player = { position: [8.5, 70, 8.5], eyeHeight: 1.62, yaw: 0, pitch: 0, fly: false }, events = [], statuses = [];
    const local = new LocalInventory({ registry, player, sourceInventory: { player: { type: 10, value: { UUID: { type: 11, value: new Int32Array(SOURCE_PLAYER_UUID_WORDS) } } } },
      world: {}, onStatus: message => statuses.push(message) }); local.authority = authority;
    local.session = new LocalInventorySession(local, registry, player); local.session.accept(authority.state); local.gameplay = { state() {}, inventory() {}, close() {}, openPanel() {} };
    const attach = { sourceItems, random: () => .5, sample: (_x, y) => y < 70 ? { flags: 1, material: { name: 'stone', flags: 1, collisionBoxes: [[0, 0, 0, 1, 1, 1]] } } : { flags: 0, material: null },
      loaded: () => true, bounds: () => ({ min: [-64, -64, -64], max: [64, 320, 64] }), collisionRevision: () => 0, onEvent: event => events.push(event) };
    if (attachItems) await local.attachWorldItems(attach); return { local, player, runtime, authority, storage, events, statuses, sourceItems, attach };
  }
  const bounds = player => [player.position[0] - .3, player.position[1], player.position[2] - .3, player.position[0] + .3, player.position[1] + 1.8, player.position[2] + .3];
  test(`local ${version} source owner, native delays, drop physics and actual pickup share the serial inventory actor`, async () => {
    const { local, player, runtime, authority } = await setup([sourceItemRecord(version), sourceItemRecord(version, { ordinal: 2, owner: [0, 0, 0, 2] })]);
    assert.equal(local.playerUuid, '12345678-1234-5678-1234-567812345678');
    local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending; assert.equal(runtime.state().player[0].itemCount, 7); assert.equal(local.worldItems.state.items.length, 1);
    assert.equal(local.session.dropItem(), true); await local.pending; assert.equal(runtime.state().player[0].itemCount, 6);
    const dropped = local.worldItems.state.items.find(actor => actor.thrower === local.playerUuid), before = [...dropped.position]; assert.equal(dropped.pickupDelay, 40);
    for (let tick = 0; tick < 40; tick++) { local.tickWorldItems(.05, { bounds: [-100, 0, -100, -99, 2, -99] }); await local.pending; }
    const actor = local.worldItems.state.items.find(actor => actor.id === dropped.id); assert.equal(actor.pickupDelay, 0); assert.notDeepEqual(actor.position, before);
    player.position = [...actor.position]; local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending;
    assert.equal(runtime.state().player[0].itemCount, 7); assert.equal(local.worldItems.state.items.length, 1); assert.equal(authority.pickupCalls, 2);
    await local.close();
  });
  test(`local ${version} no-space cache retries on inventory change and prunes expired actors`, async () => {
    const { local, player, runtime, authority } = await setup(); for (let index = 0; index < 36; index++) runtime.setSlot('player', index, stack('stone', 64));
    for (let tick = 0; tick < 20; tick++) { local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending; }
    assert.equal(authority.pickupCalls, 1); assert.equal(local.itemAdapter.failedPickups.size, 1);
    runtime.setSlot('player', 0, { present: false }); local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending;
    assert.equal(authority.pickupCalls, 2); assert.equal(runtime.state().player[0].itemCount, 7); assert.equal(local.itemAdapter.failedPickups.size, 0);
    local.itemAdapter.failedPickups.set(9999, { revision: runtime.state().revision }); local.tickWorldItems(.05); assert.equal(local.itemAdapter.failedPickups.size, 0); await local.close();
  });
  test(`local ${version} distant or absent ground stacks never rebuild inventory UI on every physics tick`, async () => {
    const { local, player, runtime, authority } = await setup(); let publications = 0;
    local.accept = () => publications++;
    for (let tick = 0; tick < 20; tick++) { local.tickWorldItems(.05, { bounds: [-100, 0, -100, -99, 2, -99] }); await local.pending; }
    assert.equal(authority.pickupCalls, 0); assert.equal(publications, 0);
    local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending; assert.equal(authority.pickupCalls, 1); assert.equal(publications, 1); assert.equal(runtime.state().player[0].itemCount, 7);
    for (let tick = 0; tick < 20; tick++) { local.tickWorldItems(.05, { bounds: bounds(player) }); await local.pending; }
    assert.equal(publications, 1, 'Empty actor worlds retain the existing inventory DOM instead of publishing unchanged state20times/second.');
    await local.close({ save: false });
  });
  test(`local ${version} failed throw rolls back; admitted throw finishes after synchronous close and restores without source replay`, async () => {
    const { local, runtime, storage, events, sourceItems, attach } = await setup([]); runtime.setSlot('player', 0, stack('oak_planks', 10));
    const before = runtime.snapshot(), spawns = events.filter(event => event.type === 'spawn').length; storage.fail = true;
    assert.equal(local.session.dropItem(), true); await local.pending; assert.deepEqual(runtime.snapshot(), before); assert.equal(local.worldItems.state.items.length, 0); assert.equal(events.filter(event => event.type === 'spawn').length, spawns);
    assert.equal(local.session.dropItem(), true); const closing = local.close(); assert.equal(local.closed, true); assert.equal(local.worldItems.closed, true); await closing;
    assert.equal(storage.saved.worldItems.items.length, 1); assert.equal(runtime.state().player[0].itemCount, 9); assert.equal(runtime.state().drops.length, 0);
    const reopened = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); reopened.restore(storage.saved); assert.equal(reopened.state().player[0].itemCount, 9);
    assert.equal(storage.saved.worldItems.initialized, true); assert.equal(storage.saved.worldItems.playerUuid, local.playerUuid); assert.equal(sourceItems.records.length, 0);
    const newer = await setup([sourceItemRecord(version)]); newer.local.worldItems.close({ save: false }); newer.local.itemAdapter = null; newer.local.worldItems = null; newer.local.itemsAttachPromise = null;
    newer.authority.worldItems = async () => storage.saved.worldItems; await newer.local.attachWorldItems(attach);
    assert.equal(newer.local.worldItems.state.items.length, 1); assert.equal(newer.local.worldItems.state.items[0].thrower, local.playerUuid); assert.equal(newer.local.playerUuid, local.playerUuid); await newer.local.close({ save: false });
  });
  test(`local ${version} failed durable delivery gates partially attached actors and retains its native drop queue`, async () => {
    const { local, runtime, storage, attach, events } = await setup([], { attachItems: false });
    runtime.setSlot('player', 0, stack('oak_planks', 3)); runtime.menuClick(36, { mode: 4, button: 0, allowDrops: true });
    const before = runtime.snapshot(); storage.fail = true;
    await assert.rejects(local.attachWorldItems(attach), /durable storage failure/);
    assert.deepEqual(runtime.snapshot(), before); assert.equal(local.itemAdapter, null); assert.equal(local.worldItems, null); assert.equal(local.playerUuid, undefined);
    assert.equal(local.session.dropItem(), false); assert.equal(runtime.state().drops.length, 1); assert.equal(events.some(event => event.type === 'spawn'), false);
    await local.close({ save: false });
  });
  test(`local ${version} source bootstrap distinguishes a prior empty sidecar from initialized actor history`, async () => {
    for (const initialized of [false, true]) {
      const { local, authority, attach } = await setup([sourceItemRecord(version)], { attachItems: false });
      authority.initial.restored = true;
      const saved = await authority.worldItems(); if (initialized) saved.initialized = true;
      authority.worldItems = async () => saved;
      await local.attachWorldItems(attach);
      assert.equal(local.worldItems.state.items.length, initialized ? 0 : 1, 'Existing slot saves alone do not prove a ground-actor history; initialized empty history does.');
      await local.close({ save: false });
    }
  });
  test(`local ${version} source player identity uses its original version's native UUID codec`, async () => {
    const { local, attach } = await setup([], { attachItems: false });
    local.sourceInventory.player.value.UUID = { type: 9, value: { elementType: 3, entries: [...SOURCE_PLAYER_UUID_WORDS, 999].map(value => ({ type: 3, value })) } };
    await local.attachWorldItems(attach);
    if (version === '1.20.4') assert.notEqual(local.playerUuid, '12345678-1234-5678-1234-567812345678');
    else assert.equal(local.playerUuid, '12345678-1234-5678-1234-567812345678');
    await local.close({ save: false });
  });
}
test('forward native drop context uses Float32 standing eye height and40tick delay', () => {
  const context = nativeLocalDropContext({ position: [10, 70, -10], yaw: 0, pitch: 0 }, '12345678-1234-5678-1234-567812345678', '1.20.4', () => .5);
  assert.equal(context.position[1], 70 + Math.fround(1.62) - Math.fround(.3)); assert.equal(context.pickupDelay, 40); assert.ok(context.velocity[2] < 0); assert.equal(context.target, null);
});
