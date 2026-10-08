import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const audioOnly = process.env.POMME_EFFECTS_AUDIO_ONLY === '1';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', ...(!audioOnly ? ['--enable-unsafe-webgpu', ...(process.env.POMME_SOFTWARE_GPU === '1' ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] : [])],
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.POMME_URL ?? 'http://127.0.0.1:5173';
  await page.goto(new URL('/src/audio.js', base).href);
  await page.evaluate(async () => {
    const { MinecraftAudio } = await import('/src/audio.js');
    const tone = new Uint8Array(await (await fetch('/tests/fixtures/generated-tone.ogg')).arrayBuffer());
    const registry = await (await fetch('/data/1.20.4-registry.json')).json();
    const definitions = { beep: { sounds: ['test/tone'], subtitle: 'subtitles.test.tone' }, music: { sounds: [{ name: 'test/tone', stream: true }] }, 'music_disc.13': { sounds: [{ name: 'test/tone', stream: true }] } };
    for (const event of ['block.stone.hit', 'block.stone.break', 'block.stone.place', 'block.stone.step', 'block.dispenser.dispense']) definitions[event] = { sounds: ['test/tone'] };
    const files = new Map([['assets/minecraft/sounds.json', new TextEncoder().encode(JSON.stringify(definitions))], ['assets/minecraft/sounds/test/tone.ogg', tone]]);
    window.audio = new MinecraftAudio({ registry, getEntityPosition: () => window.entityPosition });
    window.audio.applyPack(files); window.entityPosition = [1, 0, 0];
    const button = document.createElement('button'); button.id = 'unlock-audio'; button.textContent = 'Enable audio'; button.onclick = () => { void window.audio.unlock(); }; document.body.replaceChildren(button);
  });
  await page.click('#unlock-audio');
  await page.waitForFunction(() => window.audio.stats().unlocked);
  const audio = await page.evaluate(async () => {
    const audio = window.audio;
    audio.updateListener({ eye: [0, 0, 0], direction: [0, 0, -1] });
    const id = await audio.play('beep', { category: 'player', entityId: 1, range: 8 });
    if (!id) throw new Error(`Actual Vorbis decode failed: ${JSON.stringify(audio.stats())}`);
    const voice = audio.voices.get(id), buffer = voice.source.buffer;
    const analyser = audio.context.createAnalyser(); analyser.fftSize = 2048; audio.master.connect(analyser);
    const wave = new Float32Array(analyser.fftSize);
    let rms = 0;
    const until = performance.now() + 2000;
    while (performance.now() < until && rms < 0.005) {
      await new Promise(resolve => setTimeout(resolve, 25)); analyser.getFloatTimeDomainData(wave); rms = Math.sqrt(wave.reduce((sum, value) => sum + value * value, 0) / wave.length);
    }
    if (rms < 0.005) throw new Error(`Decoded Vorbis emitted no real Web Audio samples: RMS ${rms}`);
    window.entityPosition = [-2, 1, 3]; audio.tick();
    await new Promise(resolve => setTimeout(resolve, 30));
    if (Math.abs(voice.panner.positionX.value + 2) > 0.001 || Math.abs(voice.panner.positionY.value - 1) > 0.001) throw new Error(`Entity-linked real PannerNode did not follow native positions: ${voice.panner.positionX.value},${voice.panner.positionY.value}`);
    const stream = await audio.play('music', { category: 'music' });
    if (!stream) throw new Error(`Vorbis music stream failed: ${audio.stats().lastError}`);
    const streamElement = audio.voices.get(stream).element;
    const streamUntil = performance.now() + 2000;
    while (streamElement.currentTime < 0.05 && performance.now() < streamUntil) await new Promise(resolve => setTimeout(resolve, 25));
    if (streamElement.currentTime < 0.05) throw new Error('OGG music element did not actually advance');
    const streamTime = streamElement.currentTime;
    audio.stopPacket({ flags: 1, source: 1 });
    if (audio.voices.has(stream) || !audio.voices.has(id)) throw new Error('stop_sound must stop music and preserve another category');
    const stone = audio.registry.blocks.find(block => block.name === 'stone').minStateId;
    const hit = await audio.blockAction({ kind: 'hit', x: 0, y: 0, z: -2, stateId: stone });
    if (!hit || audio.voices.get(hit).source.playbackRate.value !== 0.5 || audio.voices.get(hit).gain.gain.value !== 0.25) throw new Error('Native mining SoundType must control actual OGG playback pitch and volume');
    const world = { generation: 1, core: { block_get: (x, y) => y === 0 ? stone : 0 } };
    const player = { position: [0, 1, 0], velocity: [4.3, 0, 0], grounded: true, fluid: null };
    audio.localTick(0.05, { player, world }); player.position[0] += 2; audio.localTick(0.05, { player, world });
    await new Promise(resolve => setTimeout(resolve, 25));
    if (![...audio.voices.values()].some(voice => voice.event === 'minecraft:block.stone.step')) throw new Error('Local travel must create an actual imported stone step voice');
    const dispenser = await audio.worldEvent({ effectId: 1000, location: { x: -1, y: 0, z: -3 }, data: 0, global: false });
    if (!dispenser || audio.voices.get(dispenser).event !== 'minecraft:block.dispenser.dispense') throw new Error('Pumpkin world-event mapping must dispatch a real imported sound');
    const disc = audio.registry.items.find(item => item.name === 'music_disc_13').id;
    const recordLocation = { x: 3, y: 0, z: 3 };
    const record = await audio.worldEvent({ effectId: 1010, location: recordLocation, data: disc });
    if (!record || audio.voices.get(record).category !== 'record' || !audio.voices.get(record).element) throw new Error('1.20.4 music-disc item IDs must start an actual streamed jukebox record');
    await audio.worldEvent({ effectId: 1010, location: recordLocation, data: 0 });
    if (audio.voices.has(record)) throw new Error('A zero jukebox data event must stop its actual streamed record');
    const result = { sampleRate: buffer.sampleRate, duration: buffer.duration, numberOfChannels: buffer.numberOfChannels, rms, streamedSeconds: streamTime, nativeHitPitch: audio.voices.get(hit).source.playbackRate.value, localStep: true, worldEvent: true, jukebox: true, stats: audio.stats() };
    analyser.disconnect(); audio.destroy(); return result;
  });

  const graphics = audioOnly ? null : await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    const { MinecraftEffects } = await import('/src/effects.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const canvas = document.createElement('canvas'); canvas.style.width = '320px'; canvas.style.height = '180px'; document.body.replaceChildren(canvas);
    const renderer = await createRenderer(canvas);
    const registry = await (await fetch('/data/1.20.4-registry.json')).json();
    const pixels = new Uint8Array(32 * 16 * 4);
    // Original test pixels: a rounded particle and sparse vertical rain/snow.
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
      const offset = (y * 32 + x) * 4; pixels.set([255, 255, 255, x < 16 ? Math.hypot(x - 7.5, y - 7.5) < 7 ? 255 : 0 : x % 5 === 0 && y % 6 < 4 ? 220 : 0], offset);
    }
    const atlas = { pixelsRGBA: pixels, width: 32, height: 16, tiles: [{ id: 0, x: 0, y: 0, width: 16, height: 16 }, { id: 1, x: 16, y: 0, width: 16, height: 16 }], particleFrames: new Map([['minecraft:dust', [0]], ['minecraft:end_rod', [0]]]), weatherTiles: new Map([['minecraft:environment/rain', 1], ['minecraft:environment/snow', 1]]) };
    renderer.setTextureAtlas(atlas); renderer.configureWorld({ min: [-16, -8, -16], max: [16, 32, 16], farPlane: 96 });
    const effects = new MinecraftEffects({ renderer, registry, atlas, random: () => 0.5, getHeight: () => 0, getBiome: x => ({ has_precipitation: true, temperature: x < 0 ? 0.1 : 0.8, dimension: 'overworld' }), weatherRadius: 5 });
    const frame = { eye: [0, 2, 4], yaw: 0, pitch: 0, timeSeconds: 0, dayPhase: 0.22, quality: 'low', scale: 1 };
    const half = value => { const sign = value & 32768 ? -1 : 1, exponent = value >> 10 & 31, mantissa = value & 1023; return sign * (exponent === 0 ? mantissa * 2 ** -24 : (1 + mantissa / 1024) * 2 ** (exponent - 15)); };
    const draw = async () => { renderer.render(frame); const image = await renderer.readPixels(); check(renderer.stats().lastError === null, renderer.stats().lastError); return image; };
    const changed = (before, after) => { let count = 0; for (let index = 0; index < before.pixels.length; index += 4) if (Math.max(...[0, 1, 2].map(channel => Math.abs(half(before.pixels[index + channel]) - half(after.pixels[index + channel])))) > 0.03) count++; return count; };
    try {
      const baseline = await draw(), staticShadows = renderer.stats().shadowUpdates;
      effects.spawn('dust', [0, 2, 0], [0, 0, 0], { red: 1, green: 0.02, blue: 0.01, scale: 4 }); effects.particles[0].emissive = true;
      effects.tick(0, { eye: frame.eye, direction: [0, 0, -1], timeSeconds: 0 });
      const particleImage = await draw(), particlePixels = changed(baseline, particleImage);
      check(particlePixels > 300, `Server particle mesh must alter real HDR pixels: ${particlePixels}`);
      const center = (Math.floor(particleImage.height / 2) * particleImage.width + Math.floor(particleImage.width / 2)) * 4;
      const fullColor = Array.from(particleImage.pixels.subarray(center, center + 3), half);
      effects.particles[0].age = Math.floor(effects.particles[0].lifetime * 0.9);
      effects.tick(0, { eye: frame.eye, direction: [0, 0, -1], timeSeconds: 0.1 });
      const fadedImage = await draw(), fadedColor = Array.from(fadedImage.pixels.subarray(center, center + 3), half);
      check(fadedColor[0] < fullColor[0] * 0.7, `Particle opacity must fade by lifetime: ${fullColor[0]} -> ${fadedColor[0]}`);
      check(renderer.stats().shadowUpdates === staticShadows, 'Particles must reuse cached opaque terrain shadows');
      effects.clear(); await draw();
      effects.event({ type: 'weather', reason: 'rain_level_change', value: 0.9 }); effects.tick(0, { eye: frame.eye, direction: [0, 0, -1], timeSeconds: 0.2 });
      const weatherImage = await draw(), weatherPixels = changed(baseline, weatherImage), weather = effects.stats();
      check(weatherPixels > 1000, `Rain/snow must render real HDR texture pixels: ${weatherPixels}`);
      check(weather.rainColumns > 0 && weather.snowColumns > 0, 'Actual biome temperatures must select both rain and snow');
      check(renderer.stats().shadowUpdates === staticShadows, 'Precipitation must preserve cached terrain shadows');
      const result = { particlePixels, fullColor, fadedColor, weatherPixels, weather, renderer: renderer.stats() };
      effects.destroy(); return result;
    } finally { renderer.destroy(); }
  });
  assert.deepEqual(errors, []);
  const result = { audio, graphics, browserErrors: errors };
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  await writeFile(new URL(audioOnly ? '../test-results/audio-local.json' : '../test-results/effects-audio.json', import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ oggSampleRate: audio.sampleRate, audioRMS: audio.rms, musicStreamSeconds: audio.streamedSeconds, nativeHitPitch: audio.nativeHitPitch, localStep: audio.localStep, worldEvent: audio.worldEvent, jukebox: audio.jukebox, particlePixels: graphics?.particlePixels, fadedRed: graphics?.fadedColor[0], fullRed: graphics?.fullColor[0], weatherPixels: graphics?.weatherPixels, rainColumns: graphics?.weather.rainColumns, snowColumns: graphics?.weather.snowColumns, errors }, null, 2));
} finally { await browser.close(); }
