import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import init from '../generation/pkg/pomme_upstream_generation_wasm.js';
import { mapSourceRegistry } from '../generation/source-generation-mapping.js';
import { SourceGenerationWorker } from '../generation/source-generation.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('actual source WASM matches native terrain and biome output across worlds and seed order', async () => {
  const wasm = await init({ module_or_path: await readFile(new URL('../generation/pkg/pomme_upstream_generation_wasm_bg.wasm', import.meta.url)) });
  const vectors = JSON.parse(await readFile(new URL('../generation/native-vectors.json', import.meta.url)));
  const manifestLength = wasm.generator_manifest_len(), manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.generator_manifest_ptr(), manifestLength)));
  assert.equal(manifest.states.length, 29671); assert.equal(manifest.biomes.length, 65);
  for (const vector of [...vectors.vectors, ...vectors.vectors.toReversed()]) {
    assert.equal(wasm.generator_begin(BigInt(vector.seed), vector.dimension, vector.x, vector.z), 1);
    assert.equal(wasm.generator_extract(), 0);
    for (let stage = 1; stage <= 3; stage++) assert.equal(wasm.generator_advance(), stage);
    const length = wasm.generator_extract();
    assert.equal(length, vector.dimension === 0 ? 98304 : 32768);
    assert.equal(hash(new Uint8Array(wasm.memory.buffer, wasm.generator_blocks_ptr(), length * 2)), vector.blocks);
    assert.equal(hash(new Uint8Array(wasm.memory.buffer, wasm.generator_biomes_ptr(), wasm.generator_biomes_len())), vector.biomes);
    assert.equal(wasm.generator_advance(), 0);
    wasm.generator_cancel(); assert.equal(wasm.generator_extract(), 0);
  }
  assert.equal(wasm.generator_begin(0n, 3, 0, 0), 0);
  assert.equal(wasm.generator_begin(0n, 0, 1875000, 0), 0);
  assert.equal(wasm.generator_begin(0n, 0, 0, -1875001), 0);
});

test('native registry translation rejects unavailable block properties, duplicate IDs and missing biomes', () => {
  const source = { minecraftVersion: '1.21.11', sourceCommit: '70b31323967bb99fd4feefab8e96124be369cd6f', states: [{ id: 0, name: 'minecraft:stone', properties: {} }], biomes: [{ id: 0, name: 'minecraft:plains' }] };
  const target = { version: '1.21.11', lookup: () => 1, biomes: [{ id: 4, name: 'plains' }] };
  assert.equal(mapSourceRegistry(source, target).states[0], 1);
  assert.throws(() => mapSourceRegistry(source, { ...target, version: '26.1' }), /exact/);
  assert.throws(() => mapSourceRegistry(source, { ...target, lookup: () => undefined }), /Unsupported source state/);
  assert.throws(() => mapSourceRegistry({ ...source, states: [source.states[0], source.states[0]] }, target), /Invalid source state ID/);
  assert.throws(() => mapSourceRegistry(source, { ...target, biomes: [] }), /Unsupported source biome/);
});

test('worker creation failures reject queued work and allow identical world context retries', async () => {
  const context = { worldKey: 'generation:worker-error', seed: '42', dimension: 'minecraft:overworld', version: '1.21.11' };
  const registry = { version: '1.21.11', lookup: () => 1, biomes: [{ id: 4, name: 'plains' }] };
  const manifest = { minecraftVersion: '1.21.11', sourceCommit: '70b31323967bb99fd4feefab8e96124be369cd6f', states: [{ id: 0, name: 'minecraft:stone', properties: {} }], biomes: [{ id: 0, name: 'minecraft:plains' }] };
  const failure = new Error('Worker construction blocked'), workers = [];
  let blocked = true;
  const generator = new SourceGenerationWorker({ workerFactory() {
    if (blocked) throw failure;
    const worker = { terminate() {}, postMessage() {} }; workers.push(worker); return worker;
  } });
  assert.throws(() => generator.configure(context, registry), error => error === failure);
  await assert.rejects(generator.request({ x: 0, z: 0 }), error => error === failure);
  blocked = false; generator.configure(context, registry);
  workers[0].onmessage({ data: { type: 'ready', manifest } });
  const controller = new AbortController();
  const active = generator.request({ x: 0, z: 0, signal: controller.signal });
  const activeRejected = assert.rejects(active, error => error.name === 'AbortError');
  const queuedRejected = assert.rejects(generator.request({ x: 1, z: 0 }), error => error === failure);
  blocked = true; controller.abort();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(generator.worker, null); assert.equal(generator.queue.length, 0);
  blocked = false; generator.configure(context, registry);
  assert.equal(workers.length, 2); generator.close();
});

test('synchronous worker message failures reject active and queued requests', async () => {
  const failure = new Error('Worker message serialization failed');
  const worker = { terminate() {}, postMessage() { throw failure; } };
  const generator = new SourceGenerationWorker({ workerFactory: () => worker });
  generator.configure({ worldKey: 'generation:message-error', seed: '42', dimension: 'minecraft:overworld', version: '1.21.11' }, { version: '1.21.11' });
  generator.mapping = {};
  await assert.rejects(generator.request({ x: 0, z: 0 }), error => error === failure);
  await assert.rejects(generator.request({ x: 1, z: 0 }), error => error === failure);
  assert.equal(generator.worker, null); generator.close();
});
