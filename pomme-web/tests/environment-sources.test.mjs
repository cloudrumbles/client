import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentSources } from '../src/environment-sources.js';
import { NativeFogAttributeProbe } from '../src/environment-probe.js';
test('source dimensions/tracks replace while native tags append or explicitly replace', () => {
  const source = new EnvironmentSources(), dimension = { attributes: { 'minecraft:visual/water_fog_end_distance': 64 }, timelines: '#example:day' };
  source.ingest('data/example/dimension_type/world.json', dimension);
  source.ingest('data/example/timeline/day.json', { period_ticks: 10, tracks: {} });
  source.ingest('data/example/tags/timeline/day.json', { values: ['minecraft:day'] });
  source.ingest('data/example/tags/timeline/day.json', { values: ['example:day'] });
  assert.deepEqual(source.timelineTags.get('example:day').values, ['minecraft:day', 'example:day']);
  const p = new NativeFogAttributeProbe({ version: '1.21.11', dimensionId: 'example:world', dimensionAttributes: dimension.attributes, timelines: dimension.timelines,
    timelineDefinitions: source.timelines, timelineTags: source.timelineTags, getNoiseBiome: () => ({ name: 'minecraft:plains' }) });
  p.tick({ position: [0, 64, 0] }); assert.equal(p.sample().waterFogEnd, 64); assert.equal(p.sample().resolved, true);
  source.ingest('data/example/tags/timeline/day.json', { replace: true, values: ['minecraft:moon'] }); assert.deepEqual(source.timelineTags.get('example:day').values, ['minecraft:moon']);
});
test('native closer-water tag lookup retains nested and optional source entries', () => {
  const source = new EnvironmentSources();
  source.ingest('data/minecraft/tags/worldgen/biome/has_closer_water_fog.json', { values: ['#example:wet', { id: '#example:absent', required: false }] });
  source.ingest('data/example/tags/worldgen/biome/wet.json', { values: ['minecraft:swamp'] });
  assert.equal(source.biomeHasTag('has_closer_water_fog', 'minecraft:swamp'), true); assert.equal(source.biomeHasTag('has_closer_water_fog', 'minecraft:plains'), false);
  source.ingest('data/example/tags/worldgen/biome/wet.json', { values: ['#minecraft:has_closer_water_fog'] }); assert.throws(() => source.biomeHasTag('has_closer_water_fog', 'minecraft:plains'), /Cyclic/);
});
test('source environment definitions reject malformed tags and bounded structures before admission', () => {
  const source = new EnvironmentSources(); assert.equal(source.ingest('assets/minecraft/noise.json', {}), false);
  assert.throws(() => source.ingest('data/example/dimension_type/../world.json', {}), /Invalid/);
  assert.throws(() => source.ingest('data/example/tags/timeline/day.json', { values: Array(4097).fill('minecraft:day') }), /Invalid/);
  assert.throws(() => source.ingest('data/example/dimension_type/world.json', { value: Infinity }), /nonfinite/);
  let value = {}; for (let i = 0; i < 65; i++) value = { value }; assert.throws(() => source.ingest('data/example/dimension_type/world.json', value), /structural/);
});
test('shared acyclic biome tags resolve once and native object timeline entries retain required semantics', () => {
  const source = new EnvironmentSources();
  for (let i = 0; i < 30; i++) source.ingest(`data/example/tags/worldgen/biome/t${i}.json`, { values: i === 29 ? ['minecraft:desert'] : [`#example:t${i + 1}`, `#example:t${i + 1}`] });
  assert.equal(source.biomeHasTag('example:t0', 'minecraft:plains'), false); assert.equal(source.biomeHasTag('example:t0', 'minecraft:desert'), true);
  assert.equal(source.biomeMembership.size, 1);
  source.ingest('data/example/timeline/day.json', { tracks: { 'minecraft:visual/water_fog_end_distance': { keyframes: [{ ticks: 0, value: 20 }] } } });
  source.ingest('data/example/tags/timeline/day.json', { values: [{ id: 'example:day', required: true }, { id: 'example:missing', required: false }] });
  const p = new NativeFogAttributeProbe({ version: '1.21.11', timelines: '#example:day', timelineDefinitions: source.timelines, timelineTags: source.timelineTags, getNoiseBiome: () => ({ name: 'minecraft:plains' }) });
  p.tick({ position: [0, 64, 0] }); assert.equal(p.sample().waterFogEnd, 20); assert.equal(p.sample().resolved, true);
});
