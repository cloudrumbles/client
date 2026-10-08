import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeNightVisionScale, NativeDarknessFactor } from '../src/environment-effects.js';
const f = Math.fround;

test('native night vision distinguishes infinite duration, the200tick boundary and partial ticks', () => {
  assert.equal(nativeNightVisionScale(-1, .5), 1); assert.equal(nativeNightVisionScale(201, .5), 1);
  assert.equal(nativeNightVisionScale(0), f(.7));
  assert.equal(nativeNightVisionScale(200), f(.7));
  assert.notEqual(nativeNightVisionScale(200, .5), 1); assert.notEqual(nativeNightVisionScale(5, .5), nativeNightVisionScale(5, 0));
  assert.throws(() => nativeNightVisionScale(200.5), /int/); assert.throws(() => nativeNightVisionScale(200, 2), /partial/);
});

test('legacy darkness starts at0 then uses its22tick padding and partial frame values', () => {
  const factor = new NativeDarknessFactor(); factor.tick(100); assert.equal(factor.sample(1), 0);
  factor.tick(99); assert.equal(factor.sample(1), f(1 / 22)); assert.equal(factor.sample(.5), f(f(1 / 22) * f(.5)));
  for (let i = 0; i < 21; i++) factor.tick(98 - i); assert.equal(factor.sample(1), 1);
  factor.tick(22); assert.equal(factor.sample(1), 1); factor.tick(21); assert.equal(factor.sample(1), f(1 - f(1 / 22)));
  for (let i = 0; i < 21; i++) factor.tick(Math.max(0, 20 - i)); assert.equal(factor.sample(1), 0);
});

test('legacy factor save fields restore exactly, replacement does not inherit old blend, absent factor stays0', () => {
  const source = { padding_duration: 22, factor_start: .25, factor_target: 1, factor_current: .5, ticks_active: 8, factor_previous_frame: .45, had_effect_last_tick: true };
  const factor = new NativeDarknessFactor({ factorData: source }); assert.equal(factor.sample(0), f(.45)); assert.equal(factor.sample(1), .5);
  factor.tick(50); assert.equal(factor.snapshot().ticks_active, 9); assert.equal(factor.sample(1), f(f(.25) + f(f(9 / 22) * f(.75))));
  const replacement = new NativeDarknessFactor({ factorData: null }); replacement.tick(-1); assert.equal(replacement.sample(1), 0); assert.equal(replacement.snapshot(), null);
  assert.throws(() => replacement.copyFrom(factor), /Legacy/);
  const zero = new NativeDarknessFactor({ factorData: { padding_duration: 0 } }); zero.tick(50); assert.ok(Number.isNaN(zero.sample(1)));
});

test('modern darkness increments immediately and clamps rather than recomputing a whole fade', () => {
  const factor = new NativeDarknessFactor({ version: '1.21.11' }); factor.tick(100); assert.equal(factor.sample(1), f(1 / 22));
  for (let i = 0; i < 21; i++) factor.tick(99 - i); assert.equal(factor.sample(1), 1);
  factor.tick(22); assert.equal(factor.sample(1), f(1 - f(1 / 22)));
  const fade = factor.sample(1); factor.tick(100); assert.equal(factor.sample(1), 1); assert.equal(factor.sample(0), fade);
  assert.equal(factor.sample(0, { removed: true }), 1);
});

test('modern skip blending and refreshed-instance copying use source presence and retain previous frame', () => {
  const instant = new NativeDarknessFactor({ version: '1.21.11', shouldBlend: false, remainingDuration: 23 }); assert.equal(instant.sample(0), 1);
  instant.setImmediate(22); assert.equal(instant.sample(1), 0); instant.setImmediate(-1); assert.equal(instant.sample(.5), 1);
  const previous = new NativeDarknessFactor({ version: '1.21.11' }); previous.tick(100); previous.tick(99);
  const next = new NativeDarknessFactor({ version: '1.21.11', shouldBlend: false, remainingDuration: 100 }); next.copyFrom(previous);
  assert.deepEqual(next.snapshot(), previous.snapshot()); assert.equal(next.sample(.5), previous.sample(.5));
  assert.throws(() => next.copyFrom(new NativeDarknessFactor()), /matching/);
  assert.throws(() => new NativeDarknessFactor({ factorData: { padding_duration: -1 } }), /counter/);
});
