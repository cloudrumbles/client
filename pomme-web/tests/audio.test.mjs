import { test } from 'node:test';
import assert from 'node:assert/strict';
import minecraftData from 'minecraft-data';
import { readFile } from 'node:fs/promises';
import { zipSync } from '../vendor/fflate.js';
import { SoundLibrary, SoundRandom, MinecraftAudio, loadAudioPack, resolveSoundPacket, WORLD_EVENT_SOUNDS } from '../src/audio.js';

const enc = new TextEncoder();
const registration = definitions => enc.encode(JSON.stringify(definitions));
const fixture = (definitions = { beep: { sounds: ['test/tone'], subtitle: 'subtitles.test.tone' } }) => new Map([
  ['assets/minecraft/sounds.json', registration(definitions)], ['assets/minecraft/sounds/test/tone.ogg', new Uint8Array([1, 2, 3, 4])],
]);

test('sound pack stacking respects replace, namespace, event weights, redirects, and subtitle inheritance', () => {
  const library = new SoundLibrary();
  library.applyPack(fixture({ beep: { sounds: [{ name: 'test/tone', weight: 2 }], subtitle: 'subtitles.test.tone' }, alias: { sounds: [{ name: 'beep', type: 'event', volume: 0.5, pitch: 2, stream: true }] } }));
  assert.equal(library.weight('minecraft:beep'), 2);
  const selected = library.choose('alias', 123n);
  assert.equal(selected.event, 'minecraft:alias'); assert.equal(selected.name, 'minecraft:test/tone');
  assert.equal(selected.volume, 0.5); assert.equal(selected.pitch, 2); assert.equal(selected.stream, true); assert.equal(selected.subtitle, 'subtitles.test.tone');
  library.applyPack(new Map([['assets/minecraft/sounds.json', registration({ beep: { sounds: [{ name: 'test/tone', weight: 3 }] } })]]));
  assert.equal(library.weight('minecraft:beep'), 5);
  library.applyPack(new Map([['assets/minecraft/sounds.json', registration({ beep: { replace: true, sounds: [] } })]]));
  assert.equal(library.choose('beep', 1n), null);
  library.applyPack(new Map([['assets/demo/sounds.json', registration({ beep: { sounds: ['demo:custom'] } })], ['assets/demo/sounds/custom.ogg', new Uint8Array([1])]]));
  assert.equal(library.choose('demo:beep', 1n).name, 'demo:custom');
});

test('cyclic redirects and missing sound files stay unavailable, and invalid packs do not partially mutate the library', () => {
  const library = new SoundLibrary({ maxFileBytes: 8, maxBytes: 12 });
  library.applyPack(fixture({ a: { sounds: [{ name: 'b', type: 'event' }] }, b: { sounds: [{ name: 'a', type: 'event' }] }, missing: { sounds: ['not_supplied'] } }));
  assert.equal(library.choose('a', 0n), null); assert.equal(library.stats().unavailableEvents, 3);
  const before = library.stats();
  assert.throws(() => library.applyPack(fixture({ bad: { sounds: [{ name: '../escape' }] } })), /Invalid sound resource/);
  assert.deepEqual(library.stats(), before);
  assert.throws(() => library.applyPack(new Map([['assets/minecraft/sounds/large.ogg', new Uint8Array(9)]])), /file limit/);
  assert.throws(() => library.applyPack(fixture({ bad: { sounds: [{ name: 'test/tone', weight: 0 }] } })), /weight/);
});

test('seeded Java sound randomness matches known java.util.Random outputs', () => {
  const random = new SoundRandom(0n);
  assert.deepEqual(Array.from({ length: 5 }, () => random.nextInt(100)), [60, 48, 29, 47, 15]);
  assert.equal(random.nextInt(0), null);
});

test('sound protocol holders have distinct decoded versus raw entity registry indexes and fixed-point coordinates', () => {
  const registry = { sounds: minecraftData('1.20.4').soundsArray };
  const numeric = resolveSoundPacket('sound_effect', { sound: { soundId: 0 }, soundCategory: 'neutral', x: -9, y: -160, z: 27, volume: 1, pitch: 1, seed: -1n }, registry);
  assert.equal(numeric.event, 'minecraft:entity.allay.ambient_with_item'); assert.deepEqual(numeric.position, [-1.125, -20, 3.375]);
  const entity = resolveSoundPacket('entity_sound_effect', { soundId: 1, entityId: 77, soundCategory: 5, volume: 2, pitch: 0.5 }, registry);
  assert.equal(entity.event, numeric.event); assert.equal(entity.category, 'hostile'); assert.equal(entity.entityId, 77);
  const inline = resolveSoundPacket('sound_effect', { sound: { data: { soundName: 'demo:beep', fixedRange: 3 } }, soundCategory: 'player', x: 0, y: 0, z: 0, volume: 1, pitch: 1 }, registry);
  assert.equal(inline.event, 'demo:beep'); assert.equal(inline.range, 3);
  const inlineEntity = resolveSoundPacket('entity_sound_effect', { soundId: 0, soundEvent: { resource: 'demo:beep', range: 5 }, soundCategory: 'player', entityId: 1, volume: 1, pitch: 1 }, registry);
  assert.equal(inlineEntity.range, 5);
});

test('audio-only archive import selects sounds, rejects unsafe names, and does not depend on block assets', async () => {
  const zip = zipSync(Object.fromEntries([...fixture(), ['assets/minecraft/textures/block/unused.png', new Uint8Array([1])]]));
  const files = await loadAudioPack(zip);
  assert.equal(files.size, 2); assert.equal(new SoundLibrary().applyPack(files).files, 1);
  await assert.rejects(() => loadAudioPack(zip, { maxBytes: 10 }), /archive limit/);
  await assert.rejects(() => loadAudioPack(zipSync({ 'assets/minecraft/sounds/../bad.ogg': new Uint8Array([1]) })), /safe asset/);
});

class Parameter {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
}
class Node {
  constructor() { this.gain = new Parameter(1); this.connections = []; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.connections.length = 0; }
}
class Context {
  constructor() {
    this.state = 'suspended'; this.currentTime = 0; this.destination = new Node(); this.sources = []; this.decodeCount = 0;
    this.listener = Object.fromEntries(['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'].map(name => [name, new Parameter()]));
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
  createGain() { return new Node(); }
  createPanner() { return Object.assign(new Node(), { positionX: new Parameter(), positionY: new Parameter(), positionZ: new Parameter() }); }
  createBufferSource() { const source = Object.assign(new Node(), { playbackRate: new Parameter(), start() { this.started = true; }, stop() { this.stopped = true; } }); this.sources.push(source); return source; }
  async decodeAudioData() { this.decodeCount++; return { length: 100, numberOfChannels: 2, duration: 1 }; }
}

test('gesture unlock, listener orientation, entity following, category volume, stop_sound, and voice limits work together', async () => {
  const context = new Context(); let entityPosition = [2, 4, 6];
  const audio = new MinecraftAudio({ contextFactory: () => context, getEntityPosition: () => entityPosition, maxVoices: 2, now: () => 0 });
  audio.applyPack(fixture()); await audio.play('beep', { category: 'player' }); assert.equal(context.sources.length, 0); assert.equal(audio.stats().queued, 1);
  assert.equal(await audio.unlock(), true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.sources.length, 1);
  audio.updateListener({ eye: [-2, 1, -3], direction: [0, 0, 1] }); assert.equal(context.listener.positionX.value, -2); assert.equal(context.listener.forwardZ.value, 1);
  const entityId = await audio.play('beep', { category: 'hostile', entityId: 3, range: 100 });
  const voice = audio.voices.get(entityId); assert.equal(voice.panner.positionY.value, 4);
  entityPosition = [-5, 7, 9]; audio.tick(); assert.equal(voice.panner.positionX.value, -5);
  audio.setVolume('master', 0.5); audio.setVolume('hostile', 0.25);
  assert.equal(audio.master.gain.value, 0.5); assert.equal(audio.categoryNodes.get('hostile').gain.value, 0.25);
  const newest = await audio.play('beep', { category: 'weather' }); assert.equal(audio.voices.size, 2); assert.equal(context.sources[0].stopped, true); assert.equal(context.decodeCount, 1);
  audio.stopPacket({ flags: 3, source: 5, sound: 'minecraft:beep' }); assert.equal(audio.voices.has(entityId), false); assert.equal(audio.voices.has(newest), true);
  audio.stopPacket({ flags: 0 }); assert.equal(audio.stats().voices, 0);
  audio.destroy(); assert.equal(context.state, 'closed');
});

test('stop_sound cancels sound decoding still in flight, while another category is preserved', async () => {
  const context = new Context(); let release;
  context.decodeAudioData = () => new Promise(resolve => { release = resolve; });
  const audio = new MinecraftAudio({ contextFactory: () => context }); audio.applyPack(fixture()); await audio.unlock();
  const first = audio.play('beep', { category: 'player' }); const second = audio.play('beep', { category: 'weather' });
  audio.stopPacket({ flags: 1, source: 7 }); release({ length: 100, numberOfChannels: 1, duration: 1 });
  assert.equal(await first, null); assert.ok(await second); assert.equal(audio.stats().voices, 1);
  audio.destroy();
});

test('decoded cache budget cannot evict live voice buffers or retain oversized decoded files', async () => {
  const context = new Context(); const audio = new MinecraftAudio({ contextFactory: () => context, maxDecodedBytes: 800 });
  audio.applyPack(new Map([...fixture({ beep: { sounds: ['test/tone'] }, other: { sounds: ['test/other'] } }), ['assets/minecraft/sounds/test/other.ogg', new Uint8Array([2])]])); await audio.unlock();
  assert.ok(await audio.play('beep'));
  assert.equal(await audio.play('other'), null); assert.equal(audio.stats().decodedBytes, 800);
  audio.stop(); assert.ok(await audio.play('other')); assert.equal(audio.stats().decodedBytes, 800);
  audio.destroy();
});

test('changing music context cancels an old track that is still decoding', async () => {
  const context = new Context(); let release;
  context.decodeAudioData = () => new Promise(resolve => { release = resolve; });
  const audio = new MinecraftAudio({ contextFactory: () => context, now: () => 0 });
  audio.applyPack(fixture({ 'music.menu': { sounds: ['test/tone'] } })); await audio.unlock();
  audio.setMusicMode('menu'); audio.tick(); audio.setMusicMode('none');
  release({ length: 100, numberOfChannels: 1, duration: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(audio.stats().voices, 0); assert.equal(audio.musicVoice, null); assert.equal(context.sources[0].stopped, true);
  audio.destroy();
});

test('native SoundType table resolves signed native state IDs and applies real hit/break/place/step volume and pitch', async () => {
  const data = minecraftData('1.20.4'), blockSounds = JSON.parse(await readFile(new URL('../src/block-sounds.json', import.meta.url), 'utf8'));
  const audio = new MinecraftAudio({ registry: { blocks: data.blocksArray, blockSounds } });
  const played = []; audio.play = async (event, options) => { played.push({ event, options }); return played.length; };
  audio.library.applyPack(fixture({ 'block.metal.step': { sounds: ['test/tone'] }, 'block.metal.place': { sounds: ['test/tone'] } }));
  const stateId = data.blocksByName.gold_block.minStateId;
  await audio.blockAction({ kind: 'hit', x: -2, y: -40, z: 3, stateId });
  await audio.blockAction({ kind: 'break', x: -2, y: -40, z: 3, stateId });
  await audio.blockAction({ kind: 'place', x: -2, y: -40, z: 3, stateId });
  await audio.blockAction({ kind: 'step', x: -2, y: -40, z: 3, stateId });
  assert.deepEqual(played.map(value => value.event), ['block.metal.hit', 'block.metal.break', 'block.metal.place', 'block.metal.step']);
  assert.deepEqual(played.map(value => [value.options.volume, value.options.pitch]), [[0.25, 0.75], [1, 1.2000000000000002], [1, 1.2000000000000002], [0.15, 1.5]]);
  assert.deepEqual(played[0].options.position, [-1.5, -39.5, 3.5]);
  assert.equal(await audio.blockAction({ kind: 'break', x: 0, y: 0, z: 0, stateId: data.blocksByName.water.minStateId }), null);
  assert.equal(await audio.blockAction({ kind: 'step', x: 0, y: 0, z: 0, stateId: data.blocksByName.amethyst_block.minStateId }), null, 'Unprovided step assets must not be invented');
});

test('Pumpkin world-event sounds all exist in the target native sound registry and dispatch actual event locations', async () => {
  const data = minecraftData('1.20.4'), audio = new MinecraftAudio({ registry: { sounds: data.soundsArray } });
  for (const [id, [name]] of Object.entries(WORLD_EVENT_SOUNDS)) assert.ok(data.soundsByName[name], `${id}: ${name}`);
  const played = []; audio.play = async (event, options) => { played.push({ event, options }); return played.length; };
  await audio.worldEvent({ effectId: 1000, location: { x: -1, y: -50, z: 30 }, data: 0, global: false });
  assert.equal(played[0].event, 'block.dispenser.dispense'); assert.deepEqual(played[0].options.position, [-0.5, -49.5, 30.5]);
  await audio.worldEvent({ effectId: 1023, location: { x: 40000, y: 10, z: 40000 }, data: 0, global: true });
  assert.equal(played[1].event, 'entity.wither.spawn'); assert.equal(played[1].options.position, null);
  assert.equal(await audio.worldEvent({ effectId: 9999, location: { x: 0, y: 0, z: 0 } }), null);
});

test('local movement sounds follow distance and actual block type, suppress sneak/fly/teleport footsteps, and track water/fall transitions', async () => {
  const data = minecraftData('1.20.4'), blockSounds = JSON.parse(await readFile(new URL('../src/block-sounds.json', import.meta.url), 'utf8'));
  const audio = new MinecraftAudio({ registry: { blocks: data.blocksArray, blockSounds } });
  audio.library.applyPack(fixture({ 'block.wood.step': { sounds: ['test/tone'] } }));
  const played = []; audio.play = async (event, options) => { played.push({ event, options }); return played.length; };
  const world = { generation: 1, core: { block_get: (x, y) => y === 0 ? data.blocksByName.oak_planks.minStateId : 0 } };
  const player = { position: [0, 1, 0], velocity: [4.3, 0, 0], grounded: true, fluid: null, eyesInWater: false, fallDistance: 0 };
  audio.localTick(0.05, { player, world });
  player.position[0] += 1; audio.localTick(0.05, { player, world }); assert.equal(played.length, 0);
  player.position[0] += 1; audio.localTick(0.05, { player, world }); assert.equal(played[0].event, 'block.wood.step');
  player.sneaking = true; player.position[0] += 2; audio.localTick(0.05, { player, world }); assert.equal(played.length, 1);
  player.sneaking = false; player.fly = true; player.position[0] += 2; audio.localTick(0.05, { player, world }); assert.equal(played.length, 1);
  player.fly = false; player.position[0] += 50; audio.localTick(0.05, { player, world }); assert.equal(played.length, 1);
  player.fluid = 'water'; player.velocity = [0, -8, 0]; audio.localTick(0.05, { player, world }); assert.equal(played[1].event, 'entity.player.splash');
  player.eyesInWater = true; audio.localTick(0.05, { player, world }); assert.equal(played[2].event, 'ambient.underwater.enter');
  player.fluid = null; player.eyesInWater = false; player.grounded = false; player.fallDistance = 7; audio.localTick(0.05, { player, world });
  player.grounded = true; player.fallDistance = 0; audio.localTick(0.05, { player, world }); assert.equal(played.at(-1).event, 'entity.player.big_fall');
  world.generation++; player.position[0] += 3; audio.localTick(0.05, { player, world }); assert.equal(played.at(-1).event, 'entity.player.big_fall', 'World resets must not synthesize a step');
});

test('1.20.4 jukebox level events play imported disc sounds and stop the record at its source', async () => {
  const data = minecraftData('1.20.4'), context = new Context();
  const audio = new MinecraftAudio({ registry: { items: data.itemsArray }, contextFactory: () => context });
  audio.applyPack(fixture({ 'music_disc.13': { sounds: ['test/tone'] } })); await audio.unlock();
  const location = { x: 2, y: 1, z: 3 };
  const id = await audio.worldEvent({ effectId: 1010, location, data: data.itemsByName.music_disc_13.id });
  assert.ok(id); assert.equal(audio.voices.get(id).range, 64); assert.equal(audio.voices.get(id).category, 'record');
  await audio.worldEvent({ effectId: 1010, location, data: 0 }); assert.equal(audio.voices.has(id), false); assert.equal(audio.records.size, 0);
  audio.destroy();
});

test('switching the selected native registry refreshes state-ID lookups instead of retaining another version mapping', () => {
  const audio = new MinecraftAudio({ registry: { blocks: [{ name: 'stone', minStateId: 1, maxStateId: 1 }] } });
  assert.equal(audio.blockDefinition(1).name, 'stone');
  audio.registry = { blocks: [{ name: 'oak_planks', minStateId: 1, maxStateId: 2 }] };
  assert.equal(audio.blockDefinition(1).name, 'oak_planks'); assert.equal(audio.blockDefinition(2).name, 'oak_planks');
});
