import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarizeFrames, ResolutionController } from '../src/performance.js';
test('frame report reflects elapsed time and tail stalls, not averaged instantaneous FPS', () => {
  const report = summarizeFrames([10, 10, 10, 50]);
  assert.equal(report.averageFps, 50);
  assert.equal(report.p95Ms, 50);
  assert.equal(report.overBudgetPercent, 25);
  assert.equal(percentile([], 0.95), null);
});
test('adaptive scale responds to sustained overload with limits and hysteresis', () => {
  const controller = new ResolutionController(0.85);
  for (let i = 0; i < 90; i++) controller.update(30, 3000);
  assert.ok(Math.abs(controller.scale - 0.8) < 0.001);
  for (let i = 0; i < 200; i++) controller.update(30, 3100);
  assert.ok(Math.abs(controller.scale - 0.8) < 0.001);
  for (let t = 6000; t < 60000; t += 3000) for (let i = 0; i < 90; i++) controller.update(30, t);
  assert.equal(controller.scale, 0.5);
  assert.equal(controller.update(NaN, 61000), 0.5);
});
