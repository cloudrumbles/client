import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentFog, nativeWaterVision, cameraFogType, cameraNearPlane, nativeFogFactor } from '../src/environment-fog.js';
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} differs from ${expected}`);

test('native water vision adapts over 100/600 ticks and decays ten ticks per dry tick', () => {
  for (const [ticks, vision] of [[0, 0], [1, 0.006], [50, 0.3], [100, 0.6], [350, 0.8], [600, 1]]) close(nativeWaterVision(ticks), vision);
  assert.equal(nativeWaterVision(600, false), 0);
  const fog = new EnvironmentFog(); fog.step({ eyesInWater: true }, 100); assert.equal(fog.waterVisionTime, 100);
  fog.step({}, 9); assert.equal(fog.waterVisionTime, 10); fog.step({}); assert.equal(fog.waterVisionTime, 0);
  fog.step({ eyesInWater: true, spectator: true }, 60); assert.equal(fog.waterVisionTime, 600);
  fog.reset(); assert.equal(fog.waterVisionTime, 0);
});

test('camera water surface is strict, lava is inclusive, and near-plane powder snow is visible', () => {
  const water = () => ({ fluid: { kind: 'water', height: 0.75 } });
  assert.equal(cameraFogType([0.5, 0.74, 0.5], water), 'water');
  assert.equal(cameraFogType([0.5, 0.75, 0.5], water), 'none');
  const lava = () => ({ fluid: { kind: 'lava', height: 0.75 } });
  assert.equal(cameraFogType([0.5, 0.75, 0.5], lava), 'lava');
  assert.equal(cameraFogType([0.5, 0.76, 0.5], lava), 'none');
  const offsets = cameraNearPlane({ forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], aspect: 2 });
  assert.equal(offsets.length, 5);
  assert.equal(cameraFogType([0.001, 0.5, 0.5], x => ({ name: x < 0 ? 'minecraft:powder_snow' : 'air' }), offsets), 'powder-snow');
  assert.equal(cameraFogType([0.001, 0.5, 0.5], x => ({ name: 'powder_snow', fluid: { kind: 'water', height: 0.75 } }), offsets), 'water');
});

test('camera fog preserves fractional surfaces at both extreme signed heights', () => {
  for (const y of [0, -2000000000, 2000000000]) {
    assert.equal(cameraFogType([0.5, y + 0.5, 0.5], () => ({ fluid: { kind: 'water', height: 0.75 } })), 'water');
    assert.equal(cameraFogType([0.5, y + 0.75, 0.5], () => ({ fluid: { kind: 'water', height: 0.75 } })), 'none');
  }
});

test('legacy water uses native 24/96 distances, closer-fog tag and cylindrical range cap', () => {
  const fog = new EnvironmentFog(); const first = fog.sample({ type: 'water', farPlane: 128 });
  assert.deepEqual([first.start, first.end, first.shape], [-8, 24, 'sphere']);
  assert.equal(fog.sample({ type: 'water', closerWaterFog: true }).end, 20.400001525878906);
  fog.step({ eyesInWater: true }, 600);
  const capped = fog.sample({ type: 'water', farPlane: 32 }); assert.deepEqual([capped.end, capped.shape], [32, 'cylinder']);
  assert.equal(fog.sample({ type: 'water', localPlayer: false, farPlane: 128 }).end, 96);
});

test('legacy biome color transitions take five seconds and retain floored intermediate bytes', () => {
  const fog = new EnvironmentFog();
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0xff0000 }).color, [1, 0, 0]);
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0x0000ff, nowMs: 100 }).color, [1, 0, 0]);
  const half = fog.sample({ type: 'water', waterFogColor: 0x0000ff, nowMs: 2600 }).color;
  close(half[0], 0.5); close(half[2], 0.5);
  fog.sample({ type: 'water', waterFogColor: 0x00ff00, nowMs: 2600 });
  const restart = fog.sample({ type: 'water', waterFogColor: 0x00ff00, nowMs: 2600 }).color;
  close(restart[0], 127 / 255); close(restart[2], 127 / 255);
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0x00ff00, nowMs: 7600 }).color, [0, 1, 0]);
  assert.equal(fog.sample({ type: 'none' }), null);
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0x0000ff, nowMs: 7601 }).color, [0, 0, 1]);
});

test('modern resolved water attributes have separate render fog and no legacy color clock or range cap', () => {
  const fog = new EnvironmentFog({ version: '1.21.11' });
  const first = fog.sample({ type: 'water', waterFogStart: -12, waterFogEnd: 200, farPlane: 32, closerWaterFog: true });
  assert.equal(first.start, -12); assert.equal(first.end, 50); assert.equal(first.renderEnd, 32); assert.equal(first.separateRenderDistance, true);
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0xff0000 }).color, [1, 0, 0]);
  assert.deepEqual(fog.sample({ type: 'water', waterFogColor: 0x0000ff }).color, [0, 0, 1]);
});

test('lava fire resistance follows matching native three versus five block limits', () => {
  for (const [version, end] of [['1.20.4', 3], ['1.21.11', 5], ['26.1', 5]]) {
    const fog = new EnvironmentFog({ version });
    assert.deepEqual([fog.sample({ type: 'lava' }).start, fog.sample({ type: 'lava' }).end], [0.25, 1]);
    assert.deepEqual([fog.sample({ type: 'lava', fireResistance: true }).start, fog.sample({ type: 'lava', fireResistance: true }).end], [0, end]);
    const spectator = fog.sample({ type: 'lava', spectator: true, farPlane: 256 }); assert.deepEqual([spectator.start, spectator.end], [-8, 128]);
  }
});

test('native snow byte colors and blindness priority keep lava/snow independent', () => {
  const legacy = new EnvironmentFog(), modern = new EnvironmentFog({ version: '1.21.11' });
  close(legacy.sample({ type: 'powder-snow' }).color[1], 0.734);
  const snow = modern.sample({ type: 'powder-snow', blindnessDuration: 100 });
  assert.deepEqual([snow.start, snow.end], [0, 2]); close(snow.color[1], 187 / 255);
  const blind = modern.sample({ type: 'water', blindnessDuration: -1 }); assert.deepEqual([blind.start, blind.end, blind.skyEnd], [1.25, 5, 4]); assert.deepEqual(blind.color, [0, 0, 0]);
});

test('water color vision preserves zero channels and native depth darkness differs across versions', () => {
  const modern = new EnvironmentFog({ version: '1.21.11' }); modern.step({ eyesInWater: true }, 600);
  const lit = modern.sample({ type: 'water', waterFogColor: 0x050533 }); close(lit.color[2], 1); close(lit.color[0], 5 / 51);
  assert.deepEqual(modern.sample({ type: 'water', waterFogColor: 0x001100 }).color, [0, Math.fround(17 / 255), 0]);
  const options = { type: 'water', waterFogColor: 0xffffff, eyeY: -63, blindnessDuration: 10 };
  close(new EnvironmentFog().sample(options).color[0], 0.25);
  close(new EnvironmentFog({ version: '1.21.11' }).sample(options).color[0], 1 / 1024);
});

test('native linear fog boundary including negative water start remains well-defined', () => {
  assert.equal(nativeFogFactor(0, -8, 24), 0.25);
  assert.equal(nativeFogFactor(0, -8, 24, '1.20.4'), 0.15625);
  assert.equal(nativeFogFactor(-8, -8, 24), 0); assert.equal(nativeFogFactor(24, -8, 24), 1);
  assert.equal(nativeFogFactor(0, 0, 0), 0); assert.equal(nativeFogFactor(1, 0, 0), 1);
});

test('night vision normalizes immersion fog after boss darkening, with water and darkness priorities', () => {
  for (const version of ['1.20.4', '1.21.11']) {
    const fog = new EnvironmentFog({ version });
    const snow = fog.sample({ type: 'powder-snow', nightVisionScale: 1, bossDarkening: .5 });
    close(Math.max(...snow.color), 1);
    const dark = fog.sample({ type: 'powder-snow', nightVisionScale: 1, hasDarkness: true });
    assert.deepEqual(dark.color, fog.sample({ type: 'powder-snow' }).color);
    assert.deepEqual(fog.sample({ type: 'water', nightVisionScale: 1 }).color, fog.sample({ type: 'water' }).color);
    assert.deepEqual(fog.sample({ type: 'lava', nightVisionScale: 1 }).color, fog.sample({ type: 'lava' }).color);
  }
});

test('effect presence selects zero-factor darkness fog before blending and overrides water range', () => {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const fog = new EnvironmentFog({ version });
    const options = { type: 'water', waterFogColor: 0xffffff, hasDarkness: true, darknessFactor: 0, farPlane: 128 };
    const sample = fog.sample(options);
    assert.deepEqual([sample.start, sample.end, sample.skyEnd], [96, 128, 128]);
    assert.deepEqual(sample.color, [1, 1, 1]);
    const belowVoid = fog.sample({ ...options, eyeY: -64 });
    assert.deepEqual(belowVoid.color, version === '1.20.4' ? [1, 1, 1] : [0, 0, 0]);
    const air = fog.sample({ ...options, type: 'none', atmosphericColor: [0.2, 0.3, 0.4] });
    assert.equal(air.type, 'none'); assert.equal(air.end, 128);
  }
});

test('legacy missing darkness FactorData keeps native default0/0 fog and black color', () => {
  const fog = new EnvironmentFog({ version: '1.20.4' });
  const options = { type: 'water', waterFogColor: 0xffffff, hasDarkness: true, darknessFactor: 0, darknessFactorPresent: false };
  const missing = fog.sample(options);
  assert.deepEqual([missing.start, missing.end, missing.skyEnd], [0, 0, 0]);
  assert.deepEqual(missing.color, [0, 0, 0]);
  const blind = fog.sample({ ...options, blindnessDuration: -1 });
  assert.deepEqual([blind.start, blind.end], [1.25, 5]);
  const lava = fog.sample({ ...options, type: 'lava' });
  assert.deepEqual([lava.start, lava.end], [0.25, 1]);
});

test('only native duration minus-one is infinite before an expired effect is ticked away', () => {
  for (const version of ['1.20.4', '1.21.11', '26.1']) {
    const fog = new EnvironmentFog({ version });
    const received = fog.sample({ type: 'water', waterFogColor: 0xffffff, blindnessDuration: -2, farPlane: 128 });
    close(received.end, Math.fround(140.3)); assert.deepEqual(received.color, [1, 1, 1]);
    const infinite = fog.sample({ type: 'water', waterFogColor: 0xffffff, blindnessDuration: -1, farPlane: 128 });
    assert.equal(infinite.end, 5); assert.deepEqual(infinite.color, [0, 0, 0]);
  }
});
