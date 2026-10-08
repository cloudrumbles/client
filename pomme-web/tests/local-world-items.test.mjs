import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalWorldItems, planSourceWorldItems, nativeSourceUuid } from '../src/local-world-items.js';
import { createWorldItemsSnapshot, appendWorldItemDrops, consumeWorldItem, mergeWorldItemPair,
  validateWorldItemsSnapshot, MAX_WORLD_ITEMS, worldItemStackIdentity } from '../src/local-world-items-state.js';

const registries = {};
for (const version of ['1.20.4', '1.21.11']) registries[version] = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url)));
const playerUuid = '00000000-0000-0000-0000-000000000001';
const stack = (registry, count = 1, extra = {}) => ({ present: true, itemId: registry.items.find(item => item.name === 'oak_planks').id, itemCount: count, ...extra });
const seed = (registry, count = 1, context = {}) => appendWorldItemDrops(createWorldItemsSnapshot(registry), [stack(registry, count)], { position: [.5, 3, .5], velocity: [0, 0, 0], pickupDelay: 0, ...context }, registry);
const air = { flags: 128, material: { name: 'air', flags: 128, collisionBoxes: [] } };
const solid = { flags: 3, material: { name: 'stone', flags: 3, collisionBoxes: [[0, 0, 0, 1, 1, 1]] } };
const floor = (y = 0, material = solid) => (x, blockY, z) => blockY === y ? material : air;
const near = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('native fixed20TPS gravity, ground drag, partial collision and signed-coordinate precision', () => {
  for (const registry of Object.values(registries)) {
    const items = new LocalWorldItems({ registry, snapshot: seed(registry), sample: floor() });
    assert.equal(items.advance(.049), 0); assert.equal(items.advance(.001), 1);
    near(items.state.items[0].position[1], 2.96); near(items.state.items[0].velocity[1], -.0392);
    items.step(); near(items.state.items[0].position[1], 2.8808); near(items.state.items[0].velocity[1], -.077616);
    for (let i = 0; i < 80; i++) items.step(); near(items.state.items[0].position[1], 1); assert.equal(items.state.items[0].grounded, true);
    const moving = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, 1, .5], velocity: [.2, 0, 0] }), sample: floor() });
    moving.step(); near(moving.state.items[0].position[0], .7); near(moving.state.items[0].velocity[0], .2 * Math.fround(Math.fround(.6) * Math.fround(.98)));
    const slab = { flags: 3, material: { name: 'stone_slab', flags: 3, collisionBoxes: [[0, 0, 0, 1, .5, 1]] } };
    const partial = new LocalWorldItems({ registry, snapshot: seed(registry), sample: floor(0, slab) });
    for (let i = 0; i < 80; i++) partial.step(); near(partial.state.items[0].position[1], .5);
    for (const base of [-2147482600, 2147482600]) {
      const extreme = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [base + .5, base + 1, base + .5] }), sample: floor(base),
        bounds: () => ({ min: [base, base, base], max: [base + 16, base + 16, base + 16] }) });
      for (let i = 0; i < 20; i++) extreme.step(); assert.deepEqual(extreme.state.items[0].position, [base + .5, base + 1, base + .5]);
    }
  }
});

test('native water/lava buoyancy, float drag, flow pushing and unloaded-column barriers', () => {
  const registry = registries['1.21.11'];
  for (const kind of ['water', 'lava']) {
    const fluid = { flags: 4, material: { name: kind, flags: 4, collisionBoxes: [] }, fluid: { kind, height: 8 / 9, flow: [0, 0, 0] } };
    const items = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, .25, .5], velocity: [.1, 0, 0] }), sample: () => fluid });
    items.step(); near(items.state.items[0].position[1], .25 + Math.fround(.0005));
    near(items.state.items[0].velocity[0], .1 * Math.fround(kind === 'water' ? .99 : .95) * Math.fround(.98));
  }
  const flow = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, .25, .5] }), sample: () => ({ ...air, fluid: { kind: 'water', height: 1, flow: [1, 0, 0] } }) });
  flow.step(); near(flow.state.items[0].velocity[0], .014 * Math.fround(.99) * Math.fround(.98) + .014);
  const barrier = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [15.7, 2, .5], velocity: [.5, 0, 0] }), sample: () => air, loaded: x => x === 0 });
  barrier.step(); near(barrier.state.items[0].position[0], 15.875); assert.equal(barrier.state.items[0].velocity[0], 0);
  const sleeping = new LocalWorldItems({ registry, snapshot: seed(registry), sample: floor(), loaded: () => false });
  sleeping.advance(10); assert.equal(sleeping.state.items[0].age, 0); assert.equal(sleeping.state.items[0].tickCount, 0); assert.deepEqual(sleeping.state.items[0].position, [.5, 3, .5]);
});

test('native merge preserves component identity, owner, age, delay, sum-limit and64cap rules', () => {
  for (const registry of Object.values(registries)) {
    const snapshot = appendWorldItemDrops(seed(registry, 20, { position: [.5, 1, .5] }), [stack(registry, 30)], { position: [.6, 1, .5], velocity: [0, 0, 0], pickupDelay: 0 }, registry);
    const items = new LocalWorldItems({ registry, snapshot, sample: floor() });
    for (let i = 0; i < 40; i++) items.step(); assert.equal(items.state.items.length, 1); assert.equal(items.state.items[0].id, 2); assert.equal(items.state.items[0].stack.itemCount, 50);
    const a = seed(registry, 32).items[0], b = seed(registry, 33).items[0]; assert.equal(mergeWorldItemPair(a, b, registry), null);
    b.stack.itemCount = 20; a.target = playerUuid; assert.equal(mergeWorldItemPair(a, b, registry), null);
    b.target = playerUuid; a.pickupDelay = 5; a.age = 500; b.age = 10; const result = mergeWorldItemPair(a, b, registry);
    assert.equal(result.target.stack.itemCount, 52); assert.equal(result.target.age, 10); assert.equal(result.target.pickupDelay, 5);
    a.pickupDelay = 32767; assert.equal(mergeWorldItemPair(a, b, registry), null);
  }
  const registry = registries['1.21.11'], ordinary = stack(registry), explicit = stack(registry, 1, { components: [{ type: 'max_stack_size', data: 64 }] });
  assert.equal(worldItemStackIdentity(ordinary, registry), worldItemStackIdentity(explicit, registry));
  const a = seed(registry, 70).items[0], b = seed(registry, 1).items[0];
  for (const actor of [a, b]) actor.stack.components = [{ type: 'max_stack_size', data: 99 }];
  mergeWorldItemPair(a, b, registry); assert.equal(a.stack.itemCount, 64); assert.equal(b.stack.itemCount, 7);
});

test('pickup uses actual native moved count and stale/owner guards; despawn and immortal sentinels persist', () => {
  const registry = registries['1.21.11'], snapshot = seed(registry, 10), actor = snapshot.items[0];
  const next = consumeWorldItem(snapshot, { actorId: actor.id, actorRevision: actor.revision, count: 3, playerUuid }, registry);
  assert.equal(next.items[0].stack.itemCount, 7); assert.equal(snapshot.items[0].stack.itemCount, 10);
  assert.throws(() => consumeWorldItem(next, { actorId: actor.id, actorRevision: actor.revision, count: 3, playerUuid }, registry), /stale/);
  next.items[0].target = '00000000-0000-0000-0000-000000000002';
  assert.throws(() => consumeWorldItem(next, { actorId: actor.id, actorRevision: next.items[0].revision, count: 1, playerUuid }, registry), /unavailable/);
  snapshot.items[0].age = 5999; const expired = new LocalWorldItems({ registry, snapshot, sample: floor() }); expired.step(); assert.equal(expired.state.items.length, 0);
  snapshot.items[0].age = -32768; snapshot.items[0].pickupDelay = 32767;
  const immortal = new LocalWorldItems({ registry, snapshot, sample: floor() }); for (let i = 0; i < 10; i++) immortal.step();
  const reopened = new LocalWorldItems({ registry, snapshot: immortal.snapshot(), sample: floor() });
  assert.equal(reopened.state.items[0].age, -32768); assert.equal(reopened.state.items[0].pickupDelay, 32767);
});

test('pending pickup freezes ticks, close gates events immediately and all close callers await it', async () => {
  const registry = registries['1.21.11'], events = []; let finish;
  const items = new LocalWorldItems({ registry, snapshot: seed(registry, 10), sample: floor(), onEvent: event => events.push(event),
    pickup: args => new Promise(resolve => { finish = () => resolve({ moved: 3, worldItems: consumeWorldItem(args.worldItems, { ...args, count: 3 }, registry) }); }) });
  const pickup = items.pickupNearby({ uuid: playerUuid, bounds: [0, 1, 0, 1, 3, 1] }); await Promise.resolve();
  assert.equal(items.advance(.25), 0); assert.equal(items.state.items[0].age, 0);
  const closed = items.close({ save: false }), again = items.close({ save: false }); assert.equal(closed, again);
  const before = events.length; finish(); await pickup; await closed;
  assert.equal(events.length, before); assert.equal(items.snapshot().items[0].stack.itemCount, 7);
});

test('snapshot admission bounds actors, bytes, identities and malformed native motion before mutation', () => {
  const registry = registries['1.21.11'], snapshot = seed(registry); snapshot.items.push(structuredClone(snapshot.items[0]));
  assert.throws(() => validateWorldItemsSnapshot(snapshot, registry), /identity/);
  snapshot.items.length = 1; snapshot.items[0].velocity[0] = NaN; assert.throws(() => validateWorldItemsSnapshot(snapshot, registry), /motion/);
  const full = seed(registry); full.items = Array.from({ length: MAX_WORLD_ITEMS + 1 }, () => full.items[0]); assert.throws(() => validateWorldItemsSnapshot(full, registry), /snapshot/);
  const oversized = seed(registry); oversized.items[0].stack.nbtData = 'x'.repeat(4 * 1024 * 1024 + 1); assert.throws(() => validateWorldItemsSnapshot(oversized, registry), /memory/);
});

test('native item friction samples nearly one block below, with nonliving bed/slime bounce', () => {
  const registry = registries['1.21.11'];
  const iceSlab = { flags: 3, material: { name: 'ice', flags: 3, collisionBoxes: [[0, 0, 0, 1, .5, 1]] } };
  const ice = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, .5, .5], velocity: [.2, 0, 0] }), sample: floor(0, iceSlab) });
  // ItemEntity.getOnPos(0.999999f) samples Y-1 below a half-height surface.
  ice.step(); near(ice.state.items[0].velocity[0], .2 * Math.fround(Math.fround(.6) * Math.fround(.98)));
  const seam = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [1, 1, .5], velocity: [0, 0, .2] }),
    sample: (x, y) => y !== 0 ? air : x === 1 ? { ...solid, material: { ...solid.material, name: 'ice' } } : solid });
  seam.step(); near(seam.state.items[0].velocity[2], .2 * Math.fround(Math.fround(.98) * Math.fround(.98)));
  for (const [name, height, restitution] of [['red_bed', .5625, .66 * .8], ['slime_block', 1, .8]]) {
    const material = { flags: 3, material: { name, flags: 3, collisionBoxes: [[0, 0, 0, 1, height, 1]] } };
    const bounce = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, height + .1, .5], velocity: [0, -.2, 0] }), sample: floor(0, material) });
    bounce.step(); near(bounce.state.items[0].position[1], height); near(bounce.state.items[0].velocity[1], .24 * restitution * .98);
  }
});

test('typed source entity bootstrap retains UUID, native age/delay/motion and deferred component records', () => {
  const compound = value => ({ type: 10, value }), tag = (type, value) => ({ type, value });
  const vector = values => tag(9, { elementType: 6, entries: values.map(value => tag(6, value)) });
  for (const registry of Object.values(registries)) {
    const legacy = registry.version.minecraftVersion === '1.20.4';
    const source = compound({ id: tag(8, 'minecraft:item'), UUID: tag(11, new Int32Array([0, 0, 0, 1])),
      Pos: vector([-20.5, 100, 3.5]), Motion: vector([11, -.3, .1]), Age: tag(2, -32768), PickupDelay: tag(2, 32767),
      NoGravity: tag(1, 1), Item: compound({ id: tag(8, 'minecraft:oak_planks'), [legacy ? 'Count' : 'count']: tag(legacy ? 1 : 3, 10) }) });
    const before = structuredClone(source), plan = planSourceWorldItems([source], { registry });
    assert.deepEqual(source, before); assert.equal(plan.snapshot.items.length, 1); const item = plan.snapshot.items[0];
    assert.equal(item.uuid, playerUuid); assert.deepEqual(item.position, [-20.5, 100, 3.5]); assert.deepEqual(item.velocity, [0, -.3, .1]);
    assert.equal(item.age, -32768); assert.equal(item.pickupDelay, 32767); assert.equal(item.noGravity, true); assert.equal(item.stack.itemCount, 10);
    if (!legacy) {
      source.value.Item.value.components = compound({ 'minecraft:custom_name': tag(8, 'source native text') });
      const deferred = planSourceWorldItems([source], { registry }); assert.equal(deferred.snapshot.items.length, 0);
      assert.equal(deferred.snapshot.deferred.length, 1); assert.deepEqual(deferred.snapshot.deferred[0].source, source);
    }
  }
});

test('individual native tick order merges before aging and before unticked neighbor delay changes', () => {
  for (const registry of Object.values(registries)) {
    const snapshot = appendWorldItemDrops(seed(registry, 30, { position: [.5, 1, .5], pickupDelay: 4 }), [stack(registry, 20)],
      { position: [.6, 1, .5], velocity: [0, 0, 0], pickupDelay: 10 }, registry);
    snapshot.items[0].age = 100; snapshot.items[1].age = 10;
    snapshot.items[0].tickCount = snapshot.items[1].tickCount = 39;
    const items = new LocalWorldItems({ registry, snapshot, sample: floor() }); items.step();
    assert.equal(items.state.items.length, 1); const survivor = items.state.items[0];
    assert.equal(survivor.id, 1); assert.equal(survivor.stack.itemCount, 50);
    assert.equal(survivor.age, 11); assert.equal(survivor.pickupDelay, 10); assert.equal(survivor.tickCount, 40);
  }
  const registry = registries['1.21.11'], a = seed(registry, 64).items[0], b = seed(registry, 1).items[0];
  for (const actor of [a, b]) actor.stack.components = [{ type: 'max_stack_size', data: 99 }];
  a.age = 100; b.age = 10; a.pickupDelay = 5; b.pickupDelay = 9;
  const result = mergeWorldItemPair(a, b, registry);
  assert.equal(result.target, a); assert.equal(result.removed, false);
  assert.equal(a.stack.itemCount, 64); assert.equal(b.stack.itemCount, 1); assert.equal(a.age, 10); assert.equal(a.pickupDelay, 9);
});

test('stable source collision caches reuse resting context, invalidate voxel changes and requery dynamic boxes', () => {
  const registry = registries['1.21.11']; let revision = 1, present = true, dynamic = [], queries = 0;
  const items = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, 1, .5] }),
    sample: (x, y, z) => present ? floor()(x, y, z) : air, collisionRevision: () => revision,
    collisionBoxes: () => { queries++; return dynamic; } });
  for (let tick = 0; tick < 12; tick++) items.step();
  const reads = items.stats().sampleReads, previousQueries = queries;
  for (let tick = 0; tick < 12; tick++) items.step();
  assert.equal(items.stats().sampleReads, reads); assert.ok(items.stats().shapeReuses > 0); assert.ok(items.stats().fluidReuses > 0);
  assert.ok(queries > previousQueries, 'dynamic BE collision must still be queried on native movement ticks');
  present = false; revision++; for (let tick = 0; tick < 4; tick++) items.step();
  assert.ok(items.state.items[0].position[1] < 1); assert.ok(items.stats().sampleReads > reads);
  const wall = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [.5, 2, .5], velocity: [.2, 0, 0] }),
    sample: () => air, collisionRevision: () => 1, collisionBoxes: () => dynamic });
  wall.step(); dynamic = [[1, 0, 0, 2, 4, 1]]; wall.step(); near(wall.state.items[0].position[0], .875);
  assert.ok(items.stats().sampleCacheEntries <= 8192); assert.ok(items.stats().cachedShapeCount <= 65536);
});

test('dense impossible native merge sums avoid pair enumeration while retaining bounded caches', () => {
  const registry = registries['1.21.11'], snapshot = createWorldItemsSnapshot(registry);
  const prototype = seed(registry, 64, { position: [.5, 1, .5] }).items[0]; prototype.stack.components = [{ type: 'max_stack_size', data: 99 }];
  snapshot.nextId = MAX_WORLD_ITEMS + 1;
  snapshot.items = Array.from({ length: MAX_WORLD_ITEMS }, (_, index) => ({ ...structuredClone(prototype), id: index + 1,
    uuid: `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, '0')}`, tickCount: 39 }));
  const items = new LocalWorldItems({ registry, snapshot, sample: floor(), collisionRevision: () => 1 }); items.step();
  assert.equal(items.state.items.length, MAX_WORLD_ITEMS); assert.equal(items.stats().mergeChecks, 0);
  assert.ok(items.stats().sampleReads < 100); assert.ok(items.stats().cachedShapeCount < 100);
  assert.ok(items.stats().shapeReuses > 900); assert.ok(items.stats().fluidReuses > 2000);
});

test('source native NumericTag narrowing and version-specific vector codecs preserve typed failures', () => {
  const compound = value => ({ type: 10, value }), tag = (type, value) => ({ type, value });
  const list = (type, values) => tag(9, { elementType: type, entries: values.map(value => tag(type, value)) });
  for (const registry of Object.values(registries)) {
    const legacy = registry.version.minecraftVersion === '1.20.4';
    const source = compound({ id: tag(8, 'minecraft:item'), Pos: list(6, [Infinity, -Infinity, 7]), Motion: list(6, [0, 0, 0]),
      Age: tag(5, -.2), PickupDelay: tag(4, 65535n), NoGravity: tag(3, 256), OnGround: tag(6, -.2),
      Item: compound({ id: tag(8, 'minecraft:oak_planks'), [legacy ? 'Count' : 'count']: tag(legacy ? 1 : 3, 1) }) });
    let plan = planSourceWorldItems([source], { registry }), actor = plan.snapshot.items[0];
    assert.deepEqual(actor.position, [3.0000512e7, -2e7, 7]); assert.equal(actor.age, -1); assert.equal(actor.pickupDelay, -1);
    assert.equal(actor.noGravity, false); assert.equal(actor.grounded, true); assert.equal(actor.health, legacy ? 0 : 5);
    source.value.Pos = list(5, [-20.5, 100, 3.5]); actor = planSourceWorldItems([source], { registry }).snapshot.items[0];
    assert.deepEqual(actor.position, legacy ? [0, 0, 0] : [-20.5, 100, 3.5]);
    source.value.Pos = list(6, [7]); actor = planSourceWorldItems([source], { registry }).snapshot.items[0];
    assert.deepEqual(actor.position, legacy ? [7, 0, 0] : [0, 0, 0]);
    source.value.Pos = tag(11, new Int32Array([1, 2, 3, 4])); actor = planSourceWorldItems([source], { registry }).snapshot.items[0];
    assert.deepEqual(actor.position, legacy ? [0, 0, 0] : [1, 2, 3]);
    source.value.Pos = list(6, [NaN, 1, 2]); plan = planSourceWorldItems([source], { registry });
    assert.equal(plan.snapshot.items.length, 0); assert.deepEqual(plan.snapshot.deferred[0].source, source);
    source.value.Pos = list(6, [0, 1, 0]); source.value.UUID = tag(11, new Int32Array([0, 0, 0, 1]));
    plan = planSourceWorldItems([source, source], { registry });
    assert.equal(plan.snapshot.items.length, 1); assert.equal(plan.snapshot.deferred.length, 1); assert.deepEqual(plan.snapshot.deferred[0].source, source);
  }
});

test('saved player identity and initialization marker are validated and no-space pickup predicate avoids transport', async () => {
  const registry = registries['1.21.11'], snapshot = seed(registry); snapshot.playerUuid = playerUuid; snapshot.initialized = true;
  assert.equal(validateWorldItemsSnapshot(snapshot, registry).playerUuid, playerUuid);
  snapshot.initialized = 'yes'; assert.throws(() => validateWorldItemsSnapshot(snapshot, registry), /initialization/);
  snapshot.initialized = true; snapshot.playerUuid = 'bad'; assert.throws(() => validateWorldItemsSnapshot(snapshot, registry), /player identity/);
  snapshot.playerUuid = playerUuid; let called = 0;
  const items = new LocalWorldItems({ registry, snapshot, sample: floor(), pickup: () => { called++; throw new Error('unexpected pickup'); } });
  assert.equal(await items.pickupNearby({ uuid: playerUuid, bounds: [0, 1, 0, 1, 3, 1], shouldPickup: () => false }), 0); assert.equal(called, 0);
});

test('extreme valid actor centers survive ticks and production callback bounds reject corrupt geometry', () => {
  const registry = registries['1.21.11'];
  for (const x of [-2147483645.5, 2147483644.5]) {
    const items = new LocalWorldItems({ registry, snapshot: seed(registry, 1, { position: [x, 1, .5] }), sample: floor() });
    for (let tick = 0; tick < 8; tick++) items.step(); assert.equal(items.state.items.length, 1); assert.equal(items.state.items[0].position[0], x);
    assert.doesNotThrow(() => items.snapshot());
  }
  for (const sample of [() => undefined, () => ({ flags: NaN }), () => ({ ...solid, material: { collisionBoxes: [[0, 0, 0, NaN, 1, 1]] } }),
    () => ({ ...air, fluid: { kind: 'water', height: 2 } })]) {
    const items = new LocalWorldItems({ registry, snapshot: seed(registry), sample }); assert.throws(() => items.step(), /sample|flags|collision|fluid/);
  }
  const items = new LocalWorldItems({ registry, snapshot: seed(registry), sample: floor(), collisionBoxes: () => Array(4097).fill([0, 0, 0, 1, 1, 1]) });
  assert.throws(() => items.step(), /oversized/);
});

test('cached source contexts exactly match uncached ordered physics across edits, fluids and column unloads', () => {
  const registry = registries['1.21.11'], snapshot = createWorldItemsSnapshot(registry), prototype = seed(registry).items[0];
  snapshot.nextId = 25; snapshot.items = Array.from({ length: 24 }, (_, index) => ({ ...structuredClone(prototype), id: index + 1,
    uuid: `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, '0')}`, position: [index + .5, 1 + index % 3, .5],
    velocity: [index % 2 ? .03 : -.02, 0, index % 3 * .01], pickupDelay: index % 4, stack: stack(registry, index % 5 + 1) }));
  let revision = 0, waterFlow = 1, removedFloor = false, unloaded = false;
  const sample = (x, y) => y === 0 && !removedFloor ? solid : y === 1 && x >= 0 && x < 4
    ? { ...air, fluid: { kind: 'water', height: 8 / 9, flow: [waterFlow, 0, 0] } } : air;
  const loaded = cx => !unloaded || cx !== 1, collisionBoxes = () => [[8, 0, -.5, 8.25, 4, 1.5]];
  const cached = new LocalWorldItems({ registry, snapshot, sample, loaded, collisionBoxes, collisionRevision: () => revision });
  const uncached = new LocalWorldItems({ registry, snapshot, sample, loaded, collisionBoxes });
  for (let tick = 0; tick < 100; tick++) {
    if (tick === 20) { waterFlow = -1; revision++; }
    if (tick === 35) { unloaded = true; revision++; }
    if (tick === 60) { removedFloor = true; unloaded = false; revision++; }
    cached.step(); uncached.step(); assert.deepEqual(cached.state, uncached.state);
  }
  assert.ok(cached.stats().sampleReads < uncached.stats().sampleReads);
});

test('native item visual updates retain stable metadata until authoritative stack content changes', () => {
  const registry = registries['1.21.11'], events = [], items = new LocalWorldItems({ registry, snapshot: seed(registry, 10), sample: floor(), onEvent: event => events.push(event) });
  assert.equal(events[0].type, 'spawn'); assert.equal(events[0].entity.metadata[0].value.itemCount, 10);
  items.step(); assert.equal(events[1].type, 'update'); assert.equal(events[1].entity.metadata, undefined);
  const actor = items.state.items[0], snapshot = consumeWorldItem(items.snapshot(), { actorId: actor.id, actorRevision: actor.revision, count: 3, playerUuid }, registry);
  items.accept(snapshot); assert.equal(events.at(-1).entity.metadata[0].value.itemCount, 7);
  assert.equal(events[0].entity.metadata[0].value.itemCount, 10, 'render events do not share mutable authority stack objects');
});

test('modern native UUID codec admits numeric lists and overlong partial arrays while legacy requires four ints', () => {
  const tag = (type, value) => ({ type, value }), list = values => tag(9, { elementType: 3, entries: values.map(value => tag(3, value)) });
  assert.equal(nativeSourceUuid(list([0, 0, 0, 1]), '1.21.11'), playerUuid);
  assert.equal(nativeSourceUuid(list([0, 0, 0, 1]), '1.20.4'), null);
  assert.equal(nativeSourceUuid(tag(11, new Int32Array([0, 0, 0, 1, 2])), '1.21.11'), playerUuid);
  assert.equal(nativeSourceUuid(tag(11, new Int32Array([0, 0, 0, 1, 2])), '1.20.4'), null);
  assert.equal(nativeSourceUuid(list([0, 0, 1]), '1.21.11'), null);
  const fractional = tag(9, { elementType: 5, entries: [-.2, 0, 0, 1].map(value => tag(5, value)) });
  assert.equal(nativeSourceUuid(fractional, '1.21.11'), playerUuid);
});
