import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opaqueGeometryCastsShadow } from '../src/shadow-casters.js';

const triangle = flags => new Float32Array(Array.from({ length:3 },(_,index) => [index,0,0,0,1,0,1,1,1,1,0,0,0,Array.isArray(flags) ? flags[index] : flags]).flat());
const concat = (...arrays) => new Float32Array(arrays.flatMap(array => Array.from(array)));

test('only flag branches guaranteed to discard every vertex omit a dynamic shadow caster', () => {
  assert.equal(opaqueGeometryCastsShadow(new Float32Array()),false);
  for (const flags of [16777216,16777216 | 1 | 8,64,8,8 | 512 | 15 << 10]) assert.equal(opaqueGeometryCastsShadow(triangle(flags)),false,`flags${flags}`);
  for (const flags of [0,1,8 | 1,512 | 15 << 10]) assert.equal(opaqueGeometryCastsShadow(triangle(flags)),true,`flags${flags}`);
});

test('mixed geometry and uncertain vertex flags remain casters without examining texture alpha', () => {
  assert.equal(opaqueGeometryCastsShadow(concat(triangle(16777216),triangle(1))),true);
  assert.equal(opaqueGeometryCastsShadow(triangle([16777216,16777216,1])),true);
  assert.equal(opaqueGeometryCastsShadow(triangle([64,8,16777216])),false);
  for (const flags of [NaN,Infinity,-8,4294967295]) assert.equal(opaqueGeometryCastsShadow(triangle(flags)),true);
  assert.equal(opaqueGeometryCastsShadow(new Float32Array(14)),true);
  const unknownAtlas = triangle(1); for(let at = 12;at < unknownAtlas.length;at += 14) unknownAtlas[at] = -1;
  assert.equal(opaqueGeometryCastsShadow(unknownAtlas),true);
});

test('native high-bit beam flags are evaluated after the same Float32 admission as GPU uploads', () => {
  for (const sky of [0,15]) for (const block of [0,15]) {
    const beam = 536870912 | 16777216 | 512 | sky << 10 | block << 14;
    assert.equal(opaqueGeometryCastsShadow(triangle(beam)),false);
    assert.equal(opaqueGeometryCastsShadow(triangle(beam | 64)),false);
  }
  assert.equal(opaqueGeometryCastsShadow(triangle(268435456)),true,'An unrelated high wind bit cannot imply shadow discard.');
});
