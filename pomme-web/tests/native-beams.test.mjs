import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NATIVE_BEAM, BEAM_FULLBRIGHT, nativeSin, nativeBeamTime, nativeBeamProfile, nativeBeamTexture, nativeBeamQuads, nativeBeamColorMix, nativeGatewayExtent } from '../src/native-beams.js';
import { partitionActorLayers } from '../src/actor-layers.js';

test('native beam time retains signed-long floorMod and float partial ticks', () => {
  assert.equal(nativeBeamTime(-1n, .5), 39.5); assert.equal(nativeBeamTime(-1, .5), 39.5);
  assert.equal(nativeBeamTime(-9223372036854775808n, .25), 32.25);
  assert.equal(nativeBeamTime(9223372036854775807n, .75), 7.75);
  assert.equal(nativeBeamTime(40n, .1), Math.fround(.1));
});

test('native Mth sine lookup uses float multiplication, signed integer truncation and Java narrowing saturation', () => {
  assert.equal(nativeSin(0), 0); assert.equal(nativeSin(Math.fround(Math.PI / 2)), 1);
  const expected = Math.fround(Math.sin(1043 * Math.PI * 2 / 65536)); assert.equal(nativeSin(.1), expected); assert.equal(nativeSin(-.1), -expected);
  const saturated = Math.fround(Math.sin(65535 * Math.PI * 2 / 65536));
  for (const value of [2_000_000_000, Infinity]) assert.equal(nativeSin(value), saturated);
  for (const value of [-2_000_000_000, -Infinity, NaN]) assert.equal(nativeSin(value), 0);
});

test('modern Mth sine widens the float argument to double and narrows its index to a signed long', () => {
  const age = Math.fround(Math.fround(932.25) * Math.fround(.1));
  assert.equal(nativeSin(age), Math.fround(Math.sin(54867 * Math.PI * 2 / 65536)));
  assert.equal(nativeSin(age, true), Math.fround(Math.sin(54868 / 10430.378350470453)));
  const value = Math.fround(2_000_000_000), index = Math.trunc(value * 10430.378350470453) & 65535;
  assert.equal(nativeSin(value, true), Math.fround(Math.sin(index / 10430.378350470453)));
  assert.notEqual(nativeSin(value, true), nativeSin(value));
  for (let index = 0; index < 65536; index++) assert.equal(Math.fround(Math.sin(index * Math.PI * 2 / 65536)), Math.fround(Math.sin(index / 10430.378350470453)));
  assert.equal(nativeSin(Infinity, true), Math.fround(Math.sin(65535 / 10430.378350470453)));
  for (const value of [-Infinity, NaN]) assert.equal(nativeSin(value, true), 0);
});

test('modern beacon height, packed alpha, distant radius and scoping match the original source changes', () => {
  assert.deepEqual(nativeBeamProfile('1.20.4', 192), { modern: false, finalHeight: 1024, outerAlpha: .125, radiusScale: 1 });
  assert.deepEqual(nativeBeamProfile({ minecraftVersion: '1.21.11' }, 192), { modern: true, finalHeight: 2048, outerAlpha: 32 / 255, radiusScale: 2 });
  assert.deepEqual(nativeBeamProfile({ minecraftVersion: '26.1' }, 192), nativeBeamProfile('1.21.11', 192));
  assert.equal(nativeBeamProfile('1.21.11', 192, true).radiusScale, 1); assert.equal(nativeBeamProfile('1.21.11', 48).radiusScale, 1);
});

test('original renderer texture identifiers preserve legacy names and the source 26.1 directory changes', () => {
  for (const version of ['1.20.4', '1.21.11']) {
    assert.equal(nativeBeamTexture(version), 'minecraft:entity/beacon_beam');
    assert.equal(nativeBeamTexture(version, true), 'minecraft:entity/end_gateway_beam');
  }
  assert.equal(nativeBeamTexture({ minecraftVersion: '26.1' }), 'minecraft:entity/beacon/beacon_beam');
  assert.equal(nativeBeamTexture('26.1', true), 'minecraft:entity/end_portal/end_gateway_beam');
});

test('modern stained-glass beam colors use integer ARGB averages while legacy colors retain float averages', () => {
  const red = [176, 46, 38].map(value => value / 255), magenta = [199, 78, 189].map(value => value / 255);
  assert.deepEqual(nativeBeamColorMix(red, magenta, true), [187, 62, 113].map(value => value / 255));
  const legacy = nativeBeamColorMix(red, magenta); assert.ok(legacy[0] > 187 / 255 && legacy[2] > 113 / 255); assert.ok(legacy.every(value => Math.fround(value) === value));
});

test('native beam quads retain source vertex order, up normal and both UV directions', () => {
  const quads = nativeBeamQuads({ height: 10, animationTime: 20 }); assert.equal(quads.length, 8);
  assert.deepEqual(quads[0].positions, [[.5, 10, .7], [.5, 0, .7], [.7, 0, .5], [.7, 10, .5]]);
  assert.deepEqual(quads[0].uv, [[1, 24], [1, -1], [0, -1], [0, 24]]);
  assert.deepEqual(quads[4].positions, [[.25, 10, .25], [.25, 0, .25], [.75, 0, .25], [.75, 10, .25]]);
  assert.deepEqual(quads[4].uv, [[1, 9], [1, -1], [0, -1], [0, 9]]);
  for (const quad of quads) {
    assert.deepEqual(quad.normal, [0, 1, 0]); assert.equal(quad.alpha, quad.outer ? .125 : 1);
    const [a, b, c] = quad.positions, ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], 0, ab[0] * ac[1] - ab[1] * ac[0]], dot = cross[0] * ((a[0] + b[0] + c[0]) / 3 - .5) + cross[2] * ((a[2] + b[2] + c[2]) / 3 - .5);
    assert.ok(quad.outer ? dot < 0 : dot > 0);
  }
});

test('source signed-height beam scroll changes direction and UV repetition follows intensity/radius', () => {
  const positive = nativeBeamQuads({ bottom: -10, height: 20, animationTime: 10.5, intensity: .5, innerRadius: .15, outerRadius: .175 }), negative = nativeBeamQuads({ bottom: 10, height: -20, animationTime: 10.5 });
  assert.equal(positive[0].positions[0][1], 10); assert.equal(negative[0].positions[0][1], -10);
  assert.notEqual(positive[0].uv[1][1], negative[0].uv[1][1]);
  assert.ok(Math.abs(positive[0].uv[0][1] - positive[0].uv[1][1] - 10 / .3) < 1e-5); assert.ok(Math.abs(positive[4].uv[0][1] - positive[4].uv[1][1] - 10) < 1e-6);
});

test('gateway spawn/cooldown uses native sine, inclusive modern maximum Y and signed-int beam endpoints', () => {
  const legacy = nativeGatewayExtent({ age: 100n, maxY: 320 }), modern = nativeGatewayExtent({ age: 100n, maxY: 320, modern: true });
  assert.deepEqual(legacy, { spawning: true, intensity: 1, extent: 320, bottom: -320, height: 640 }); assert.equal(modern.extent, 319);
  const cooling = nativeGatewayExtent({ age: 1000n, cooldown: 30 }); assert.equal(cooling.extent, 35); assert.equal(cooling.height, 70);
  const extreme = nativeGatewayExtent({ age: 100n, maxY: 2_000_000_000 }); assert.equal(extreme.height, -294967296); assert.equal((extreme.bottom + extreme.height) | 0, 2_000_000_000);
});

test('beam marker, alpha/depth routing and all native light pairs stay Float32-exact without actor-layer collisions', () => {
  for (let sky = 0; sky < 16; sky++) for (let block = 0; block < 16; block++) for (const outer of [false, true]) for (const reactive of [0, 2097152, 10485760]) {
    const flags = NATIVE_BEAM | BEAM_FULLBRIGHT | (outer ? 64 : 0) | 512 | (sky << 10) | (block << 14) | reactive;
    assert.equal(flags % 64, 0); assert.equal(Math.fround(flags), flags); assert.equal(flags & 63, 0);
    const vertices = new Float32Array(42); vertices[13] = vertices[27] = vertices[41] = flags;
    const layers = partitionActorLayers(vertices); assert.equal(layers.base.length, 42); for (const [name, value] of Object.entries(layers)) if (name !== 'base') assert.equal(value.length, 0);
  }
});
