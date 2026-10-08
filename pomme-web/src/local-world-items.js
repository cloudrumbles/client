import { aabbAt, expandAabb, intersectsAabb, clipShapeMovement } from './dynamic-collision.js';
import { blockFriction, blockName, fluidState, fluidFlowAt } from './movement.js';
import { createWorldItemsSnapshot, validateWorldItemsSnapshot, worldItemStackIdentity, worldItemStackLimit,
  worldItemPickupEligible, worldItemPositionValid, mergeWorldItemPair, ITEM_WIDTH, ITEM_HEIGHT } from './local-world-items-state.js';
import { planSourceInventoryStack } from './source-inventory-stack.js';
import { structuredBytes } from '../authority/limits.js';

const STEP = 1 / 20, EPSILON = 1e-7, MAX_BLOCK_SAMPLES = 8192, MAX_EXTRA_SHAPES = 4096,
  MAX_QUERY_SHAPES = 8192, MAX_CACHED_SHAPES = 65536, MAX_SHAPE_CONTEXTS = 2048;
const bump = (snapshot, actor) => { snapshot.revision++; if (actor) actor.revision++; };
const box = actor => aabbAt(actor.position, ITEM_WIDTH / 2, ITEM_HEIGHT);
const inflated = (bounds, x, y, z) => bounds.map((value, axis) => value + (axis < 3 ? -1 : 1) * [x, y, z][axis % 3]);

// Native neighbor searches consider only matching, non-full stacks. Count bins
// reject impossible sums before enumerating actors, including dense piles of
// count64/max99 stacks, without imposing a merge cap or changing tick order.
class ItemIndex {
  constructor(actors, info, loaded) {
    this.info = info; this.groups = new Map(); this.entries = new Map();
    this.order = new Map(actors.map((actor, index) => [actor, index]));
    for (const actor of actors) if (loaded(actor)) this.add(actor);
  }
  eligible(actor) {
    return actor.pickupDelay !== 32767 && actor.age !== -32768 && actor.age < 6000
      && actor.stack.itemCount < this.info(actor).limit;
  }
  add(actor) {
    if (!this.eligible(actor)) return;
    const { identity } = this.info(actor), target = actor.target, count = actor.stack.itemCount, cell = actor.position.map(Math.floor).join(',');
    if (!this.groups.has(identity)) this.groups.set(identity, new Map()); const targets = this.groups.get(identity);
    if (!targets.has(target)) targets.set(target, new Map()); const counts = targets.get(target);
    if (!counts.has(count)) counts.set(count, new Map()); const cells = counts.get(count);
    if (!cells.has(cell)) cells.set(cell, new Set()); const bucket = cells.get(cell); bucket.add(actor);
    this.entries.set(actor, { identity, target, count, cell, bucket });
  }
  remove(actor) {
    const entry = this.entries.get(actor); if (!entry) return;
    entry.bucket.delete(actor); this.entries.delete(actor);
    const targets = this.groups.get(entry.identity), counts = targets.get(entry.target), cells = counts.get(entry.count);
    if (!entry.bucket.size) cells.delete(entry.cell);
    if (!cells.size) counts.delete(entry.count);
    if (!counts.size) targets.delete(entry.target);
    if (!targets.size) this.groups.delete(entry.identity);
  }
  nearby(actor) {
    if (!this.eligible(actor)) return [];
    const { identity, limit } = this.info(actor), counts = this.groups.get(identity)?.get(actor.target); if (!counts) return [];
    const [x, y, z] = actor.position.map(Math.floor), bounds = inflated(box(actor), .5, 0, .5), neighbors = [];
    for (const [count, cells] of counts) {
      if (count + actor.stack.itemCount > limit) continue;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
        for (const other of cells.get(`${x + dx},${y + dy},${z + dz}`) ?? []) if (other !== actor && intersectsAabb(bounds, box(other))) neighbors.push(other);
    }
    return neighbors.sort((a, b) => this.order.get(a) - this.order.get(b));
  }
}

const child = (tag, key) => tag?.type === 10 ? tag.value[key] : undefined;
const numeric = tag => tag && tag.type >= 1 && tag.type <= 6 && ['number', 'bigint'].includes(typeof tag.value);
// Both versions' Entity/ItemEntity fields use NumericTag getters, including
// Mth.floor for FloatTag/DoubleTag. This differs from modern ItemStack codecs.
const nativeInt = (tag, fallback = 0, floorFloats = true) => {
  if (!numeric(tag)) return fallback;
  if (typeof tag.value === 'bigint') return Number(BigInt.asIntN(32, tag.value));
  const value = tag.type === 5 ? Math.fround(tag.value) : tag.value;
  if (Number.isNaN(value)) return 0;
  const narrowed = Math.max(-2147483648, Math.min(2147483647, Math.trunc(value))) | 0;
  return floorFloats && tag.type >= 5 && value < narrowed ? narrowed - 1 | 0 : narrowed;
};
const short = (tag, fallback = 0) => nativeInt(tag, fallback) << 16 >> 16;
const boolean = tag => (nativeInt(tag) << 24 >> 24) !== 0;
export const nativeSourceUuid = (tag, version = '1.20.4') => {
  const modern = version !== '1.20.4'; let words;
  if (tag?.type === 11 && tag.value && (modern ? tag.value.length >= 4 : tag.value.length === 4)) words = Array.from({ length: 4 }, (_, index) => tag.value[index]);
  else if (modern && tag?.type === 9 && tag.value?.elementType >= 1 && tag.value.elementType <= 6 && tag.value.entries?.length >= 4
    && tag.value.entries.slice(0, 4).every(numeric)) words = tag.value.entries.slice(0, 4).map(entry => nativeInt(entry, 0, false));
  else if (modern && [7, 12].includes(tag?.type) && ArrayBuffer.isView(tag.value) && tag.value.length >= 4)
    words = Array.from({ length: 4 }, (_, index) => tag.type === 7 ? Number(tag.value[index]) << 24 >> 24 : nativeInt({ type: 4, value: tag.value[index] }));
  if (!words || words.some(value => !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) return null;
  const hex = words.map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const vector = (tag, modern) => {
  if (!modern) return [0, 1, 2].map(axis => tag?.type === 9 && tag.value?.elementType === 6 && tag.value.entries?.[axis]?.type === 6
    ? Number(tag.value.entries[axis].value) : 0);
  const entries = tag?.type === 9 && tag.value?.elementType >= 1 && tag.value.elementType <= 6 && Array.isArray(tag.value.entries)
    ? tag.value.entries.slice(0, 3).filter(numeric).map(entry => Number(entry.type === 5 ? Math.fround(entry.value) : entry.value))
    : [7, 11, 12].includes(tag?.type) && ArrayBuffer.isView(tag.value)
      ? Array.from({ length: Math.min(3, tag.value.length) }, (_, index) => tag.type === 7 ? Number(tag.value[index]) << 24 >> 24 : Number(tag.value[index])) : [];
  // Vec3.CODEC's fixedSize keeps the first three as a partial value on an
  // overlong list; TagValueInput.read admits that partial value. Short lists
  // have no partial value and Entity.load falls back to Vec3.ZERO.
  return entries.length >= 3 ? entries.slice(0, 3) : [0, 0, 0];
};

/** Typed native entity records share the exact save-stack codec boundary with
 * the inventory. Unsupported component codecs remain bounded deferred source,
 * never converted from the renderer's simplified preview representation. */
export function planSourceWorldItems(records, { registry, componentDecoders, version, dataVersion } = {}) {
  structuredBytes(records, 8 * 1024 * 1024);
  if (!Array.isArray(records) || records.length > 1024) throw new Error('Source world items exceed their actor limit.');
  const snapshot = createWorldItemsSnapshot(registry), diagnostics = [], uuids = new Set();
  for (const [ordinal, source] of records.entries()) {
    const type = child(source, 'id');
    if (type?.type !== 8 || type.value !== 'minecraft:item' && type.value !== 'item') continue;
    const plan = planSourceInventoryStack(child(source, 'Item'), { registry, componentDecoders, version, dataVersion });
    diagnostics.push(...plan.diagnostics.map(entry => ({ ordinal, ...entry })));
    if (!plan.ready) { snapshot.deferred.push({ ordinal, source: structuredClone(source), reasons: plan.deferred.map(entry => entry.reason) }); continue; }
    if (!plan.stack.present) continue;
    const modern = registry.version.minecraftVersion !== '1.20.4', position = vector(child(source, 'Pos'), modern).map((value, axis) => Math.max(axis === 1 ? -2e7 : -3.0000512e7, Math.min(axis === 1 ? 2e7 : 3.0000512e7, value))),
      velocity = vector(child(source, 'Motion'), modern).map(value => Math.abs(value) > 10 ? 0 : value);
    if (position.some(value => !Number.isFinite(value)) || velocity.some(value => !Number.isFinite(value))) {
      snapshot.deferred.push({ ordinal, source: structuredClone(source), reasons: ['Native source entity has non-finite motion.'] }); continue;
    }
    const uuid = nativeSourceUuid(child(source, 'UUID'), registry.version.minecraftVersion) ?? crypto.randomUUID();
    if (uuids.has(uuid)) { snapshot.deferred.push({ ordinal, source: structuredClone(source), reasons: ['Duplicate native source entity UUID.'] }); continue; }
    uuids.add(uuid); const id = snapshot.nextId++;
    snapshot.items.push({ id, uuid, revision: 0, stack: plan.stack,
      position, velocity,
      age: short(child(source, 'Age')), pickupDelay: short(child(source, 'PickupDelay')), health: short(child(source, 'Health'), registry.version.minecraftVersion === '1.20.4' ? 0 : 5),
      target: nativeSourceUuid(child(source, 'Owner'), registry.version.minecraftVersion), thrower: nativeSourceUuid(child(source, 'Thrower'), registry.version.minecraftVersion),
      noGravity: boolean(child(source, 'NoGravity')), grounded: boolean(child(source, 'OnGround')), tickCount: 0, bobOffset: Math.random() * Math.PI * 2 });
  }
  if (snapshot.items.length || snapshot.deferred.length) snapshot.revision++;
  return { snapshot: validateWorldItemsSnapshot(snapshot, registry), diagnostics };
}

/** Original ItemEntity fixed ticks, in authoritative doubles. Only loaded
 * imported columns simulate. Durable inventory transfers are delegated to the
 * combined inventory/items worker transaction, never synthesized visually. */
export class LocalWorldItems {
  constructor({ registry, snapshot, committedRevision, sample, loaded = () => true, collisionBoxes = () => [], collisionRevision = null,
    bounds = () => ({ min: [-2147483645, -64, -2147483645], max: [2147483644, 320, 2147483644] }),
    isCurrent = () => true, onEvent = () => {}, commit = null, pickup = null, drop = null, deliver = null, ultraWarm = false } = {}) {
    if (!registry?.items || typeof sample !== 'function') throw new Error('World items require a native registry and block sampler.');
    this.registry = registry; this.sampleBlock = sample; this.loaded = loaded; this.extraCollision = collisionBoxes;
    this.collisionRevision = collisionRevision; this.sampleCache = new Map(); this.shapeCache = new Map(); this.fluidContexts = new Map(); this.supportContexts = new Map(); this.cachedShapeCount = 0; this.contextToken = undefined;
    this.bounds = bounds; this.isCurrent = isCurrent; this.onEvent = onEvent; this.commit = commit; this.pickup = pickup; this.drop = drop; this.deliver = deliver; this.ultraWarm = ultraWarm;
    this.state = validateWorldItemsSnapshot(snapshot ?? createWorldItemsSnapshot(registry), registry);
    this.committedRevision = committedRevision ?? this.state.revision;
    if (!Number.isSafeInteger(this.committedRevision) || this.committedRevision < 0 || this.committedRevision > this.state.revision) throw new Error('Invalid committed world item revision.');
    this.accumulator = 0; this.busy = null; this.closed = false; this.stackInfos = new WeakMap();
    this.published = new Map(); this.mergeChecks = 0; this.tickSteps = 0; this.deferredTicks = 0; this.sampleReads = 0; this.sampleReuses = 0; this.shapeReuses = 0; this.fluidReuses = 0; this.supportReuses = 0;
    this.itemDefinition = registry.entities?.find(entity => entity.name === 'item');
    this.publish();
  }
  current() { return !this.closed && this.isCurrent(); }
  snapshot() { return validateWorldItemsSnapshot(this.state, this.registry); }
  sample(x, y, z) {
    if (!this.loaded(Math.floor(x / 16), Math.floor(z / 16))) return { flags: 3, material: null, fluid: { kind: null, height: 0 }, unknown: true };
    const key = `${x},${y},${z}`, cached = this.sampleCache.get(key);
    if (cached) { this.sampleReuses++; return cached; }
    const entry = this.sampleBlock(x, y, z);
    if (!entry || typeof entry !== 'object') throw new Error('Loaded world item blocks require an explicit native sample.');
    const material = entry.material, flags = entry.flags ?? material?.flags;
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffffffff) throw new Error('Invalid world item block flags.');
    const local = material?.collisionBoxes;
    if (local !== undefined && (!Array.isArray(local) || local.length > MAX_EXTRA_SHAPES || local.some(shape => !Array.isArray(shape) || shape.length !== 6
      || shape.some(value => !Number.isFinite(value)) || [0, 1, 2].some(axis => shape[axis] > shape[axis + 3])))) throw new Error('Invalid world item native collision shapes.');
    const fluid = entry.fluid ?? fluidState(material, flags);
    if (!fluid || ![null, 'water', 'lava'].includes(fluid.kind) || !Number.isFinite(fluid.height) || fluid.height < 0 || fluid.height > 1
      || fluid.flow !== undefined && (!Array.isArray(fluid.flow) || fluid.flow.length !== 3 || fluid.flow.some(value => !Number.isFinite(value)))) throw new Error('Invalid world item fluid sample.');
    const sample = { material, flags, fluid, unknown: false }; this.sampleReads++;
    if (this.sampleCache.size >= MAX_BLOCK_SAMPLES) this.sampleCache.delete(this.sampleCache.keys().next().value);
    this.sampleCache.set(key, sample); return sample;
  }
  stackInfo(actor) {
    let info = this.stackInfos.get(actor.stack);
    if (!info) { info = { identity: worldItemStackIdentity(actor.stack, this.registry), limit: worldItemStackLimit(actor.stack, this.registry) }; this.stackInfos.set(actor.stack, info); }
    return info;
  }
  actorLoaded(actor) { return this.loaded(Math.floor(actor.position[0] / 16), Math.floor(actor.position[2] / 16)); }
  supportingBlock(actor) {
    const key = actor.position.join(',');
    if (this.supportContexts.has(key)) { this.supportReuses++; return this.supportContexts.get(key); }
    const bounds = box(actor), [x, y, z] = actor.position; let result = null, distance = Infinity;
    for (let bx = Math.floor(bounds[0]) - 1; bx <= Math.floor(bounds[3]) + 1; bx++)
      for (let bz = Math.floor(bounds[2]) - 1; bz <= Math.floor(bounds[5]) + 1; bz++)
        for (let by = Math.floor(y) - 1; by <= Math.floor(y); by++) {
          const sample = this.sample(bx, by, bz), shapes = sample.material?.collisionBoxes ?? (sample.flags & 1 ? [[0, 0, 0, 1, 1, 1]] : []);
          if (!shapes.some(shape => Math.abs(by + shape[4] - y) < 1e-6
            && bounds[0] < bx + shape[3] - EPSILON && bounds[3] > bx + shape[0] + EPSILON
            && bounds[2] < bz + shape[5] - EPSILON && bounds[5] > bz + shape[2] + EPSILON)) continue;
          const nextDistance = (bx + .5 - x) ** 2 + (by + .5 - y) ** 2 + (bz + .5 - z) ** 2;
          // Native CollisionGetter uses Vec3i.compareTo (Y, Z, X) to choose
          // the greatest block position on an exactly equal center distance.
          if (nextDistance < distance || nextDistance === distance && result
            && (by - result.position[1] || bz - result.position[2] || bx - result.position[0]) > 0) {
            distance = nextDistance; result = { sample, position: [bx, by, bz] };
          }
        }
    if (this.supportContexts.size >= MAX_SHAPE_CONTEXTS) this.supportContexts.delete(this.supportContexts.keys().next().value);
    this.supportContexts.set(key, result); return result;
  }
  support(actor, offset) {
    const result = this.supportingBlock(actor), [x, y, z] = actor.position;
    if (!result) return this.sample(Math.floor(x), Math.floor(y - offset), Math.floor(z));
    const name = blockName(result.sample.material);
    if (offset <= .5 && name.endsWith('_fence') || name.endsWith('_wall') || name.endsWith('_fence_gate')) return result.sample;
    return this.sample(result.position[0], Math.floor(y - offset), result.position[2]);
  }
  shapes(bounds, actor = null) {
    const span = bounds.map((value, axis) => Math.floor(value) + (axis < 3 ? -1 : 1));
    const key = span.join(','), cached = this.shapeCache.get(key);
    if (cached) {
      this.shapeCache.delete(key); this.shapeCache.set(key, cached);
      this.shapeReuses++; return cached.concat(this.dynamicShapes(bounds));
    }
    const shapes = [], unknown = new Set();
    for (let x = Math.floor(bounds[0]) - 1; x <= Math.floor(bounds[3]) + 1; x++)
      for (let z = Math.floor(bounds[2]) - 1; z <= Math.floor(bounds[5]) + 1; z++) {
        const cx = Math.floor(x / 16), cz = Math.floor(z / 16), key = `${cx},${cz}`;
        if (!this.loaded(cx, cz)) {
          if (!unknown.has(key)) { unknown.add(key); shapes.push([cx * 16, -2147483646, cz * 16, cx * 16 + 16, 2147483645, cz * 16 + 16]); }
          continue;
        }
        for (let y = Math.floor(bounds[1]) - 1; y <= Math.floor(bounds[4]) + 1; y++) {
          const entry = this.sample(x, y, z), local = entry.material?.collisionBoxes ?? (entry.flags & 1 ? [[0, 0, 0, 1, 1, 1]] : []);
          for (const shape of local) {
            if (shapes.length >= MAX_QUERY_SHAPES) throw new Error('World item collision query exceeds its shape limit.');
            shapes.push(shape.map((value, axis) => value + [x, y, z][axis % 3]));
          }
        }
      }
    while (this.shapeCache.size >= MAX_SHAPE_CONTEXTS || this.cachedShapeCount + shapes.length > MAX_CACHED_SHAPES) {
      const oldest = this.shapeCache.keys().next().value; this.cachedShapeCount -= this.shapeCache.get(oldest).length; this.shapeCache.delete(oldest);
    }
    this.shapeCache.set(key, shapes); this.cachedShapeCount += shapes.length;
    return shapes.concat(this.dynamicShapes(bounds));
  }
  dynamicShapes(bounds) {
    const shapes = this.extraCollision(bounds) ?? [];
    if (!Array.isArray(shapes) || shapes.length > MAX_EXTRA_SHAPES || shapes.some(shape => !Array.isArray(shape) || shape.length !== 6
      || shape.some(value => !Number.isFinite(value)) || [0, 1, 2].some(axis => shape[axis] > shape[axis + 3]))) throw new Error('Invalid or oversized world item collision shapes.');
    return shapes;
  }
  fluids(actor, push = true) {
    const key = actor.position.join(','), cached = this.fluidContexts.get(key);
    if (cached) { this.fluidReuses++; if (push) this.pushFluids(actor, cached); return cached; }
    const bounds = box(actor).map((value, axis) => value + (axis < 3 ? .001 : -.001));
    const fluids = { water: { height: 0, flow: [0, 0, 0], count: 0 }, lava: { height: 0, flow: [0, 0, 0], count: 0 } };
    for (let x = Math.floor(bounds[0]); x < Math.ceil(bounds[3]); x++) for (let y = Math.floor(bounds[1]); y < Math.ceil(bounds[4]); y++)
      for (let z = Math.floor(bounds[2]); z < Math.ceil(bounds[5]); z++) {
        const sample = this.sample(x, y, z), kind = sample.fluid.kind; if (!kind || sample.unknown) continue;
        const fluid = fluids[kind], above = this.sample(x, y + 1, z), height = above.fluid.kind === kind ? 1 : sample.fluid.height;
        if (y + height < bounds[1]) continue;
        fluid.height = Math.max(fluid.height, y + height - bounds[1]);
        const flow = sample.fluid.flow ?? fluidFlowAt((x, y, z) => this.sample(x, y, z), x, y, z, sample.fluid);
        for (let axis = 0; axis < 3; axis++) fluid.flow[axis] += flow[axis] * (fluid.height < .4 ? fluid.height : 1);
        fluid.count++;
      }
    if (this.fluidContexts.size >= MAX_SHAPE_CONTEXTS) this.fluidContexts.delete(this.fluidContexts.keys().next().value);
    this.fluidContexts.set(key, fluids);
    if (push) this.pushFluids(actor, fluids);
    return fluids;
  }
  pushFluids(actor, fluids) {
    for (const [kind, fluid] of Object.entries(fluids)) {
      const length = Math.hypot(...fluid.flow); if (!length) continue;
      const scale = kind === 'water' ? .014 : this.ultraWarm ? .007 : .0023333333333333335;
      let flow = fluid.flow.map(value => value / length * scale);
      if (Math.abs(actor.velocity[0]) < .003 && Math.abs(actor.velocity[2]) < .003 && scale < .0045) flow = fluid.flow.map(value => value / length * .0045);
      actor.velocity = actor.velocity.map((value, axis) => value + flow[axis]);
    }
  }
  stepActor(actor) {
    const prior = [...actor.position]; actor.tickCount++;
    const fluids = this.fluids(actor);
    if (actor.pickupDelay > 0 && actor.pickupDelay !== 32767) actor.pickupDelay--;
    const threshold = this.state.version === '1.20.4' ? Math.fround(Math.fround(.25 * Math.fround(.85)) - Math.fround(.11111111)) : Math.fround(.1);
    const kind = fluids.water.height > threshold ? 'water' : fluids.lava.height > threshold ? 'lava' : null;
    if (kind) {
      const damping = Math.fround(kind === 'water' ? .99 : .95);
      actor.velocity = [actor.velocity[0] * damping, actor.velocity[1] + (actor.velocity[1] < Math.fround(.06) ? Math.fround(.0005) : 0), actor.velocity[2] * damping];
    } else if (!actor.noGravity) actor.velocity[1] -= .04;
    if (!actor.grounded || actor.velocity[0] ** 2 + actor.velocity[2] ** 2 > Math.fround(1e-5) || (actor.tickCount + actor.id) % 4 === 0) {
      const requested = [...actor.velocity], moved = clipShapeMovement(box(actor), this.shapes(expandAabb(box(actor), requested), actor), requested);
      actor.position = actor.position.map((value, axis) => value + moved[axis]);
      actor.grounded = requested[1] !== moved[1] && requested[1] < 0;
      for (const axis of [0, 2]) if (Math.abs(requested[axis] - moved[axis]) >= 1e-5) actor.velocity[axis] = 0;
      if (requested[1] !== moved[1]) {
        const name = blockName(this.support(actor, Math.fround(.2)).material);
        actor.velocity[1] = requested[1] < 0 && name === 'slime_block' ? -requested[1] * .8
          : requested[1] < 0 && name.endsWith('_bed') ? -requested[1] * .66 * .8 : 0;
      }
      const drag = actor.grounded ? Math.fround(Math.fround(blockFriction(this.support(actor, Math.fround(.999999)).material)) * Math.fround(.98)) : Math.fround(.98);
      actor.velocity = [actor.velocity[0] * drag, actor.velocity[1] * .98, actor.velocity[2] * drag];
      if (actor.grounded && actor.velocity[1] < 0) actor.velocity[1] *= -.5;
    }
    return prior.some((value, axis) => Math.floor(value) !== Math.floor(actor.position[axis]));
  }
  step() {
    if (!this.current() || this.busy) return false;
    this.state.tick++; this.tickSteps++;
    const token = this.collisionRevision ? this.collisionRevision() : this.state.tick;
    if (token === null || token === undefined || !Object.is(token, this.contextToken)) {
      this.contextToken = token; this.sampleCache.clear(); this.shapeCache.clear(); this.fluidContexts.clear(); this.supportContexts.clear(); this.cachedShapeCount = 0;
    }
    const actors = [...this.state.items], alive = new Set(actors), minY = this.bounds().min[1];
    const index = new ItemIndex(actors, actor => this.stackInfo(actor), actor => this.actorLoaded(actor));
    for (const actor of actors) {
      if (!alive.has(actor) || !this.actorLoaded(actor)) continue;
      index.remove(actor);
      const moved = this.stepActor(actor);
      index.add(actor);
      if (actor.tickCount % (moved ? 2 : 40) === 0) {
        for (const other of index.nearby(actor)) {
          if (!index.eligible(actor)) break;
          if (!alive.has(other)) continue;
          if (!index.eligible(other)) continue;
          this.mergeChecks++;
          const result = mergeWorldItemPair(actor, other, this.registry);
          if (result) {
            index.remove(result.target); index.remove(result.source); this.state.revision++;
            if (result.removed) alive.delete(result.source);
            index.add(result.target); if (!result.removed) index.add(result.source);
          }
          if (!alive.has(actor)) break;
        }
      }
      if (actor.age !== -32768) actor.age++;
      this.fluids(actor); bump(this.state, actor);
      if (actor.age >= 6000 || actor.position[1] < minY - 64 || !worldItemPositionValid(actor.position)) {
        alive.delete(actor); index.remove(actor);
      }
    }
    this.state.items = actors.filter(actor => alive.has(actor)); this.publish(); return true;
  }
  advance(seconds) {
    if (!this.current() || !Number.isFinite(seconds) || seconds < 0) return 0;
    this.accumulator = Math.min(.25, this.accumulator + seconds); let ticks = 0;
    while (this.accumulator + 1e-10 >= STEP && ticks < 5 && !this.busy) { this.accumulator -= STEP; this.step(); ticks++; }
    if (this.busy) this.deferredTicks++; return ticks;
  }
  publish() {
    if (!this.current() || !this.itemDefinition) return;
    const visible = new Set();
    for (const actor of this.state.items) if (this.actorLoaded(actor)) {
      visible.add(actor.id); const previous = this.published.get(actor.id); if (previous?.revision === actor.revision) continue;
      const identity = this.stackInfo(actor).identity, changedStack = !previous || previous.count !== actor.stack.itemCount || previous.identity !== identity;
      this.onEvent({ type: previous ? 'update' : 'spawn', entity: { id: actor.id, uuid: actor.uuid,
        entityType: this.itemDefinition.id, x: actor.position[0], y: actor.position[1], z: actor.position[2], yaw: 0, pitch: 0,
        grounded: actor.grounded, onGround: actor.grounded, visualAgeSeconds: actor.age / 20, bobOffset: actor.bobOffset,
        ...(changedStack ? { metadata: [{ key: this.itemDefinition.metadataKeys.indexOf('item'), value: structuredClone(actor.stack) }] } : {}) } });
      this.published.set(actor.id, { revision: actor.revision, identity, count: actor.stack.itemCount });
    }
    for (const id of this.published.keys()) if (!visible.has(id)) { this.onEvent({ type: 'remove', id }); this.published.delete(id); }
  }
  operation(action) {
    if (!this.current() || this.busy) return Promise.reject(new Error('World item transaction is unavailable.'));
    const promise = Promise.resolve().then(action);
    this.busy = promise;
    promise.finally(() => { if (this.busy === promise) this.busy = null; }).catch(() => {});
    return promise;
  }
  accept(snapshot) {
    this.state = validateWorldItemsSnapshot(snapshot, this.registry); this.committedRevision = this.state.revision;
    this.publish(); return this.snapshot();
  }
  save() {
    if (!this.commit) return Promise.reject(new Error('World item persistence is not connected.'));
    return this.operation(async () => {
      const result = await this.commit({ worldItems: this.snapshot(), expectedItemsRevision: this.committedRevision });
      return this.accept(result.worldItems ?? result);
    });
  }
  pickupNearby({ uuid, bounds, shouldPickup = () => true }) {
    if (!this.pickup) return Promise.resolve(0);
    return this.operation(async () => {
      let total = 0;
      for (const actor of [...this.state.items]) {
        if (!this.current()) break;
        if (!this.actorLoaded(actor) || !worldItemPickupEligible(actor, uuid) || !intersectsAabb(inflated(bounds, 1, .5, 1), box(actor)) || !shouldPickup(actor)) continue;
        const result = await this.pickup({ worldItems: this.snapshot(), expectedItemsRevision: this.committedRevision,
          actorId: actor.id, actorRevision: actor.revision, playerUuid: uuid });
        this.accept(result.worldItems); total += result.moved;
        if (!this.current()) break;
      }
      return total;
    });
  }
  dropItems({ slot, options, context }) {
    if (!this.drop) return Promise.reject(new Error('World item drops are not connected.'));
    return this.operation(async () => {
      const result = await this.drop({ worldItems: this.snapshot(), expectedItemsRevision: this.committedRevision, slot, options, context });
      this.accept(result.worldItems); return result;
    });
  }
  deliverPending(context) {
    if (!this.deliver) return Promise.reject(new Error('World item drop delivery is not connected.'));
    return this.operation(async () => {
      const result = await this.deliver({ worldItems: this.snapshot(), expectedItemsRevision: this.committedRevision, context });
      this.accept(result.worldItems); return result;
    });
  }
  close({ save = true } = {}) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const id of this.published.keys()) this.onEvent({ type: 'remove', id }); this.published.clear();
    return this.closePromise = (async () => {
      await this.busy;
      if (save && this.commit && this.isCurrent()) {
        const result = await this.commit({ worldItems: this.snapshot(), expectedItemsRevision: this.committedRevision });
        this.accept(result.worldItems ?? result);
      }
      return this.snapshot();
    })();
  }
  stats() { return { actors: this.state.items.length, deferredActors: this.state.deferred?.length ?? 0, revision: this.state.revision, committedRevision: this.committedRevision,
    tickSteps: this.tickSteps, mergeChecks: this.mergeChecks, deferredTicks: this.deferredTicks, busy: !!this.busy,
    sampleReads: this.sampleReads, sampleReuses: this.sampleReuses, sampleCacheEntries: this.sampleCache.size, shapeReuses: this.shapeReuses,
    cachedShapeCount: this.cachedShapeCount, shapeCacheEntries: this.shapeCache.size, fluidReuses: this.fluidReuses, fluidCacheEntries: this.fluidContexts.size,
    supportReuses: this.supportReuses, supportCacheEntries: this.supportContexts.size }; }
}
