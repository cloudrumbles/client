import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { InventoryRuntime } from '../inventory.js';
import { InventoryStorage } from '../inventory-storage.js';
import { InventoryItemTransactions } from '../inventory-items.js';
import { nativeFixtures } from './inventory-fixtures.js';
import { createWorldItemsSnapshot, appendWorldItemDrops } from '../../src/local-world-items-state.js';
const wasmBytes = await readFile(new URL('../authority.wasm', import.meta.url));
globalThis.indexedDB = new IDBFactory();
const context = { position: [-24.5, 72.2, 40_003.5], velocity: [.1, .2, -.1], pickupDelay: 0 };
for (const version of ['1.20.4', '1.21.11']) {
  const registry = JSON.parse(await readFile(new URL(`../../data/${version}-registry.json`, import.meta.url))), stack = (name, itemCount, fields = {}) => ({ present: true, itemId: registry.items.find(item => item.name === name).id, itemCount, ...fields });
  async function setup() { const runtime = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }), storage = new InventoryStorage(); await storage.open(); const worldKey = `items-${version}-${crypto.randomUUID()}`, transactions = new InventoryItemTransactions({ runtime, registry, storage, worldKey }); return { runtime, storage, worldKey, transactions }; }
  test(`native ${version} pickup order and actor source decrement commit in one durable inventory record`, async () => {
    const { runtime, storage, transactions, worldKey } = await setup(); runtime.select(3); runtime.setSlot('player', 3, stack('oak_planks', 60)); runtime.setSlot('player', 40, stack('oak_planks', 63));
    const candidate = appendWorldItemDrops(createWorldItemsSnapshot(registry), [stack('oak_planks', 10)], context, registry), actor = candidate.items[0];
    const accepted = await transactions.transaction('pickup', { worldItems: candidate, expectedItemsRevision: 0, actorId: actor.id, actorRevision: actor.revision });
    assert.equal(accepted.moved, 10); assert.equal(accepted.worldItems.items.length, 0); assert.equal(accepted.state.player[3].itemCount, 64); assert.equal(accepted.state.player[40].itemCount, 64); assert.equal(accepted.state.player[0].itemCount, 5);
    const saved = await storage.get(version, worldKey), reopened = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); reopened.restore(saved); assert.deepEqual(reopened.state(), runtime.state()); assert.deepEqual(saved.worldItems, accepted.worldItems);
    await assert.rejects(transactions.transaction('pickup', { worldItems: candidate, expectedItemsRevision: 0, actorId: actor.id, actorRevision: actor.revision }), /stale saved/); storage.close();
  });
  test(`native ${version} partial pickup acknowledges only actual moved count and storage failure rolls back all interned state`, async () => {
    const { runtime, storage, transactions } = await setup(); for (let index = 0; index < 36; index++) runtime.setSlot('player', index, stack('stone', 64)); runtime.select(2); runtime.setSlot('player', 2, stack('oak_planks', 60)); runtime.setSlot('player', 40, stack('oak_planks', 63));
    const candidate = appendWorldItemDrops(createWorldItemsSnapshot(registry), [stack('oak_planks', 20)], context, registry), actor = candidate.items[0];
    const accepted = await transactions.transaction('pickup', { worldItems: candidate, expectedItemsRevision: 0, actorId: actor.id, actorRevision: 0 }); assert.equal(accepted.moved, 5); assert.equal(accepted.worldItems.items[0].stack.itemCount, 15); assert.equal(accepted.worldItems.items[0].revision, 1);
    const next = accepted.worldItems; next.items[0].stack = stack('oak_planks', 15, version === '1.20.4' ? { nbtData: { type: 'compound', value: { exact: { type: 'long', value: 7n } } } } : { components: [{ type: 'max_stack_size', data: 16 }], nbtData: { exact: 7n } });
    const before = runtime.snapshot(), sidecar = transactions.state(), bytes = runtime.componentBytes, keys = new Map(runtime.componentKeys), put = storage.put;
    storage.put = async () => { throw new Error('Simulated durable storage failure'); };
    await assert.rejects(transactions.transaction('pickup', { worldItems: next, expectedItemsRevision: sidecar.revision, actorId: actor.id, actorRevision: 1 }), /durable storage/);
    assert.deepEqual(runtime.snapshot(), before); assert.deepEqual(transactions.state(), sidecar); assert.equal(runtime.componentBytes, bytes); assert.deepEqual(runtime.componentKeys, keys); storage.put = put; storage.close();
  });
  test(`native ${version} throws persist queue delivery and acknowledgment together, and normal saves retain actors`, async () => {
    const { runtime, storage, transactions, worldKey } = await setup(); runtime.setSlot('player', 9, stack('oak_planks', 10));
    const accepted = await transactions.transaction('drop', { worldItems: transactions.state(), expectedItemsRevision: 0, slot: 9, options: { mode: 4, button: 0 }, context });
    assert.equal(accepted.state.player[9].itemCount, 9); assert.equal(accepted.state.drops.length, 0); assert.equal(accepted.worldItems.items.length, 1); assert.equal(accepted.worldItems.items[0].stack.itemCount, 1);
    const before = runtime.snapshot(), sidecar = transactions.state(), put = storage.put; storage.put = async () => { throw new Error('Simulated durable storage failure'); };
    await assert.rejects(transactions.transaction('drop', { worldItems: sidecar, expectedItemsRevision: sidecar.revision, slot: 9, options: { mode: 4, button: 1 }, context }), /durable storage/); assert.deepEqual(runtime.snapshot(), before); assert.deepEqual(transactions.state(), sidecar); storage.put = put;
    await storage.put(worldKey, runtime.snapshot()); assert.deepEqual((await storage.get(version, worldKey)).worldItems, sidecar, 'An ordinary inventory save cannot erase its persisted ground actors.');
    runtime.menuClick(9, { mode: 4, allowDrops: true }); const queued = runtime.state(); assert.throws(() => runtime.acknowledgeDrops({ count: 1, expectedRevision: queued.revision - 1 }), /acknowledgment/); assert.equal(runtime.state().drops.length, 1);
    const delivered = await transactions.transaction('deliver', { worldItems: sidecar, expectedItemsRevision: sidecar.revision, context }); assert.equal(delivered.state.drops.length, 0); assert.equal(delivered.worldItems.items.length, 2);
    await assert.rejects(transactions.transaction('commit', { worldItems: { ...delivered.worldItems, version: 'wrong' }, expectedItemsRevision: delivered.worldItems.revision }), /snapshot/); storage.close();
  });
  test(`native ${version} damaged pickup copies a complete stack while creative overflow matches Inventory.add`, async () => {
    const { runtime, storage } = await setup(); const fields = version === '1.20.4' ? { nbtData: { type: 'compound', value: { Damage: { type: 'int', value: 5 } } } } : { components: [{ type: 'damage', data: 5 }] };
    const moved = runtime.pickup(stack('diamond_sword', 3, fields)); assert.equal(moved.moved, 3); assert.equal(runtime.state().player[0].itemCount, 3); assert.equal(runtime.state().player[1].present, false);
    for (let index = 0; index < 36; index++) runtime.setSlot('player', index, stack('stone', 64));
    assert.equal(runtime.pickup(stack('oak_planks', 7)).moved, 0); assert.equal(runtime.pickup(stack('oak_planks', 7), { creative: true }).moved, 7); assert.ok(runtime.state().player.slice(0, 36).every(stack => stack.itemCount === 64)); storage.close();
  });
  test(`native ${version} repeated no-space pickups preserve component budgets while committing actor physics`, async () => {
    const { runtime, storage, transactions, worldKey } = await setup();
    for (let index = 0; index < 36; index++) runtime.setSlot('player', index, stack('stone', 64));
    const before = runtime.snapshot(), bytes = runtime.componentBytes, keys = new Map(runtime.componentKeys);
    let sidecar = transactions.state();
    for (let index = 0; index < 20; index++) {
      const fields = version === '1.20.4' ? { nbtData: { type: 'compound', value: { probe: { type: 'int', value: index } } } } : { components: [{ type: 'custom_data', data: { probe: index } }] };
      const source = stack('oak_planks', 7, fields);
      assert.equal(runtime.pickup(source).moved, 0, 'Direct Inventory.add must not retain metadata from a rejected source.');
      const candidate = appendWorldItemDrops(sidecar, [source], context, registry); candidate.tick++;
      const actor = candidate.items.at(-1), accepted = await transactions.transaction('pickup', { worldItems: candidate, expectedItemsRevision: sidecar.revision, actorId: actor.id, actorRevision: actor.revision });
      assert.equal(accepted.moved, 0); assert.equal(accepted.worldItems.items.at(-1).stack.itemCount, 7); assert.equal(accepted.worldItems.tick, index + 1);
      assert.deepEqual(runtime.snapshot(), before); assert.equal(runtime.componentBytes, bytes); assert.deepEqual(runtime.componentKeys, keys);
      sidecar = accepted.worldItems;
    }
    const saved = await storage.get(version, worldKey); assert.deepEqual(saved.worldItems, sidecar);
    const reopened = await InventoryRuntime.create({ registry, data: nativeFixtures(registry), wasmBytes }); reopened.restore(saved); assert.deepEqual(reopened.state(), runtime.state());
    runtime.setSlot('player', 0, { present: false }); const actor = sidecar.items.at(-1);
    const accepted = await transactions.transaction('pickup', { worldItems: sidecar, expectedItemsRevision: sidecar.revision, actorId: actor.id, actorRevision: actor.revision });
    assert.equal(accepted.moved, 7); assert.equal(accepted.worldItems.items.length, 19); assert.equal(runtime.components.length, before.components.length + 1);
    storage.close();
  });
}
