import { structuredBytes } from '../authority/limits.js';
import * as inventory from '../authority/inventory.js';

export const MAX_WORLD_ITEMS = 1024, MAX_WORLD_ITEM_BYTES = 8 * 1024 * 1024;
export const ITEM_WIDTH = .25, ITEM_HEIGHT = .25;
const TAU = Math.PI * 2, MIN_COORD = -2147483646, MAX_COORD = 2147483645;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const integer = (value, min, max, name) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid world item ${name}.`);
  return value;
};
const uuid = value => value === null || typeof value === 'string' && UUID.test(value);
export const worldItemPositionValid = position => Array.isArray(position) && position.length === 3
  && position.every(value => Number.isFinite(value) && value > MIN_COORD + ITEM_WIDTH / 2 && value < MAX_COORD - ITEM_HEIGHT);
export function worldItemStackIdentity(stack, registry) {
  return inventory.nativeInventoryStackIdentity(stack, registry.items.find(item => item.id === stack?.itemId), registry.version.minecraftVersion);
}
export function worldItemStackLimit(stack, registry) {
  const item = registry.items.find(item => item.id === stack?.itemId);
  if (!item || item.name === 'air' || stack?.present !== true) throw new Error('Invalid world item stack.');
  integer(stack.itemCount, 1, 99, 'stack count');
  structuredBytes(stack, 4 * 1024 * 1024);
  worldItemStackIdentity(stack, registry);
  return inventory.nativeInventoryStackLimit(stack, item, registry.version.minecraftVersion);
}
export function createWorldItemsSnapshot(registry) {
  return { schema: 1, version: registry.version.minecraftVersion, revision: 0, nextId: 1, tick: 0, items: [], deferred: [] };
}

/** Worker and browser share this boundary; no unbounded source actor payloads
 * or visual-only NBT conversions are admitted to durable item authority. */
export function validateWorldItemsSnapshot(snapshot, registry) {
  structuredBytes(snapshot, MAX_WORLD_ITEM_BYTES);
  if (snapshot?.schema !== 1 || snapshot.version !== registry.version.minecraftVersion || !Array.isArray(snapshot.items)
    || snapshot.items.length > MAX_WORLD_ITEMS || snapshot.deferred !== undefined && (!Array.isArray(snapshot.deferred)
      || snapshot.items.length + snapshot.deferred.length > MAX_WORLD_ITEMS)) throw new Error('Invalid world item snapshot.');
  integer(snapshot.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'revision');
  integer(snapshot.nextId, 1, 2147483647, 'next ID'); integer(snapshot.tick, 0, Number.MAX_SAFE_INTEGER - 1, 'tick');
  if (snapshot.playerUuid !== undefined && (!uuid(snapshot.playerUuid) || snapshot.playerUuid === null)) throw new Error('Invalid world item player identity.');
  if (snapshot.initialized !== undefined && typeof snapshot.initialized !== 'boolean') throw new Error('Invalid world item initialization marker.');
  const ids = new Set(), uuids = new Set(); let identityBytes = structuredBytes(snapshot, MAX_WORLD_ITEM_BYTES);
  for (const actor of snapshot.items) {
    integer(actor?.id, 1, snapshot.nextId - 1, 'ID'); integer(actor.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'actor revision');
    if (!uuid(actor.uuid) || actor.uuid === null || ids.has(actor.id) || uuids.has(actor.uuid)) throw new Error('Duplicate or invalid world item identity.');
    ids.add(actor.id); uuids.add(actor.uuid);
    if (!worldItemPositionValid(actor.position) || !Array.isArray(actor.velocity) || actor.velocity.length !== 3
      || actor.velocity.some(value => !Number.isFinite(value) || Math.abs(value) > 10)) throw new Error('Invalid world item motion.');
    integer(actor.age, -32768, 32767, 'age'); integer(actor.pickupDelay, -32768, 32767, 'pickup delay');
    integer(actor.health, -32768, 32767, 'health'); integer(actor.tickCount, 0, Number.MAX_SAFE_INTEGER - 1, 'actor tick');
    if (!uuid(actor.target) || !uuid(actor.thrower) || typeof actor.noGravity !== 'boolean' || typeof actor.grounded !== 'boolean'
      || !Number.isFinite(actor.bobOffset) || actor.bobOffset < 0 || actor.bobOffset >= TAU) throw new Error('Invalid world item flags.');
    worldItemStackLimit(actor.stack, registry);
    // Repeated shared metadata still creates per-actor identity/cache strings.
    // Account for those expansions instead of only their shared input object.
    identityBytes += worldItemStackIdentity(actor.stack, registry).length * 2;
    if (identityBytes > MAX_WORLD_ITEM_BYTES) throw new Error('World item identities exceed their memory limit.');
  }
  return structuredClone(snapshot);
}

export function worldItemPickupEligible(actor, playerUuid) {
  return actor.pickupDelay === 0 && (actor.target === null || actor.target === playerUuid);
}

/** The worker supplies the native moved count, after its Inventory.add action.
 * A stale actor, wrong owner or failed persistence must never consume a stack. */
export function consumeWorldItem(snapshot, { actorId, actorRevision, count, playerUuid }, registry) {
  const next = validateWorldItemsSnapshot(snapshot, registry), index = next.items.findIndex(item => item.id === actorId), actor = next.items[index];
  if (!actor || actor.revision !== actorRevision || !worldItemPickupEligible(actor, playerUuid)) throw new Error('World item pickup is stale or unavailable.');
  integer(count, 0, actor.stack.itemCount, 'pickup count');
  if (!count) return next;
  if (count === actor.stack.itemCount) next.items.splice(index, 1);
  else { actor.stack.itemCount -= count; actor.revision++; }
  next.revision++;
  return next;
}

/** Drop queue delivery and its acknowledgement commit with this sidecar in one
 * inventory transaction. Failed admission leaves the original queue intact. */
export function appendWorldItemDrops(snapshot, drops, context, registry) {
  const next = validateWorldItemsSnapshot(snapshot, registry);
  if (!Array.isArray(drops) || next.items.length + (next.deferred?.length ?? 0) + drops.length > MAX_WORLD_ITEMS
    || next.nextId + drops.length > 2147483647) throw new Error('World item actor budget is full.');
  for (const stack of drops) {
    const id = next.nextId++;
    next.items.push({ id, uuid: crypto.randomUUID(), revision: 0, stack: structuredClone(stack),
      position: [...context.position], velocity: [...(context.velocity ?? [0, .2, 0])],
      age: 0, pickupDelay: context.pickupDelay ?? 40, health: 5, target: context.target ?? null,
      thrower: context.thrower ?? null, noGravity: false, grounded: false, tickCount: 0, bobOffset: Math.random() * TAU });
  }
  if (drops.length) next.revision++;
  return validateWorldItemsSnapshot(next, registry);
}

/** Original ItemEntity chooses the larger stack; ties choose the neighbor.
 * Sum must fit its native limit. The helper's 64 cap is native even for a modern
 * component-defined 99 limit, including negative and zero transfers above 64.
 * A zero transfer still copies the target's minimum age and maximum delay. */
export function mergeWorldItemPair(first, second, registry) {
  const eligible = actor => actor.pickupDelay !== 32767 && actor.age !== -32768 && actor.age < 6000
    && actor.stack.itemCount < worldItemStackLimit(actor.stack, registry);
  if (!eligible(first) || !eligible(second) || first.target !== second.target
    || worldItemStackIdentity(first.stack, registry) !== worldItemStackIdentity(second.stack, registry)
    || first.stack.itemCount + second.stack.itemCount > worldItemStackLimit(second.stack, registry)) return null;
  const target = second.stack.itemCount < first.stack.itemCount ? first : second, source = target === first ? second : first;
  const moved = Math.min(Math.min(worldItemStackLimit(target.stack, registry), 64) - target.stack.itemCount, source.stack.itemCount);
  target.stack.itemCount += moved; source.stack.itemCount -= moved;
  target.pickupDelay = Math.max(target.pickupDelay, source.pickupDelay); target.age = Math.min(target.age, source.age);
  target.revision++; source.revision++;
  return { target, source, removed: source.stack.itemCount === 0 };
}
