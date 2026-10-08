import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeAtmosphericWeatherColor, nativeModernAtmosphericColor, nativeLegacyTimeOfDay, nativeLegacySunriseColor, nativeLegacyAtmosphericColor } from '../src/environment-atmosphere.js';
const f = Math.fround;
test('modern atmospheric source color keeps RGB byte weather operations before render-distance mixing', () => {
  assert.equal(nativeAtmosphericWeatherColor(0xff80c0ff), 0xff80c0ff);
  assert.equal(nativeAtmosphericWeatherColor(0xff80c0ff, 1, 1), 0xff20304c);
  const full = nativeModernAtmosphericColor({ fogColor: 0xff123456, skyColor: 0xffc0d0e0, renderDistanceChunks: 32, skyFogEnd: 512 });
  assert.deepEqual(full, [0x12, 0x34, 0x56].map(value => f(value / 255)));
  const short = nativeModernAtmosphericColor({ fogColor: 0xff123456, skyColor: 0xffc0d0e0, renderDistanceChunks: 4 }); assert.ok(short.every((value, axis) => value > full[axis]));
});
test('modern source sun direction and ARGB alpha control sunrise tint without atmospheric weather changing fog bytes', () => {
  const parameters = { fogColor: 0xff0000ff, skyColor: 0xff0000ff, sunriseSunsetColor: 0xffff0000, renderDistanceChunks: 32, skyFogEnd: 512 };
  assert.deepEqual(nativeModernAtmosphericColor({ ...parameters, sunAngle: 0, forward: [1, 0, 0] }), [1, 0, 0]);
  assert.deepEqual(nativeModernAtmosphericColor({ ...parameters, sunAngle: 0, forward: [-1, 0, 0] }), [0, 0, 1]);
  assert.deepEqual(nativeModernAtmosphericColor({ ...parameters, sunAngle: 90, forward: [-1, 0, 0] }), [1, 0, 0]);
  assert.deepEqual(nativeModernAtmosphericColor({ ...parameters, sunriseSunsetColor: 0x00ff0000, rain: 1, thunder: 1 }), [0, 0, 1]);
});
test('legacy native nonlinear day angle and source sunrise retain fixed dimension time and native float values', () => {
  assert.equal(nativeLegacyTimeOfDay(6000n), 0); assert.equal(nativeLegacyTimeOfDay(18000n), .5);
  assert.equal(nativeLegacyTimeOfDay(6000n, 18000n), .5);
  assert.equal(nativeLegacySunriseColor(0), null); assert.equal(nativeLegacySunriseColor(.25, 'minecraft:the_end'), null);
  const value = nativeLegacySunriseColor(.25); assert.equal(value.length, 4); assert.ok(value[3] > .99);
});
test('legacy native atmospheric color distinguishes original brightness-dependent dimension effects and source rain', () => {
  const input = { fogColor: [.2, .4, .6], skyColor: [.5, .6, .7], renderDistanceChunks: 32, timeOfDay: 0 };
  assert.deepEqual(nativeLegacyAtmosphericColor(input), input.fogColor.map(f));
  const end = nativeLegacyAtmosphericColor({ ...input, dimension: 'minecraft:the_end' }); assert.ok(end.every((value, axis) => Math.abs(value - f(input.fogColor[axis] * f(.15))) < 1e-7));
  const dark = nativeLegacyAtmosphericColor({ ...input, timeOfDay: .5 }); assert.ok(dark.every((value, axis) => value < input.fogColor[axis] / 10));
  const rain = nativeLegacyAtmosphericColor({ ...input, rain: 1 }); assert.ok(rain.every((value, axis) => value < input.fogColor[axis]));
});
