import { createWorldItemsSnapshot, validateWorldItemsSnapshot, consumeWorldItem, appendWorldItemDrops, worldItemPickupEligible } from '../src/local-world-items-state.js';

/** Inventory and its ground actors use one bounded durable record. Native
 * mutation, sidecar mutation and save must succeed before publishing either. */
export class InventoryItemTransactions {
  constructor({ runtime, registry, storage, worldKey, worldItems } = {}) {
    this.runtime = runtime; this.registry = registry; this.storage = storage; this.worldKey = worldKey;
    this.items = validateWorldItemsSnapshot(worldItems ?? createWorldItemsSnapshot(registry), registry);
  }
  snapshot() { return { ...this.runtime.snapshot(), worldItems: structuredClone(this.items) }; }
  state() { return structuredClone(this.items); }
  candidate(args) {
    if (!Number.isSafeInteger(args.expectedItemsRevision) || args.expectedItemsRevision !== this.items.revision) throw new Error('World item transaction has a stale saved revision.');
    const candidate = validateWorldItemsSnapshot(args.worldItems, this.registry);
    if (candidate.revision < this.items.revision) throw new Error('World item snapshot cannot rewind its saved revision.');
    if (this.items.playerUuid !== undefined && candidate.playerUuid !== this.items.playerUuid) throw new Error('World item snapshot cannot replace its saved local player identity.');
    return candidate;
  }
  async transaction(kind, args) {
    let next = this.candidate(args), moved = 0;
    const checkpoint = this.runtime.transactionCheckpoint();
    try {
      if (kind === 'pickup') {
        const actor = next.items.find(actor => actor.id === args.actorId);
        if (!actor || actor.revision !== args.actorRevision || !worldItemPickupEligible(actor, args.playerUuid)) throw new Error('World item pickup is stale or unavailable.');
        const result = this.runtime.pickup(actor.stack, { creative: Boolean(args.creative) }); moved = result.moved;
        next = consumeWorldItem(next, { actorId: actor.id, actorRevision: actor.revision, count: moved, playerUuid: args.playerUuid }, this.registry);
      } else if (kind === 'drop' || kind === 'deliver' || kind === 'grid') {
        if (kind === 'drop') this.runtime.menuClick(args.slot, { ...args.options, allowDrops: true });
        if (kind === 'grid') this.runtime.switchGrid(args.width, args.height);
        const native = this.runtime.state();
        next = appendWorldItemDrops(next, native.drops, args.context, this.registry);
        this.runtime.acknowledgeDrops({ count: native.drops.length, expectedRevision: native.revision });
      } else if (kind !== 'commit') throw new Error('Invalid world item transaction.');
      next.initialized = true;
      await this.storage.put(this.worldKey, { ...this.runtime.snapshot(), worldItems: next });
      this.items = next;
      return { worldItems: this.state(), moved, state: this.runtime.state() };
    } catch (error) { this.runtime.rollbackTransaction(checkpoint); throw error; }
  }
  restore(worldItems) { this.items = validateWorldItemsSnapshot(worldItems, this.registry); }
}
