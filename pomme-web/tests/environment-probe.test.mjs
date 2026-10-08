import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeFogAttributeProbe, WATER_FOG_ATTRIBUTES as A, createFogBiomeLookup, nativeFogColorLerp, applyWaterFogModifier, ENVIRONMENT_PROBE_LIMITS } from '../src/environment-probe.js';
import { compileEnvironmentEase, ENVIRONMENT_EASINGS } from '../src/environment-easing.js';
import { EnvironmentFog } from '../src/environment-fog.js';
const biome = (name, attributes) => ({ name: `minecraft:${name}`, definition: { attributes } });
const probe = (options = {}) => new NativeFogAttributeProbe({ version: '1.21.11', getNoiseBiome: () => biome('plains', {}), ...options });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);

test('loaded native quart biomes clamp custom Y and preserve negative columns and dynamic native IDs', () => {
  const cells = new Uint32Array(64).fill(2); cells[0] = 1;
  const world = { minY: 40000, height: 16, columns: new Map([['-1,-1', { sections: [{ sectionY: 2500, biomes: cells }] }]]) };
  const registry = { biomes: [{ id: 1, name: 'swamp' }, { id: 2, name: 'plains' }] }, definitions = new Map([['minecraft:swamp', { effects: { water_fog_color: 123 } }]]), registries = new Map();
  const lookup = createFogBiomeLookup({ world, registry, definitions, registries });
  assert.equal(lookup(-4, 10000, -4).name, 'minecraft:swamp');
  assert.equal(lookup(-4, -500000000, -4).definition.effects.water_fog_color, 123);
  assert.equal(lookup(-4, 500000000, -4).name, 'minecraft:plains');
  assert.equal(lookup(4, 10000, 4).name, 'minecraft:plains');
  const remote = { effects: { water_fog_color: 456 } };
  registries.set('minecraft:worldgen/biome', [{ id: 1, key: 'minecraft:river', value: remote }, { id: 2, key: 'minecraft:swamp', value: { attributes: {} } }, { id: 3, key: 'minecraft:plains', value: { attributes: {} } }]);
  assert.equal(lookup(-4, 10000, -4).name, 'minecraft:river'); assert.equal(lookup(-4, 10000, -4).definition, remote);
  assert.equal(lookup(4, 10000, 4).id, 3);
  registries.set('minecraft:worldgen/biome', [{ id: 1, key: 'minecraft:ocean', value: remote }]); assert.equal(lookup(-4, 10000, -4).name, 'minecraft:ocean');
  assert.equal(lookup(-3, 10000, -4).name, null); // Missing remote ID2 cannot alias static plains.
  assert.equal(lookup(4, 10000, 4).name, null); // Missing native plains leaves the source unresolved.
  registries.set('minecraft:worldgen/biome', [{ name: 'minecraft:ocean', element: remote }, { name: 'minecraft:plains', element: { attributes: {} } }]);
  assert.equal(lookup(4, 10000, 4).id, 1); // Codec entries may supply IDs by ordered index.
  registries.set('minecraft:worldgen/biome', [{ id: 1 }, { id: 1 }]); assert.throws(() => lookup(0, 0, 0), /duplicated/);
  registries.set('minecraft:worldgen/biome', [{ id: -1 }]); assert.throws(() => lookup(0, 0, 0), /invalid/);
  registries.set('minecraft:worldgen/biome', Array.from({ length: 4097 }, (_, id) => ({ id }))); assert.throws(() => lookup(0, 0, 0), /bound/);
});

test('legacy camera fog uses the seeded BiomeManager selection and original special effects', () => {
  const calls = [], original = { effects: { water_fog_color: 0x123456 } };
  const legacy = new NativeFogAttributeProbe({ version: '1.20.4', seed: 0n, getNoiseBiome: (...quart) => { calls.push(quart); return { name: 'minecraft:swamp', definition: original }; } });
  legacy.tick({ position: [0, 0, 0] }); assert.deepEqual(legacy.sample(), { waterFogColor: 0x123456, waterFogStart: -8, waterFogEnd: 96, closerWaterFog: true, resolved: true, diagnostics: [] });
  assert.deepEqual(calls, [[-1, -1, -1]]);
  const tagged = new NativeFogAttributeProbe({ version: '1.20.4', getNoiseBiome: () => ({ name: 'minecraft:swamp' }), closerWaterFog: () => false });
  tagged.tick({ position: [0, 64, 0] }); assert.equal(tagged.sample().closerWaterFog, false); assert.equal(tagged.sample().waterFogColor, 0x232317);
  const split = new NativeFogAttributeProbe({ version: '1.20.4', getNoiseBiome: (_x, y) => ({ name: y < 0 ? 'minecraft:swamp' : 'minecraft:plains', definition: { effects: { water_fog_color: y < 0 ? 0x232317 : 0x050533 } } }) });
  split.tick({ position: [0, 8, 0], playerPosition: [0, 0, 0] });
  assert.equal(split.sample().waterFogColor, 0x050533); assert.equal(split.sample().closerWaterFog, true);
});

test('modern Gaussian samples216 source cells and mixes map weights before applying timeline layers', () => {
  const dark = biome('plains', { [A.color]: '#000000', [A.start]: -8, [A.end]: 48 }), bright = biome('river', { [A.color]: '#ffffff', [A.start]: 8, [A.end]: 96 }), calls = [];
  const p = probe({ getNoiseBiome: (x, y, z) => { calls.push([x, y, z]); return x < 0 ? dark : bright; } });
  p.tick({ position: [0, 0, 0] }); const value = p.sample();
  assert.equal(calls.length, 216); assert.deepEqual(calls[0], [-3, -3, -3]); assert.deepEqual(calls.at(-1), [2, 2, 2]);
  assert.equal(value.waterFogColor, 0x7f7f7f); assert.equal(value.waterFogStart, 0); assert.equal(value.waterFogEnd, 72);
  assert.equal([...p.weights.values()].reduce((sum, value) => sum + value, 0), 4096);
  assert.equal(p.weights.size, 2); assert.equal(value.resolved, true);
});

test('modern native dimension→biome→timeline modifier order and final nonnegative clamp are preserved', () => {
  const p = probe({ dimensionAttributes: { [A.end]: 200 }, getNoiseBiome: () => biome('swamp', { [A.end]: { modifier: 'multiply', argument: .5 } }),
    timelines: [{ tracks: { [A.end]: { modifier: 'add', keyframes: [{ ticks: 0, value: 20 }] } } }] });
  p.tick({ position: [0, 64, 0], dayTime: 123n }); assert.equal(p.sample().waterFogEnd, 120);
  const negative = probe({ dimensionAttributes: { [A.end]: -500 } }); negative.tick({ position: [0, 0, 0] }); assert.equal(negative.sample().waterFogEnd, 0);
  const fog = new EnvironmentFog({ version: '1.21.11' }); assert.equal(fog.sample({ type: 'water', ...p.sample() }).end, 30);
});

test('modern probe lazily interpolates queried values and drops probes after unqueried ticks', () => {
  const left = biome('plains', { [A.color]: '#000000', [A.end]: 20 }), right = biome('river', { [A.color]: '#ffffff', [A.end]: 100 }); let source = left;
  const p = probe({ getNoiseBiome: () => source }); p.tick({ position: [0, 0, 0] }); assert.equal(p.sample(.5).waterFogEnd, 20);
  source = right; p.tick({ position: [0, 0, 0], dayTime: 1n }); assert.equal(p.sample(0).waterFogEnd, 20); assert.equal(p.sample(.5).waterFogEnd, 60); assert.equal(p.sample(.5).waterFogColor, 0x7f7f7f); assert.equal(p.sample(1).waterFogEnd, 100);
  p.tick({ position: [0, 0, 0], dayTime: 2n }); p.tick({ position: [0, 0, 0], dayTime: 3n }); source = left; p.tick({ position: [0, 0, 0], dayTime: 4n });
  assert.equal(p.sample(.5).waterFogEnd, 20); p.reset(); assert.throws(() => p.sample(), /Tick/); assert.equal(p.probes.size, 0);
});

test('native timeline wrap, sourceLong precision, duplicate ticks, constant easing and alpha arguments survive', () => {
  const timeline = { period_ticks: 10, tracks: { [A.end]: { keyframes: [{ ticks: 2, value: 20 }, { ticks: 6, value: 60 }] } } };
  for (const [dayTime, expected] of [[-1n, 40], [2n, 20], [4n, 40], [6n, 60], [10n, Math.fround(100 / 3)]]) {
    const p = probe({ timelines: [timeline] }); p.tick({ position: [0, 0, 0], dayTime }); close(p.sample(1).waterFogEnd, expected);
  }
  const p = probe({ timelines: [{ tracks: { [A.end]: { ease: 'constant', keyframes: [{ ticks: 0, value: 3 }, { ticks: 10, value: 7 }] } } }] });
  p.tick({ position: [0, 0, 0], dayTime: 9n }); assert.equal(p.sample().waterFogEnd, 3); p.tick({ position: [0, 0, 0], dayTime: 9223372036854775807n }); assert.equal(p.sample(1).waterFogEnd, 7);
  const duplicate = probe({ timelines: [{ tracks: { [A.end]: { keyframes: [{ ticks: 0, value: 10 }, { ticks: 0, value: 20 }, { ticks: 0, value: 30 }, { ticks: 1, value: 40 }] } } }] });
  duplicate.tick({ position: [0, 0, 0] }); assert.equal(duplicate.sample().waterFogEnd, 30);
  assert.equal(applyWaterFogModifier('float', 96, { modifier: 'alpha_blend', argument: 100 }), 100);
  assert.equal(applyWaterFogModifier('float', 96, { modifier: 'alpha_blend', argument: { value: 100 } }), 100);
  assert.equal(applyWaterFogModifier('float', 96, { modifier: 'alpha_blend', argument: { value: 100, alpha: .25 } }), 97);
});

test('all native RGB/float modifier families preserve byte saturation, alpha and float rounding', () => {
  assert.equal(nativeFogColorLerp(.5, 0xffffffff, 0xff000000), 0xff7f7f7f);
  assert.equal(applyWaterFogModifier('color', '#fa8020', { modifier: 'add', argument: '#10a020' }), 0xffff_ff40);
  assert.equal(applyWaterFogModifier('color', '#fa8020', { modifier: 'subtract', argument: '#ffff40' }), 0xff000000);
  assert.equal(applyWaterFogModifier('color', '#ff8040', { modifier: 'multiply', argument: '#8080ff' }), 0xff804040);
  assert.equal(applyWaterFogModifier('color', '#ff0000', { modifier: 'alpha_blend', argument: '#800000ff' }), 0xff7f0080);
  assert.equal(applyWaterFogModifier('color', '#ff0000', { modifier: 'alpha_blend', argument: '#000000ff' }), 0xffff0000);
  assert.equal(applyWaterFogModifier('color', '#ffffff', { modifier: 'blend_to_gray', argument: { factor: 1, brightness: .5 } }), 0xff7f7f7f);
  assert.equal(applyWaterFogModifier('float', 96, { modifier: 'multiply', argument: .85 }), Math.fround(Math.fround(.85) * 96));
  assert.equal(applyWaterFogModifier('float', 96, { modifier: 'minimum', argument: 70 }), 70); assert.equal(applyWaterFogModifier('float', 96, { modifier: 'maximum', argument: 120 }), 120);
  assert.throws(() => applyWaterFogModifier('float', 96, { argument: 100 }), /fields/); assert.throws(() => applyWaterFogModifier('color', 0, { modifier: 'maximum', argument: 100 }), /Unsupported/);
});

test('vanilla fallback facts distinguish modern cherry/pale water fog and swamp distance without legacy color clock', () => {
  for (const [name, value] of [['mangrove_swamp', 0x4d7a60], ['cherry_grove', 0x5db7ef], ['pale_garden', 0x556980], ['warm_ocean', 0x041f33]]) {
    const p = probe({ getNoiseBiome: () => ({ name: `minecraft:${name}` }) }); p.tick({ position: [0, 64, 0] }); assert.equal(p.sample().waterFogColor, value); assert.equal(p.sample().resolved, true);
  }
  const p = probe({ getNoiseBiome: () => ({ name: 'minecraft:swamp' }) }); p.tick({ position: [0, 64, 0] }); close(p.sample().waterFogEnd, Math.fround(96 * Math.fround(.85)));
});

test('missing custom source layers are explicit and native tags/tracks remain bounded', () => {
  const p = probe({ dimensionId: 'example:world', getNoiseBiome: () => ({ name: 'example:biome' }), timelines: ['example:missing'] });
  p.tick({ position: [0, 0, 0] }); assert.equal(p.sample().resolved, false); assert.equal(p.sample().diagnostics.length, 3);
  const vanilla = probe({ timelines: '#minecraft:in_overworld' }); vanilla.tick({ position: [0, 0, 0] }); assert.equal(vanilla.sample().resolved, true);
  assert.throws(() => probe({ timelines: ['#example:loop'], timelineTags: new Map([['example:loop', { values: ['#example:loop'] }]]) }), /cyclic/);
  assert.throws(() => probe({ timelines: Array(33).fill('minecraft:day') }), /bound/);
  assert.throws(() => probe({ timelines: [{ tracks: { [A.end]: { keyframes: Array.from({ length: 1025 }, (_, ticks) => ({ ticks, value: 1 })) } } }] }), /bound/);
  assert.throws(() => probe({ timelines: [{ tracks: { [A.end]: { keyframes: [{ ticks: 2, value: 1 }, { ticks: 1, value: 1 }] } } }] }), /order/);
  assert.throws(() => probe({ timelines: [{ period_ticks: 10, tracks: { [A.end]: { keyframes: [{ ticks: 11, value: 1 }] } } }] }), /range/);
  assert.throws(() => probe({ dimensionAttributes: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [i, 0])) }), /bound/);
  assert.deepEqual(ENVIRONMENT_PROBE_LIMITS, { biomes: 4096, timelines: 32, keyframesPerTrack: 1024, gaussianSamples: 216, diagnostics: 32 });
});

test('native easing golden values, table trigonometry and Bezier admission match original classes', () => {
  assert.equal(ENVIRONMENT_EASINGS.length, 32);
  for (const [name, value] of [['linear', .25], ['constant', 0], ['in_quad', .0625], ['out_quad', .4375], ['in_out_quad', .125], ['in_cubic', .015625], ['in_out_cubic', .0625]]) assert.equal(compileEnvironmentEase(name)(.25), value);
  assert.equal(compileEnvironmentEase('in_sine')(.5), Math.fround(0.2928932309150696));
  assert.equal(compileEnvironmentEase({ cubic_bezier: [0, 0, 1, 1] })(.5), .5);
  assert.throws(() => compileEnvironmentEase('unknown'), /Unsupported/); assert.throws(() => compileEnvironmentEase({ cubic_bezier: [-1, 0, 1, 1] }), /Invalid/);
});
test('26.1 timelines select their named independent world clocks and diagnose missing registry clocks', () => {
  const end = 'minecraft:visual/water_fog_end_distance';
  const probe = new NativeFogAttributeProbe({ version: '26.1', getNoiseBiome: () => ({ name: 'minecraft:plains' }), timelines: [{ clock: 'example:moon', period_ticks: 10, tracks: { [end]: { keyframes: [{ ticks: 0, value: 20 }, { ticks: 8, value: 100 }] } } }] });
  probe.tick({ position: [0, 64, 0], dayTime: 0n, clocks: new Map([['example:moon', 7000000000000000004n]]) });
  assert.equal(probe.sample().waterFogEnd, 60); assert.equal(probe.sample().resolved, true);
  probe.tick({ position: [0, 64, 0], clocks: new Map([['minecraft:overworld', 4n]]) });
  assert.equal(probe.sample(1).waterFogEnd, 96); assert.equal(probe.sample(1).resolved, false); assert.match(probe.sample(1).diagnostics[0], /world clock example:moon/);
});
test('native atmospheric attributes preserve sunrise alpha, source angle boundary and nonnegative distances', () => {
  const angle = 'minecraft:visual/sun_angle', sunrise = 'minecraft:visual/sunrise_sunset_color';
  const probe = new NativeFogAttributeProbe({ version: '1.21.11', getNoiseBiome: () => ({ name: 'minecraft:plains' }), dimensionAttributes: { 'minecraft:visual/fog_end_distance': -1 }, timelines: [{ tracks: { [angle]: { keyframes: [{ ticks: 0, value: 350 }, { ticks: 1, value: 10 }, { ticks: 2, value: 100 }] }, [sunrise]: { keyframes: [{ ticks: 0, value: '#00ff8040' }, { ticks: 1, value: '#80ff8040' }] } } }] });
  probe.tick({ position: [0, 64, 0], dayTime: 0n }); assert.equal(probe.sampleAtmosphere().sunriseSunsetColor >>> 24, 0); assert.equal(probe.sampleAtmosphere().fogEnd, 0);
  probe.tick({ position: [0, 64, 0], dayTime: 1n }); assert.equal(probe.sampleAtmosphere(.5).sunAngle, 360); assert.equal(probe.sampleAtmosphere(.5).sunriseSunsetColor >>> 24, 64);
  probe.tick({ position: [0, 64, 0], dayTime: 2n }); assert.equal(probe.sampleAtmosphere(.125).sunAngle, 100, 'Source angle changes of90degrees snap instead of interpolating.');
});
test('source color codecs preserve integer alpha and native RGB/ARGB vector channels', () => {
  const sunrise = 'minecraft:visual/sunrise_sunset_color', fog = 'minecraft:visual/fog_color';
  for (const [attributes, expected] of [
    [{ [sunrise]: [1, .5, .25, .5] }, 0x7fff7f3f],
    [{ [sunrise]: 0x123456 }, 0x00123456],
    [{ [sunrise]: { modifier: 'multiply', argument: [.5, .25, 1] } }, 0],
    [{ [fog]: [.5, .25, 1] }, 0xff7f3fff],
    [{ [fog]: 0x123456 }, 0x00123456],
  ]) {
    const p = probe({ dimensionAttributes: attributes }); p.tick({ position: [0, 64, 0] });
    assert.equal(attributes[sunrise] === undefined ? p.sampleAtmosphere().fogColor : p.sampleAtmosphere().sunriseSunsetColor, expected);
  }
  const p = probe({ dimensionAttributes: { [sunrise]: '#80ffffff' }, timelines: [{ tracks: { [sunrise]: { modifier: 'multiply', keyframes: [{ ticks: 0, value: [.5, .25, 1] }] } } }] });
  p.tick({ position: [0, 64, 0] }); assert.equal(p.sampleAtmosphere().sunriseSunsetColor, 0x807f3fff);
  const rejected = probe({ dimensionAttributes: { [sunrise]: { modifier: 'multiply', argument: '#ffffff' } } }); rejected.tick({ position: [0, 64, 0] }); assert.throws(() => rejected.sampleAtmosphere(), /codec/);
});
