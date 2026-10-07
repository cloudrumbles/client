import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLightingProcessor } from '../src/lighting.worker.js';

const materials = [[0, { flags: 128, opacity: 0 }], [1, { flags: 3, opacity: 15 }],
  [2, { flags: 9, opacity: 0, emitLight: 14 }]];
const column = (x = 0, z = 0) => ({ x, z, revision: 0, sections: [] });
function set(target, x, y, z, state) {
  const sectionY = Math.floor(y / 16);
  let section = target.sections.find(value => value.sectionY === sectionY);
  if (!section) { section = { sectionY, blocks: new Uint16Array(4096) }; target.sections.push(section); }
  section.blocks[((y % 16 + 16) % 16) * 256 + z * 16 + x] = state;
  target.revision++;
}
const solve = (columns, options = {}) => ({ type: 'solve', generation: 1, id: 3, revision: 9,
  minY: -64, height: 80, hasSkylight: true, targets: [`${columns[0].x},${columns[0].z}`], columns, ...options });
function sample(result, kind, x, y, z) {
  const bytes = result[kind].get(Math.floor(y / 16)), index = ((y % 16 + 16) % 16) * 256 + z * 16 + x;
  return bytes[index >>> 1] >>> ((index & 1) * 4) & 15;
}
async function initialized(options) {
  const process = createLightingProcessor(options);
  assert.equal(await process({ type: 'init', generation: 1, materials }), null);
  return process;
}

test('lighting worker computes and removes native torch light across a column boundary', async () => {
  const process = await initialized(), center = column(-3, -5), west = column(-4, -5);
  set(west, 15, -10, 8, 2);
  const first = await process(solve([center, west]));
  assert.equal(first.type, 'light-result');
  assert.equal(first.id, 3); assert.equal(first.revision, 9); assert.equal(first.generation, 1);
  assert.equal(sample(first.results[0], 'block', 0, -10, 8), 13);
  assert.equal(sample(first.results[0], 'block', 1, -10, 8), 12);
  set(west, 15, -10, 8, 0);
  const removed = await process(solve([center, west], { revision: 10 }));
  assert.equal(removed.cacheHits, 0, 'a changed halo revision invalidates the target cache');
  assert.ok([...removed.results[0].block.values()].every(bytes => bytes.every(value => value === 0)));
});

test('unknown neighbors remain opaque and cannot provide invented light around a roof', async () => {
  const process = await initialized(), center = column();
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) set(center, x, 0, z, 1);
  const closed = await process(solve([center]));
  assert.equal(sample(closed.results[0], 'sky', 0, -1, 8), 0);
  const west = column(-1, 0), known = await process(solve([center, west]));
  assert.equal(sample(known.results[0], 'sky', 0, -1, 8), 14,
    'only a genuinely loaded open neighboring column supplies light below the roof');
});

test('native full-height output contains signed section Maps of transferable packed nibbles', async () => {
  const process = await initialized(), center = column(-12, 7);
  set(center, 5, -64, 7, 2);
  const response = await process(solve([center], { minY: -64, height: 384, hasSkylight: false }));
  const result = response.results[0];
  assert.equal(result.x, -12); assert.equal(result.z, 7);
  assert.ok(result.sky instanceof Map && result.block instanceof Map);
  assert.deepEqual([...result.sky.keys()], Array.from({ length: 24 }, (_, index) => index - 4));
  assert.ok([...result.sky.values(), ...result.block.values()].every(bytes => bytes instanceof Uint8Array && bytes.length === 2048));
  assert.equal(sample(result, 'sky', 5, -64, 7), 0);
  assert.equal(sample(result, 'block', 5, -64, 7), 14);
  const buffers = [...result.sky.values(), ...result.block.values()].map(bytes => bytes.buffer);
  const received = structuredClone(response, { transfer: buffers });
  assert.equal(result.block.get(-4).byteLength, 0);
  assert.equal(sample(received.results[0], 'block', 6, -64, 7), 13);
  const cached = await process(solve([center], { minY: -64, height: 384, hasSkylight: false }));
  assert.equal(cached.cacheHits, 1, 'transferred result arrays do not detach the cache');
  assert.equal(sample(cached.results[0], 'block', 5, -64, 7), 14);
});

test('cache reuse is owned, reset cancels yielded jobs, and bounded malformed input is rejected', async () => {
  let release;
  const process = await initialized({ yieldControl: () => new Promise(resolve => { release = resolve; }) });
  const center = column(), east = column(1, 0);
  const first = await process(solve([center]));
  first.results[0].sky.get(-4).fill(0);
  const cached = await process(solve([center], { revision: 10 }));
  assert.equal(cached.cacheHits, 1);
  assert.equal(sample(cached.results[0], 'sky', 0, -64, 0), 15);
  const pending = process(solve([center, east], { targets: ['0,0', '1,0'] }));
  assert.equal(typeof release, 'function');
  await process({ type: 'init', generation: 2, materials: [[0, { opacity: 15 }]] });
  release();
  assert.equal(await pending, null, 'unfinished previous generation produces no stale response');
  assert.equal(await process(solve([center])), null, 'late work for a previous generation is ignored');
  const reset = await process(solve([center], { generation: 2 }));
  assert.equal(reset.cacheHits, 0, 'initialization clears the cache');
  const bad = options => process(solve([center], { generation: 2, ...options }));
  await assert.rejects(bad({ targets: Array.from({ length: 10 }, (_, x) => `${x},0`) }), /1–9/);
  await assert.rejects(bad({ columns: Array.from({ length: 82 }, () => center) }), /81/);
  await assert.rejects(bad({ columns: [center, center] }), /Duplicate.*column/);
  const section = { sectionY: -4, blocks: new Uint16Array(4096) };
  await assert.rejects(bad({ columns: [{ ...center, sections: [section, section] }] }), /Duplicate.*section/);
  await assert.rejects(bad({ columns: [{ ...center, sections: [{ ...section, blocks: new Uint16Array(1) }] }] }), /4096/);
  await assert.rejects(bad({ columns: [{ ...center, sections: Array.from({ length: 6 }, (_, index) => ({ ...section, sectionY: index - 4 })) }] }), /Too many/);
});
