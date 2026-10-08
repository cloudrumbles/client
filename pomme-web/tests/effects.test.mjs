import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { MinecraftEffects, precipitationFor } from '../src/effects.js';

const data = minecraftData('1.20.4');
const registry = { particles: data.particlesArray, items: data.itemsArray };
const packet = (name, extra = {}) => ({ particleId: data.particlesByName[name].id, longDistance: false, x: 0, y: 2, z: -2, offsetX: 0, offsetY: 0, offsetZ: 0, particleData: 0, particles: 1, ...extra });
function create(options = {}) {
  const uploads = new Map(), removals = [];
  const renderer = { uploadDynamicMesh(name, vertices, water, bounds, format) { uploads.set(name, { vertices: vertices.slice(), water, bounds, format }); }, removeMesh(name) { uploads.delete(name); removals.push(name); } };
  return { effects: new MinecraftEffects({ renderer, registry, random: () => 0.5, ...options }), uploads, removals };
}

test('real particle IDs and count-zero packet semantics preserve directed velocity without cluster jitter', () => {
  const { effects } = create();
  effects.tick(0, { eye: [0, 2, 0] });
  assert.equal(effects.spawnPacket(packet('dust', { particles: 0, offsetX: 1, offsetY: -2, offsetZ: 3, particleData: 0.2, data: { red: 0.3, green: 0.6, blue: 0.9, scale: 2 } })), 1);
  assert.deepEqual(effects.particles[0].velocity, [0.2, -0.4, 0.6000000000000001]);
  assert.deepEqual(effects.particles[0].position, [0, 2, -2]); assert.deepEqual(effects.particles[0].color, [0.3, 0.6, 0.9]); assert.equal(effects.particles[0].size, 0.2);
  effects.spawnPacket(packet('entity_effect', { particles: 0, offsetX: 0.2, offsetY: 0.4, offsetZ: 0.8, particleData: 1 }));
  assert.deepEqual(effects.particles[1].color, [0.2, 0.4, 0.8]); assert.deepEqual(effects.particles[1].velocity, [0, 0, 0]);
});

test('particle packets honor ordinary/long-distance limits, reject malformed values, and enforce packet/global caps', () => {
  const { effects } = create({ maxParticles: 8, maxPacketParticles: 4 }); effects.tick(0, { eye: [0, 2, 0] });
  assert.equal(effects.spawnPacket(packet('flame', { x: 40 })), 0);
  assert.equal(effects.spawnPacket(packet('flame', { x: 40, longDistance: true, particles: 1000 })), 4);
  assert.equal(effects.spawnPacket(packet('flame', { particles: 1000 })), 4);
  assert.equal(effects.spawnPacket(packet('flame')), 0); assert.equal(effects.stats().active, 8);
  assert.equal(effects.spawnPacket(packet('flame', { particles: -1 })), 0);
  assert.equal(effects.spawnPacket(packet('flame', { x: NaN })), 0);
  assert.equal(effects.spawnPacket(packet('flame', { particleId: 9999 })), 0); assert.equal(effects.stats().unknownParticles, 1);
});

test('fixed 20 Hz simulation, collision, full-bright flags, atlas animation, lifetime fade, and disposal produce actual mesh data', () => {
  const atlas = { particleFrames: new Map([['minecraft:end_rod', [4, 5, 6, 7]]]) };
  const { effects, uploads } = create({ atlas, collides: (min) => min[1] < 0 });
  effects.spawn('block', [0, 0.1, -2], [0, -0.1, 0], { blockState: 1 }); effects.spawn('end_rod', [0, 2, -2]);
  effects.tick(0.05, { eye: [0, 2, 3], direction: [0, 0, -1] });
  assert.equal(effects.particles[0].position[1], 0.1); assert.equal(effects.particles[0].onGround, true);
  const upload = uploads.get('minecraft-particles'); assert.ok(upload.vertices.length); assert.equal(upload.format.stride, 14);
  assert.ok(Array.from(upload.vertices).every(Number.isFinite));
  assert.ok(Array.from({ length: upload.vertices.length / 14 }, (_, index) => upload.vertices[index * 14 + 13]).some(flags => (flags & 8) !== 0));
  for (let frame = 0; frame < 45; frame++) effects.tick(0.05, { eye: [0, 2, 3] });
  const rod = effects.particles.find(particle => particle.name === 'end_rod'); assert.ok(rod.age >= 40);
  const faded = uploads.get('minecraft-particles').vertices;
  assert.ok(faded[9] < 1); assert.equal(faded[12], 6);
  effects.clear(); assert.equal(effects.stats().active, 0); assert.equal(uploads.size, 0);
});

test('native world-border particle geometry retains sub-block precision by subtracting the mesh origin before f32', () => {
  const { effects, uploads } = create(); const position = [29999000.375, -45.5, -29999980.625];
  effects.spawn('dust', position, [0, 0, 0], { red: 1, green: 0, blue: 0, scale: 1 });
  effects.tick(0, { eye: [position[0], position[1], position[2] + 3] });
  const upload = uploads.get('minecraft-particles');
  assert.ok(upload.format.origin[0] > 29998000); assert.ok(upload.format.origin[2] < -29999000);
  const x = upload.vertices[0] + upload.format.origin[0]; assert.ok(Math.abs(x - (position[0] - 0.1)) < 0.0001);
  assert.ok(upload.bounds.max[0] - upload.bounds.min[0] > 0.19);
});

test('block-destruction world event uses confirmed block state and imported face tiles with quarter-tile fragments', () => {
  const materials = new Map([[42, { flags: 1, color: [0.2, 0.7, 0.3], faces: { up: { tile: 17 } } }], [0, { flags: 128 }]]);
  const { effects } = create({ materials });
  effects.event({ type: 'world-event', data: { effectId: 2001, location: { x: -2, y: -40, z: 3 }, data: 42 } });
  assert.equal(effects.stats().active, 64); assert.equal(effects.particles[0].tile, 17);
  assert.deepEqual(effects.particles[0].color, [0.2, 0.7, 0.3]); assert.equal(effects.particles[0].uv[2] - effects.particles[0].uv[0], 0.25);
  effects.event({ type: 'world-event', data: { effectId: 2001, location: { x: 0, y: 0, z: 0 }, data: 0 } }); assert.equal(effects.stats().active, 64);
});

test('destroy effects follow sourced voxel-shape box subdivisions instead of emitting fragments in the air above a slab', () => {
  const materials = new Map([[17, { flags: 1, particleTile: 23, collisionBoxes: [[0, 0, 0, 1, 0.5, 1]], faces: { up: { tile: 9 } } }]]);
  const { effects } = create({ materials });
  effects.event({ type: 'world-event', data: { effectId: 2001, location: { x: -3, y: -40, z: 2 }, data: 17 } });
  assert.equal(effects.particles.length, 32);
  assert.ok(effects.particles.every(particle => particle.position[1] > -40 && particle.position[1] < -39.5));
  assert.ok(effects.particles.every(particle => particle.tile === 23));
});

test('weather follows biome precipitation, altitude snow line, roof height, server levels, and dimension skylight', () => {
  const plains = { temperature: 0.8, has_precipitation: true, dimension: 'overworld' }, frozen = { ...plains, temperature: 0.1 };
  assert.equal(precipitationFor(plains, 63), 'rain'); assert.equal(precipitationFor(frozen, 63), 'snow');
  assert.equal(precipitationFor({ ...plains, temperature: 0.2 }, 200), 'snow'); assert.equal(precipitationFor({ ...plains, has_precipitation: false }, 63), 'none');
  const atlas = { weatherTiles: new Map([['minecraft:environment/rain', 7], ['minecraft:environment/snow', 8]]) };
  const { effects, uploads } = create({ weatherRadius: 3, atlas, getHeight: x => x === 0 ? 100 : 0, getBiome: x => x < 0 ? frozen : plains });
  effects.event({ type: 'weather', reason: 'rain_level_change', value: 0.7 }); effects.event({ type: 'weather', reason: 8, value: 0.5 });
  effects.tick(0, { eye: [0, 5, 0], timeSeconds: 1 });
  assert.ok(effects.stats().rainColumns > 0); assert.ok(effects.stats().snowColumns > 0);
  assert.ok(effects.stats().rainColumns + effects.stats().snowColumns <= 49); const weather = uploads.get('minecraft-weather');
  assert.ok(weather.vertices.length); assert.ok(weather.bounds.max[1] <= 8); assert.ok(Array.from(weather.vertices).every(Number.isFinite));
  assert.equal(effects.weather().rainLevel, 0.7); assert.equal(effects.weather().thunderLevel, 0.5); assert.ok(effects.weather().fogMultiplier > 1);
  effects.tick(0.05, { eye: [0, 5, 0], timeSeconds: 2, hasSkylight: false }); assert.equal(uploads.has('minecraft-weather'), false);
  effects.event({ type: 'weather', reason: 'stop_raining', value: 0 }); assert.equal(effects.weather().rainLevel, 1);
  effects.tick(0.25, { eye: [0, 5, 0] }); assert.ok(effects.weather().rainLevel < 1);
});

test('rain starts and stops at native tick speed; lightning is short-lived and uploads are capped at 30 Hz', () => {
  const { effects } = create(); effects.event({ type: 'weather', reason: 1, value: 0 });
  effects.event({ type: 'lightning' }); assert.equal(effects.weather().lightningFlash, 1);
  effects.tick(0.01, { timeSeconds: 0.01 }); const uploads = effects.stats().uploads;
  effects.tick(0.01, { timeSeconds: 0.02 }); assert.equal(effects.stats().uploads, uploads);
  effects.tick(0.08, { timeSeconds: 0.1 }); assert.equal(effects.weather().lightningFlash, 0); assert.ok(Math.abs(effects.weather().rainLevel - 0.02) < 1e-9);
});
