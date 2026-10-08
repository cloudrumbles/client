import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentRuntime, createFogBlockSampler } from '../src/environment-runtime.js';
import { EnvironmentSources } from '../src/environment-sources.js';
const materials = new Map([[0, { name: 'air', flags: 0 }], [1, { name: 'water', fluid: { kind: 1, level: 0 }, flags: 4 }], [2, { name: 'lava', fluid: { kind: 2, level: 0 }, flags: 4 }], [3, { name: 'powder_snow', flags: 0 }]]);
function fixture(version = '1.21.11') {
  let state = 1, stacked = false;
  const core = { block_get: (_x, y) => y === 65 && !stacked ? 0 : state, world_min_y: () => -64, block_flags: id => materials.get(id).flags };
  const world = { core, columns: new Map(), biomeSeed: 0n, minY: -64, height: 384, materialRegistry: { materials } }, registry = { biomes: [{ id: 0, name: 'plains' }], blocks: [] };
  const player = { position: [0, 62.5, 0], eye: [0, 64.1, 0], direction: [0, 0, -1], yaw: 0, pitch: 0, effects: new Map(), eyesInWater: true };
  const runtime = new EnvironmentRuntime({ version }); runtime.configure({ world, registry });
  return { runtime, player, core, world, registry, setState(value) { state = value; }, setStacked(value) { stacked = value; } };
}
test('production fluid sampler uses exact contained levels and full above-fluid height at extreme coordinates', () => {
  const value = fixture(), sample = createFogBlockSampler({ core: value.core, materials, registry: value.registry });
  assert.equal(sample(-2000000000, 64, 2000000000).fluid.height, 8 / 9); value.setStacked(true); assert.equal(sample(-2000000000, 64, 2000000000).fluid.height, 1);
  value.setState(2); assert.equal(sample(0, 64, 0).fluid.kind, 'lava'); value.setState(3); assert.equal(sample(0, 64, 0).name, 'powder_snow');
});
test('runtime native ticks adapt water vision, preserve it through source reconfiguration, and reset on new player', () => {
  const { runtime, player, world, registry } = fixture(); for (let i = 0; i < 100; i++) runtime.tick(player, { dayTime: BigInt(i) });
  assert.equal(runtime.sample(player).waterVision, Math.fround(.6));
  runtime.configure({ world, registry }); assert.equal(runtime.sample(player).waterVision, Math.fround(.6));
  player.eyesInWater = false; runtime.tick(player); assert.equal(runtime.stats().waterVisionTime, 90);
  runtime.reset(); assert.equal(runtime.stats().waterVisionTime, 0);
});
test('runtime uses original effect metadata, presence priorities and versioned lava limits', () => {
  const { runtime, player, setState } = fixture('1.20.4'); setState(3); player.eyesInWater = false;
  player.effects.set('night_vision', { duration: -1, amplifier: 0 }); let fog = runtime.sample(player); assert.ok(Math.abs(Math.max(...fog.color) - 1) < 1e-7);
  player.effects.set('darkness', { duration: 100, amplifier: 0 }); runtime.syncEffects(player, [{ name: 'darkness', factorData: null }]); fog = runtime.sample(player); assert.ok(Math.max(...fog.color) < 1); assert.equal(runtime.stats().darkness, null);
  setState(2); player.effects.set('fire_resistance', { duration: 100, amplifier: 0 }); assert.equal(runtime.sample(player).end, 3);
});
test('runtime source registry timelines override JAR definitions and retain native full longs', () => {
  const { runtime, player, world, registry } = fixture(), sources = new EnvironmentSources();
  sources.ingest('data/example/dimension_type/world.json', { attributes: {}, timelines: ['example:day'] });
  sources.ingest('data/example/timeline/day.json', { tracks: { 'minecraft:visual/water_fog_end_distance': { keyframes: [{ ticks: 0, value: 10 }] } } });
  const registries = new Map([['minecraft:timeline', [{ key: 'example:day', value: { period_ticks: 10, tracks: { 'minecraft:visual/water_fog_end_distance': { keyframes: [{ ticks: 0, value: 20 }, { ticks: 8, value: 100 }] } } } }]]]);
  runtime.configure({ world, registry, atlas: { environmentSources: sources }, dimensionId: 'example:world', registries });
  runtime.tick(player, { dayTime: 7000000000000000004n }); assert.equal(runtime.stats().attributes, null); runtime.sample(player, { partialTick: 1 }); assert.equal(runtime.stats().attributes.waterFogEnd, 60);
});
test('26.1 admits original modern attributes and darkness blending without aborting its render sample', () => {
  const { runtime, player } = fixture('26.1');
  player.effects.set('darkness', { duration: 100, amplifier: 0 });
  const source = { name: 'darkness', duration: 100, shouldBlend: false };
  runtime.syncEffects(player, [source]); assert.equal(runtime.stats().darkness.factor, 1);
  const fog = runtime.sample(player); assert.equal(fog.type, 'water'); assert.equal(fog.end, 15);
  runtime.tick(player, { sourceEffects: [{ ...source, duration: 99 }] });
  assert.equal(runtime.stats().darkness.factor, 1); assert.equal(runtime.stats().attributes.resolved, true);
});
test('air blindness and native darkness presence admit source atmospheric color with independent water timing', () => {
  const { runtime, player, setState, world, registry } = fixture('1.21.11'); setState(0); player.eyesInWater = false;
  const sources = new EnvironmentSources(); sources.ingest('data/example/dimension_type/air.json', { attributes: { 'minecraft:visual/fog_color': '#406080', 'minecraft:visual/sky_color': '#90a0b0' } });
  runtime.configure({ world, registry, atlas: { environmentSources: sources }, dimensionId: 'example:air' });
  player.effects.set('blindness', { duration: -1, amplifier: 0 }); runtime.tick(player); let fog = runtime.sample(player); assert.equal(fog.type, 'none'); assert.equal(fog.end, 5); assert.deepEqual(fog.color, [0, 0, 0]);
  player.effects.delete('blindness'); player.effects.set('darkness', { duration: 22, amplifier: 0 }); runtime.syncEffects(player, [{ name: 'darkness', shouldBlend: false }]);
  fog = runtime.sample(player); assert.equal(fog.end, 128); assert.equal(fog.start, 96); assert.ok(fog.color.every(value => value > 0));
  player.effects.set('night_vision', { duration: -1, amplifier: 0 }); assert.deepEqual(runtime.sample(player).color, fog.color, 'Native darkness presence suppresses night vision even before the factor rises.');
  player.effects.delete('darkness'); assert.equal(runtime.sample(player), null);
});
test('native client zero-duration fog effects retain map presence and darkness decay until removal', () => {
  const { runtime, player, setState, world, registry } = fixture('1.21.11'); setState(0); player.eyesInWater = false;
  const sources = new EnvironmentSources(); sources.ingest('data/example/dimension_type/air.json', { attributes: { 'minecraft:visual/fog_color': '#406080', 'minecraft:visual/sky_color': '#90a0b0' } });
  runtime.configure({ world, registry, atlas: { environmentSources: sources }, dimensionId: 'example:air' });
  player.effects.set('blindness', { duration: 0, amplifier: 0 }); runtime.tick(player); assert.equal(runtime.sample(player).end, 128);
  player.effects.delete('blindness'); player.effects.set('darkness', { duration: -1, amplifier: 0 });
  const source = { name: 'darkness', shouldBlend: true };
  for (let i = 0; i < 25; i++) runtime.tick(player, { sourceEffects: [source] });
  assert.equal(runtime.stats().darkness.factor, 1);
  player.effects.get('darkness').duration = 0; runtime.tick(player, { sourceEffects: [source] });
  assert.ok(runtime.stats().darkness.factor < 1 && runtime.stats().darkness.factor > 0);
  const color = runtime.sample(player, { partialTick: 1 }).color;
  player.effects.set('night_vision', { duration: 0, amplifier: 0 }); assert.deepEqual(runtime.sample(player, { partialTick: 1 }).color, color);
  player.effects.delete('darkness'); assert.equal(runtime.sample(player), null);
});
