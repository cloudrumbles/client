import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';
import { MinecraftSession } from '../src/minecraft.js';
import { MinecraftEffects } from '../src/effects.js';

function fixture(version) {
  const native = minecraftData(version), registry = { version: native.version, items: native.itemsArray, particles: native.particlesArray }, uploads = new Map(), events = [];
  const blockState = native.blocksByName.stone.defaultState;
  const effects = new MinecraftEffects({ registry, renderer: { removeMesh: name => uploads.delete(name), uploadDynamicMesh: (name, vertices) => uploads.set(name, vertices.slice()) },
    materials: new Map([[blockState, { particleTile: 23, color: [0.5, 0.5, 0.5] }]]), atlas: { itemTiles: new Map([['minecraft:item/diamond', 31]]) }, random: () => 0.25, isAir: () => true });
  const session = new MinecraftSession({ registry, onEvent(event) { events.push(event); effects.event(event); }, transport: { packet: () => true, close() {} } });
  Object.assign(session.state, { entityId: 9, status: 'playing' });
  const writer = minecraftProtocol.createSerializer({ state: 'play', isServer: true, version });
  const reader = minecraftProtocol.createDeserializer({ state: 'play', isServer: false, version });
  const receive = (name, params) => {
    const packet = { name, params }, bytes = Buffer.alloc(writer.proto.sizeOf(packet, writer.mainType));
    writer.proto.write(packet, bytes, 0, writer.mainType);
    const parsed = reader.parsePacketBuffer(bytes).data;
    session.receive({ type: 'packet', name: parsed.name, data: parsed.params });
    assert.equal(events.find(event => event.type === 'error'), undefined);
  };
  const spawn = (particle, extra = {}) => receive('world_particles', { longDistance: false, alwaysShow: false, x: 1, y: 2, z: -3, offsetX: 1, offsetY: -2, offsetZ: 3, velocityOffset: 0.5, amount: 0, particle, ...extra });
  return { native, blockState, session, effects, events, uploads, receive, spawn };
}

for (const version of ['1.21.11', '26.1']) {
  test(`${version} actual world-particle codec preserves directed and clustered count semantics`, () => {
    const { effects, events, spawn, uploads } = fixture(version);
    spawn({ type: 'smoke' });
    assert.equal(effects.particles.length, 1);
    assert.deepEqual(effects.particles[0].position, [1, 2, -3]);
    assert.deepEqual(effects.particles[0].velocity, [0.5, -1, 1.5]);
    const normalized = events.find(event => event.type === 'particles').data;
    assert.equal(normalized.particleName, 'smoke'); assert.equal(normalized.particles, 0); assert.equal(normalized.particleData, 0.5);
    spawn({ type: 'flame' }, { amount: 3, offsetX: 0, offsetY: 0, offsetZ: 0 });
    assert.equal(effects.particles.length, 4); assert.ok(effects.particles.slice(1).every(p => p.position.every((value, axis) => value === [1, 2, -3][axis])));
    effects.tick(0, { eye: [1, 2, 0] }); assert.ok(uploads.get('minecraft-particles').length > 0); assert.ok(Array.from(uploads.get('minecraft-particles')).every(Number.isFinite));
    assert.equal(effects.stats().unknownParticles, 0);
  });

  test(`${version} typed block, dust, ARGB effect, item and vibration options survive the wire`, () => {
    const { native, blockState, effects, spawn } = fixture(version);
    for (const type of ['block', 'block_marker', 'falling_dust', 'dust_pillar', 'block_crumble']) {
      spawn({ type, data: blockState }); assert.equal(effects.particles.at(-1).tile, 23, type);
    }
    spawn({ type: 'dust', data: { color: 0x336699, scale: 1.5 } });
    assert.deepEqual(effects.particles.at(-1).color, [0.2, 0.4, 0.6]); assert.ok(Math.abs(effects.particles.at(-1).size - 0.15) < 1e-12);
    spawn({ type: 'dust_color_transition', data: { fromColor: 0xff0000, toColor: 0x0000ff, scale: 2 } });
    assert.deepEqual(effects.particles.at(-1).color, [1, 0, 0]); assert.deepEqual(effects.particles.at(-1).colorTo, [0, 0, 1]);
    spawn({ type: 'entity_effect', data: 0x806633cc | 0 });
    assert.deepEqual(effects.particles.at(-1).color, [0.4, 0.2, 0.8]); assert.equal(effects.particles.at(-1).alpha, 128 / 255);
    const item = { itemId: native.itemsByName.diamond.id, itemCount: 1, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'custom_model_data', data: { floats: [2], flags: [], strings: [], colors: [] } }], removeComponents: [] };
    spawn({ type: 'item', data: item }); assert.equal(effects.particles.at(-1).tile, 31);
    spawn({ type: 'vibration', data: { positionType: 'block', position: { x: 4, y: 5, z: 6 }, ticks: 10 } });
    assert.deepEqual(effects.particles.at(-1).vibration, { x: 4, y: 5, z: 6 }); assert.equal(effects.particles.at(-1).vibrationTicks, 10);
    spawn({ type: 'shriek', data: 12 }); assert.equal(effects.particles.at(-1).delay, 12);
  });

  test(`${version} explosion block sprays share typed-option conversion and imported texture sampling`, () => {
    const { blockState, effects, receive, events } = fixture(version);
    receive('explosion', { center: { x: 1, y: 2, z: -3 }, radius: 2, blockCount: 1, playerKnockback: undefined, explosionParticle: { type: 'explosion' }, sound: { data: { soundName: 'minecraft:entity.generic.explode' } },
      blockParticles: [{ data: { particle: { type: 'block', data: blockState }, scaling: 1, speed: 1 }, weight: 1 }] });
    effects.step(); const fragment = effects.particles.find(p => p.name === 'block');
    assert.ok(fragment); assert.equal(fragment.tile, 23); assert.deepEqual(fragment.color, [0.5, 0.5, 0.5]);
    assert.deepEqual(events.find(event => event.type === 'explosion-block-effects').blockParticles[0].data.particle.data, { blockState });
  });
}
