import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTOR_LAYERS, FULLBRIGHT, EYES_ADDITIVE, EYES_TRANSLUCENT, actorEyeFlags, partitionActorLayers, sortActorQuads } from '../src/actor-layers.js';

test('native eye blend changes at the modern renderer and high flags retain every light pair', () => {
  assert.equal(actorEyeFlags('1.20.4'), 32 | FULLBRIGHT | EYES_ADDITIVE);
  assert.equal(actorEyeFlags('1.21.11'), 32 | FULLBRIGHT | EYES_TRANSLUCENT);
  assert.equal(actorEyeFlags('26.1'), 32 | FULLBRIGHT | EYES_TRANSLUCENT);
  for (const layer of ACTOR_LAYERS) for (let sky = 0; sky < 16; sky++) for (let block = 0; block < 16; block++) {
    const flags = 32 | layer.flag | FULLBRIGHT | 512 | sky << 10 | block << 14 | 2097152;
    assert.equal(new Float32Array([flags])[0], flags);
  }
});

test('translucent actor sorting keeps face halves together and reverses at the other side of the model', () => {
  const face = z => Array.from({length:6},(_,vertex)=>[0,0,z,0,0,1,vertex,0,0,1,0,0,0,EYES_TRANSLUCENT]).flat();
  const source = new Float32Array([...face(1),...face(0)]), before = new Float32Array(source);
  const fromFront = sortActorQuads(source,[0,0,2]);
  assert.deepEqual([fromFront[2],fromFront[86]],[0,1]);
  assert.deepEqual(Array.from({length:6},(_,vertex)=>fromFront[vertex*14+6]),[0,1,2,3,4,5]);
  assert.equal(sortActorQuads(source,[0,0,-2]),source); assert.deepEqual(source,before);
  assert.deepEqual(sortActorQuads(source,[0,40000,2],[0,40000,0]),fromFront);
});

test('actor partition preserves triangles, order and source bytes without changing the ordinary stream', () => {
  const kinds = [0, ...ACTOR_LAYERS.map(layer => layer.flag), 0, ACTOR_LAYERS[0].flag];
  const input = new Float32Array(kinds.flatMap((flag, triangle) => Array.from({ length: 3 }, (_, vertex) => [triangle, vertex, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, flag]).flat()));
  const original = new Float32Array(input), output = partitionActorLayers(input);
  assert.deepEqual(input, original); assert.equal(Object.values(output).reduce((sum, value) => sum + value.length, 0), input.length);
  assert.deepEqual([output.base[0], output.base[42]], [0, 5]);
  assert.deepEqual([output.eyesAdditive[0], output.eyesAdditive[42]], [1, 6]);
  for (const [index, layer] of ACTOR_LAYERS.entries()) assert.equal(output[layer.name][13], layer.flag);
  assert.equal(partitionActorLayers(input.subarray(0, 42)).base.buffer, input.buffer);
});
