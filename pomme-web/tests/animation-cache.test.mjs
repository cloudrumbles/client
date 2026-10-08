import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTextureAnimations } from '../src/renderer.js';

const frame = value => new Uint8Array(4).fill(value);
const rectangle = { x: 0, y: 0, width: 1, height: 1 };
const animation = (frames, tile = 0, interpolate = true) => ({ tile, width: 1, height: 1, frames, durationsTicks: frames.map(() => 2), interpolate });

test('animation admission includes independent interpolation buffers in its fixed cache budget', () => {
  const frames = [frame(0), frame(255)], rectangles = new Map([[0, rectangle]]);
  assert.throws(() => prepareTextureAnimations([animation(frames)], rectangles, 8), /interpolation buffers.*budget/);
  const prepared = prepareTextureAnimations([animation(frames)], rectangles, 12);
  assert.equal(prepared.bytes, 12);
  assert.equal(prepared.animations[0].blend.byteLength, 4);
  assert.equal(prepared.animations[0].cycleTicks, 4);
  assert.ok(prepared.animations[0].frames.every((value, index) => value === frames[index]), 'native frame storage is retained without another copy');
});

test('shared animation frames count once while each mutable interpolation buffer is reserved separately', () => {
  const frames = [frame(0), frame(255)], animations = [animation(frames,0), animation(frames,1)];
  const rectangles = new Map([[0,rectangle],[1,rectangle]]);
  assert.throws(() => prepareTextureAnimations(animations, rectangles, 12), /budget/);
  const prepared = prepareTextureAnimations(animations, rectangles, 16);
  assert.equal(prepared.bytes, 16);
  assert.notEqual(prepared.animations[0].blend, prepared.animations[1].blend);
  prepared.animations[0].blend.fill(123);
  assert.ok(prepared.animations[1].blend.every(value => value === 0));
});

test('non-interpolated and singleton animations require no mutable blend storage', () => {
  const frames = [frame(10), frame(20)], rectangles = new Map([[0,rectangle],[1,rectangle]]);
  const prepared = prepareTextureAnimations([animation(frames,0,false), animation([frames[0]],1)], rectangles,8);
  assert.equal(prepared.bytes, 8); assert.ok(prepared.animations.every(value => value.blend === null && !value.interpolate));
});

test('animation validation rejects inconsistent frames and ticks before cache buffers are allocated', () => {
  const rectangles = new Map([[0,rectangle]]);
  assert.throws(() => prepareTextureAnimations([animation([new Uint8Array(3)])],rectangles), /Invalid animation frame/);
  assert.throws(() => prepareTextureAnimations([{...animation([frame(0)]),durationsTicks:[0]}],rectangles), /timing/);
  assert.throws(() => prepareTextureAnimations([animation([frame(0)],99)],rectangles), /Invalid texture animation/);
});
