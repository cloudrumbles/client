import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hangingSignAttachment, hangingSignGeometry, hangingSignForm } from '../src/hanging-sign.js';
import { registryStates } from '../src/anvil.js';

const STRIDE = 14, near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const bounds = vertices => [0, 1, 2].map(axis => { const values = Array.from({ length: vertices.length / STRIDE }, (_, index) => vertices[index * STRIDE + axis]); return [Math.min(...values), Math.max(...values)]; });
const partVertices = (geometry, name) => { const part = geometry.parts.find(part => part.name === name); return geometry.vertices.subarray(part.firstVertex * STRIDE, (part.firstVertex + part.vertexCount) * STRIDE); };

test('native attachment selection distinguishes wall, unattached ceiling and attached V-chain forms', () => {
  assert.equal(hangingSignAttachment('oak_wall_hanging_sign', { attached: 'true' }), 'wall');
  assert.equal(hangingSignAttachment('minecraft:oak_hanging_sign', { attached: 'false' }), 'ceiling');
  assert.equal(hangingSignAttachment('pale_oak_hanging_sign', { attached: true }), 'ceiling_middle');
  assert.equal(hangingSignAttachment('oak_sign'), null); assert.equal(hangingSignGeometry('other'), null);
  assert.deepEqual(hangingSignGeometry('wall').parts.map(part => part.name), ['board', 'plank', 'chainL1', 'chainL2', 'chainR1', 'chainR2']);
  assert.deepEqual(hangingSignGeometry('ceiling').parts.map(part => part.name), ['board', 'chainL1', 'chainL2', 'chainR1', 'chainR2']);
  assert.deepEqual(hangingSignGeometry('ceiling_middle').parts.map(part => part.name), ['board', 'vChains']);
});

test('native board/plank geometry has exact renderer height and sheet UVs', () => {
  const wall = hangingSignGeometry('wall'), board = partVertices(wall, 'board'), plank = partVertices(wall, 'plank');
  assert.equal(board.length / STRIDE, 72); assert.equal(plank.length / STRIDE, 72);
  assert.deepEqual(bounds(board), [[1 / 16, 15 / 16], [0, 10 / 16], [7 / 16, 9 / 16]]);
  assert.deepEqual(bounds(plank), [[0, 1], [14 / 16, 1], [6 / 16, 10 / 16]]);
  const front = []; for (let i = 0; i < board.length; i += STRIDE) if (board[i + 5] > .99) front.push([board[i + 10], board[i + 11]]);
  assert.equal(front.length, 12); assert.deepEqual([...new Set(front.map(uv => uv[0]))].sort((a, b) => a - b), [2 / 64, 16 / 64]);
  assert.deepEqual([...new Set(front.map(uv => uv[1]))].sort((a, b) => a - b), [14 / 32, 24 / 32]);
});

test('native normal chains are four crossed zero-depth planes with distinct native front/back UVs', () => {
  const mesh = hangingSignGeometry('ceiling'); assert.equal(mesh.vertices.length / STRIDE, 168);
  for (const name of ['chainL1', 'chainL2', 'chainR1', 'chainR2']) {
    const vertices = partVertices(mesh, name); assert.equal(vertices.length / STRIDE, 24);
    const box = bounds(vertices); near(box[1][0], .625); near(box[1][1], 1);
    near((box[0][0] + box[0][1]) / 2, name.includes('L') ? .1875 : .8125); near((box[2][0] + box[2][1]) / 2, .5);
    const uvXs = [...new Set(Array.from({ length: vertices.length / STRIDE }, (_, index) => vertices[index * STRIDE + 10]))].sort((a, b) => a - b);
    assert.deepEqual(uvXs, name.endsWith('1') ? [0, 3 / 64, 6 / 64] : [6 / 64, 9 / 64, 12 / 64]);
    for (let i = 0; i < vertices.length; i += STRIDE) { near(Math.abs(vertices[i + 3]), Math.SQRT1_2); near(vertices[i + 4], 0); near(Math.abs(vertices[i + 5]), Math.SQRT1_2); }
  }
  const left1 = partVertices(mesh, 'chainL1'), left2 = partVertices(mesh, 'chainL2'); assert.ok(left1[3] * left2[3] < 0 && left1[5] * left2[5] > 0, 'both chain sides cross at opposite native yaw angles');
});

test('attached native V-chain is a two-sided 12 by 6 pixel plane without plank or substitute rods', () => {
  const mesh = hangingSignGeometry('ceiling_middle'); assert.equal(mesh.vertices.length / STRIDE, 96);
  const chain = partVertices(mesh, 'vChains'); assert.equal(chain.length / STRIDE, 24); assert.deepEqual(bounds(chain), [[.125, .875], [.625, 1], [.5, .5]]);
  const uvXs = [...new Set(Array.from({ length: chain.length / STRIDE }, (_, index) => chain[index * STRIDE + 10]))].sort((a, b) => a - b);
  assert.deepEqual(uvXs, [14 / 64, 26 / 64, 38 / 64]);
});

test('native no-cull polygons retain source normals and UVs in paired opposite winding', () => {
  for (const attachment of ['wall', 'ceiling', 'ceiling_middle']) {
    const vertices = hangingSignGeometry(attachment).vertices;
    for (let i = 0; i < vertices.length; i += STRIDE * 3) {
      const a = Array.from(vertices.subarray(i, i + 3)), b = Array.from(vertices.subarray(i + STRIDE, i + STRIDE + 3)), c = Array.from(vertices.subarray(i + STRIDE * 2, i + STRIDE * 2 + 3));
      const ab = b.map((value, axis) => value - a[axis]), ac = c.map((value, axis) => value - a[axis]), cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], normal = vertices.subarray(i + 3, i + 6);
      near(Math.hypot(...normal), 1); const dot = cross.reduce((sum, value, axis) => sum + value * normal[axis], 0);
      assert.ok(i % (STRIDE * 6) === 0 ? dot > 0 : dot < 0);
      if (i % (STRIDE * 6) === 0) for (const [corner, reversed] of [[0, 0], [1, 2], [2, 1]]) assert.deepEqual(vertices.subarray(i + corner * STRIDE, i + (corner + 1) * STRIDE), vertices.subarray(i + (3 + reversed) * STRIDE, i + (4 + reversed) * STRIDE));
    }
  }
});

test('every native hanging-sign state selects its wood, attachment and orientation without mutating collision inputs', async () => {
  for (const version of ['1.20.4', '1.21.11']) {
    const registry = JSON.parse(await readFile(new URL(`../data/${version}-registry.json`, import.meta.url), 'utf8')), states = registryStates(registry), textures = new Map();
    const hanging = [...states.byId.values()].filter(state => state.name.endsWith('_hanging_sign'));
    for (const state of hanging) { const wood = state.block.name.replace(/_(?:wall_)?hanging_sign$/, ''); textures.set(`minecraft:entity/signs/hanging/${wood}`, textures.size); }
    assert.ok(hanging.length >= 720);
    const attachments = new Set(), rotations = new Set(), facings = new Set();
    for (const state of hanging) {
      const before = { ...state.properties }, form = hangingSignForm(state.name, state.properties, textures); assert.ok(form); assert.deepEqual({ ...state.properties }, before);
      attachments.add(hangingSignAttachment(state.name, state.properties)); assert.equal(form.kind, 'hanging sign'); assert.equal(form.x, 0);
      const wood = state.block.name.replace(/_(?:wall_)?hanging_sign$/, ''), tile = textures.get(`minecraft:entity/signs/hanging/${wood}`);
      for (let i = 12; i < form.vertices.length; i += STRIDE) assert.equal(form.vertices[i], tile);
      if (state.block.name.includes('_wall_')) { facings.add(state.properties.facing); assert.equal(form.freeY, 0); assert.equal(form.y, { south: 0, west: 90, north: 180, east: 270 }[state.properties.facing]); }
      else { rotations.add(state.properties.rotation); assert.equal(form.y, 0); assert.equal(form.freeY, Number(state.properties.rotation) * 22.5); }
    }
    assert.equal(attachments.size, 3); assert.equal(rotations.size, 16); assert.equal(facings.size, 4);
  }
});

test('native forms require the actual imported wood sheet and isolate atlas tile IDs', () => {
  assert.equal(hangingSignForm('oak_hanging_sign', {}, new Map()), null);
  const first = hangingSignForm('oak_hanging_sign', {}, new Map([['minecraft:entity/signs/hanging/oak', 4]]));
  const second = hangingSignForm('oak_hanging_sign', {}, new Map([['minecraft:entity/signs/hanging/oak', 9]]));
  first.vertices[12] = 123; assert.equal(second.vertices[12], 9); assert.equal(hangingSignGeometry('ceiling').vertices[12], 0);
});
