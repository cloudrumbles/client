import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceBoatVisual, boatBubbleMatrix, nativeBoatUnderWater } from '../src/entity-boat-state.js';

const metadata = values => (key, fallback) => values[key] ?? fallback;
test('native boat bubble endpoints and decay are independent of render frame rate', () => {
  const run = rate => {
    const track = { createdAt: 0 }, values = { bubble_time: 60, hurt: 10, damage: 4, hurtdir: -1 }; let pose;
    for (let frame = 0; frame <= rate; frame++) pose = advanceBoatVisual(track, frame / rate, metadata(values), '1.21.11');
    assert.equal(track.boatVisual.strength, 1); assert.equal(pose.hurtRadians, 0);
    values.bubble_time = 0;
    for (let frame = 1; frame <= rate / 2; frame++) pose = advanceBoatVisual(track, 1 + frame / rate, metadata(values), '1.21.11');
    return { state: track.boatVisual, pose };
  };
  assert.deepEqual(run(30), run(120)); assert.equal(run(30).state.strength, 0); assert.equal(run(30).pose.animated, false);
});

test('native boat animation converges after a long suspended render without iterating world age', () => {
  const track = { createdAt: 0 }, values = { bubble_time: 60 };
  advanceBoatVisual(track, 0, metadata(values));
  const far = advanceBoatVisual(track, 1e8 + .025, metadata(values));
  assert.equal(track.boatVisual.tick, 2000000000); assert.equal(track.boatVisual.strength, 1);
  assert.ok(Number.isFinite(far.bubbleDegrees)); assert.ok(Math.abs(far.bubbleDegrees) <= 10);
  values.bubble_time = 0;
  const stopped = advanceBoatVisual(track, 2e8, metadata(values));
  assert.equal(stopped.bubbleDegrees, 0); assert.equal(stopped.animated, false);
});

test('boat hurt direction changes native tilt while zero hurt and zero bubble retain identity', () => {
  const positive = advanceBoatVisual({ createdAt: 0 }, 0, metadata({ hurt: 8, damage: 4, hurtdir: 1 }), '1.20.4');
  const negative = advanceBoatVisual({ createdAt: 0 }, 0, metadata({ hurt: 8, damage: 4, hurtdir: -1 }), '1.20.4');
  assert.ok(positive.hurtRadians !== 0); assert.equal(negative.hurtRadians, -positive.hurtRadians);
  assert.deepEqual(boatBubbleMatrix(0), [1, -0, 0, 0, 1, -0, 0, 0, 1]);
  const bubble = boatBubbleMatrix(10); assert.ok(bubble.every(Number.isFinite));
  assert.equal(bubble[1], -bubble[3]); assert.equal(bubble[5], -bubble[7]);
  assert.ok(Math.hypot(...bubble.slice(0, 3)) > 1, 'native diagonal axis remains nonunit');
});

test('native boat underwater detection uses hull top, contiguous height and strict native boundary', () => {
  const definition = { width: 1.375, height: .5625 }, position = { x: .5, y: 0, z: .5 };
  const water = height => () => ({ fluid: { kind: 'water', height } });
  assert.equal(nativeBoatUnderWater(position, definition, water(.5)), false, 'water at feet leaves floating hull patch');
  assert.equal(nativeBoatUnderWater(position, definition, water(1)), true);
  assert.equal(nativeBoatUnderWater(position, definition, () => ({ fluid: { kind: 'lava', height: 1 } })), false);
  const height = Math.fround(.5635);
  assert.equal(nativeBoatUnderWater({ ...position, y: height - .5625 - .001 }, definition, water(height)), false, 'equality is not underwater');
  let samples = 0;
  nativeBoatUnderWater({ ...position, y: 2e9 }, definition, () => { samples++; return { fluid: { kind: 'water', height: 1 } }; });
  assert.ok(samples <= 18, 'sample count stays bounded at native extreme coordinates');
});
