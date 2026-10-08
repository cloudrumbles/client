import { LocalWorldItems, planSourceWorldItems, nativeSourceUuid } from './local-world-items.js';
import { validateWorldItemsSnapshot, worldItemPickupEligible, ITEM_WIDTH, ITEM_HEIGHT } from './local-world-items-state.js';
import { aabbAt, intersectsAabb } from './dynamic-collision.js';

const f = Math.fround, PI = f(Math.PI), sine = Float32Array.from({ length: 65536 }, (_, index) => Math.sin(index * Math.PI * 2 / 65536));
const narrow = value => Number.isNaN(value) ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(value)));
const trig = (value, cosine, modern) => sine[narrow(modern ? value * 10430.378350470453 + (cosine ? 16384 : 0) : f(f(value) * f(10430.378) + (cosine ? 16384 : 0))) & 65535];
const sourceChild = (tag, name) => tag?.type === 10 ? tag.value[name] : undefined;
export const worldItemsPreviouslyInitialized = snapshot => !!snapshot && (snapshot.initialized === true || snapshot.revision > 0 || snapshot.tick > 0 || snapshot.nextId > 1 || snapshot.items?.length > 0 || snapshot.deferred?.length > 0);

/** Original Player.drop forward throw, at eyeY -0.3f, with40tick pickup delay.
 * Player angles are browser radians; native orientation is converted explicitly.
 * Random.nextFloat draws are quantized24bit; seed/world RNG authority is separate. */
export function nativeLocalDropContext(player, playerUuid, version, random = Math.random) {
  if (!Array.isArray(player?.position) || player.position.length !== 3 || !player.position.every(Number.isFinite)) throw new Error('World item drops require the active player position.');
  const modern = version !== '1.20.4', nextFloat = () => Math.floor(random() * 16777216) / 16777216;
  const pitch = f(-f((player.pitch ?? 0) * 180 / Math.PI)), yaw = f(f(((player.yaw ?? 0) + Math.PI) * 180 / Math.PI));
  const pitchRadians = f(pitch * f(PI / 180)), yawRadians = f(yaw * f(PI / 180));
  const sinPitch = trig(pitchRadians, false, modern), cosPitch = trig(pitchRadians, true, modern), sinYaw = trig(yawRadians, false, modern), cosYaw = trig(yawRadians, true, modern);
  const angle = f(nextFloat() * f(PI * 2)), spread = f(f(.02) * nextFloat());
  return { position: [player.position[0], player.position[1] + f(player.eyeHeight ?? 1.62) - f(.3), player.position[2]],
    velocity: [f(f(-sinYaw * cosPitch) * f(.3)) + Math.cos(angle) * spread,
      f(f(f(-sinPitch * f(.3)) + f(.1)) + f(f(nextFloat() - nextFloat()) * f(.1))), f(f(cosYaw * cosPitch) * f(.3)) + Math.sin(angle) * spread],
    pickupDelay: 40, thrower: playerUuid, target: null };
}

/** All actor operations run inside the owning local inventory's single queue.
 * Physics freezes while that queue has admitted work; callbacks therefore never
 * nest a second queue admission or mutate inventory outside its serial actor. */
export class LocalInventoryItems {
  constructor(owner, { snapshot, sourceItems, sourceEntities, sample, loaded, collisionBoxes, collisionRevision, bounds, ultraWarm, onEvent = () => {}, random } = {}) {
    this.owner = owner; this.random = random; this.failedPickups = new Map();
    let initial = validateWorldItemsSnapshot(snapshot ?? owner.authority.initial.worldItems, owner.registry);
    if (!worldItemsPreviouslyInitialized(initial)) {
      if (sourceItems?.unavailable) throw new Error(`Source ground items are unavailable: ${sourceItems.unavailable.reason}`);
      const plan = planSourceWorldItems(sourceItems?.records ?? sourceEntities ?? [], { registry: owner.registry,
        version: sourceItems?.version, dataVersion: sourceItems?.dataVersion });
      initial = plan.snapshot;
    }
    initial.playerUuid ??= nativeSourceUuid(sourceChild(owner.sourceInventory?.player, 'UUID'), owner.registry.version.minecraftVersion) ?? crypto.randomUUID();
    initial.initialized = true; this.playerUuid = initial.playerUuid;
    this.worldItems = new LocalWorldItems({ registry: owner.registry, snapshot: initial, committedRevision: snapshot?.revision ?? owner.authority.initial.worldItems.revision,
      sample, loaded, collisionBoxes, collisionRevision, bounds, ultraWarm, isCurrent: () => owner.current(), onEvent,
      commit: args => owner.authority.commitWorldItems(args),
      pickup: async args => {
        const result = await owner.authority.pickupWorldItem(args);
        if (!result.moved) { const actor = this.worldItems.state.items.find(actor => actor.id === args.actorId); if (actor) this.failedPickups.set(actor.id, { revision: result.state.revision, count: actor.stack.itemCount, identity: this.worldItems.stackInfo(actor).identity }); }
        else this.failedPickups.clear();
        return result;
      }, drop: args => owner.authority.dropWorldItems(args), deliver: args => owner.authority.deliverWorldItems(args) });
  }
  context() { return nativeLocalDropContext(this.owner.player, this.playerUuid, this.owner.registry.version.minecraftVersion, this.random); }
  async menuClick(slot, options) {
    // A user action admitted before close still belongs to this private worker;
    // its actor events are gated, but its accepted stack transfer must finish.
    const result = await this.owner.authority.dropWorldItems({ worldItems: this.worldItems.snapshot(), expectedItemsRevision: this.worldItems.committedRevision,
      slot, options, context: this.context() });
    this.worldItems.accept(result.worldItems); return result.state;
  }
  async switchGrid(width) {
    const result = await this.owner.authority.switchWorldItemsGrid({ worldItems: this.worldItems.snapshot(), expectedItemsRevision: this.worldItems.committedRevision,
      width, height: width, context: this.context() });
    this.worldItems.accept(result.worldItems); return result.state;
  }
  async deliverPending() {
    const result = await this.owner.authority.deliverWorldItems({ worldItems: this.worldItems.snapshot(), expectedItemsRevision: this.worldItems.committedRevision, context: this.context() });
    this.worldItems.accept(result.worldItems); return result;
  }
  async save() {
    const result = await this.owner.authority.commitWorldItems({ worldItems: this.worldItems.snapshot(), expectedItemsRevision: this.worldItems.committedRevision });
    return this.worldItems.accept(result.worldItems);
  }
  shouldPickup(actor) {
    const failure = this.failedPickups.get(actor.id);
    return !failure || failure.revision !== this.owner.authority.state.revision || failure.count !== actor.stack.itemCount || failure.identity !== this.worldItems.stackInfo(actor).identity;
  }
  hasNearbyPickup(bounds) {
    const expanded = bounds.map((value, axis) => value + (axis < 3 ? -1 : 1) * [1, .5, 1][axis % 3]);
    return this.worldItems.state.items.some(actor => worldItemPickupEligible(actor, this.playerUuid) && this.worldItems.actorLoaded(actor)
      && intersectsAabb(expanded, aabbAt(actor.position, ITEM_WIDTH / 2, ITEM_HEIGHT)) && this.shouldPickup(actor));
  }
  advance(seconds, bounds) {
    const actor = this.worldItems, owner = this.owner;
    if (!owner.current() || owner.pendingCount || actor.busy) return 0;
    const ticks = actor.advance(seconds);
    const live = new Set(actor.state.items.map(item => item.id)); for (const id of this.failedPickups.keys()) if (!live.has(id)) this.failedPickups.delete(id);
    if (ticks && bounds && owner.canRun() && this.hasNearbyPickup(bounds)) void owner.run(() => actor.pickupNearby({ uuid: this.playerUuid, bounds, shouldPickup: item => this.shouldPickup(item) })).catch(() => {});
    return ticks;
  }
  closeGate() { return this.worldItems.close({ save: false }); }
  async shutdown() {
    // closeGate already stops events/physics synchronously. Finish all admitted
    // actions first, then return the open menu and create its actors atomically.
    const actor = this.worldItems;
    try {
      const result = await this.owner.authority.switchWorldItemsGrid({ worldItems: actor.snapshot(), expectedItemsRevision: actor.committedRevision,
        width: 2, height: 2, context: this.context() });
      actor.accept(result.worldItems);
    } catch (error) {
      // A full actor budget retains the native cursor/grid. Save accepted actor
      // physics without retrying a failed drop or losing its original stacks.
      const result = await this.owner.authority.commitWorldItems({ worldItems: actor.snapshot(), expectedItemsRevision: actor.committedRevision });
      actor.accept(result.worldItems); throw error;
    }
  }
}
