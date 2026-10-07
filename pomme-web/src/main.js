import { createRenderer } from './renderer.js';
import { loadCore } from './wasm.js';
import { Player } from './player.js';
import { ResolutionController, summarizeFrames, summarizeGpuTimes } from './performance.js';
import { BrowserWorld } from './world.js';
import { loadMinecraftRegistry } from './registry.js';
import { loadResourcePack } from './assets.js';
import { importAnvil, importLevelDat } from './anvil.js';
import { MinecraftSession } from './minecraft.js';
import { EntityScene } from './entities.js';
import { ServerGameplay } from './gameplay.js';
import { storeResourcePack, restoreResourcePack } from './pack-store.js';

const $ = id => document.getElementById(id);
const seed = 1650;
let saveKey = 'pomme-web-world-v1';
const keys = new Set();
const edits = new Map();
let renderer, core, player, world, registry, pack, session, entities, gameplay, ready = false, locked = false;
let mode = 'demo', operations = Promise.resolve(), serverDimension = null, serverStatus = null, loadingWorld = false;
let selected = 1, scale = 0.85, phase = 0.22, revision = 0;
let controller = new ResolutionController(scale);
let lastTime = 0, accumulator = 0, hudAt = 0, frames = [], benchmark = null, lastResult = null;
let saveTimer;
let saveDirty = false;

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  ready = false;
  if (benchmark) finishBenchmark(true);
  world?.destroy(); session?.disconnect(); gameplay?.close();
  renderer?.destroy();
  for (const id of ['play', 'resume', 'benchmark']) $(id).disabled = true;
  $('error').hidden = false; $('error').textContent = message;
  $('world-status').textContent = 'Stopped';
  if (document.pointerLockElement) document.exitPointerLock();
  console.error(error);
  document.documentElement.dataset.engine = 'error';
}
function persistedEdits() {
  try {
    const stored = JSON.parse(localStorage.getItem(saveKey) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter(b => Array.isArray(b) && b.length === 4 && b.every(Number.isInteger) && b[3] >= 0 && b[3] <= (mode === 'demo' ? 8 : 65535) && (mode !== 'demo' || (b[0] >= 0 && b[0] < 128 && b[1] >= 0 && b[1] < 64 && b[2] >= 0 && b[2] < 128)));
  } catch { return []; }
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!saveDirty) return;
  try { localStorage.setItem(saveKey, JSON.stringify([...edits.values()])); saveDirty = false; }
  catch { $('world-status').textContent = 'Save storage is full; this session remains playable'; }
}
function saveImportedLocation() {
  if (mode !== 'import' || !ready || loadingWorld || benchmark) return;
  try {
    const previous = JSON.parse(localStorage.getItem('pomme-last-import') || 'null');
    if (previous?.worldKey === world.worldKey) localStorage.setItem('pomme-last-import', JSON.stringify({ ...previous, spawn: player.position, phase }));
  } catch {}
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function edit(x, y, z, id) {
  if (mode === 'server' || !world.setBlock(x, y, z, id)) return false;
  const block = [x, y, z, id];
  edits.set(`${x},${y},${z}`, block);
  saveDirty = true;
  // Invalidate shadows when the worker uploads the corresponding geometry.
  save();
  return true;
}
function select(id) {
  selected = id;
  document.querySelectorAll('[data-block]').forEach(button => {
    const active = Number(button.dataset.block) === id;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
}
function status(message) { $('world-status').textContent = message; }
function enqueue(action) {
  operations = operations.then(action).catch(error => { loadingWorld = false; status(error.message); console.error(error); });
  return operations;
}
function switchSaveKey(next) { flushSave(); edits.clear(); saveDirty = false; saveKey = next; }
function nativeHotbar() {
  const names = ['grass_block', 'stone', 'oak_planks', 'sand', 'oak_leaves', 'glowstone'];
  document.querySelectorAll('[data-block]').forEach((button, index) => {
    button.dataset.block = registry.blocks.find(block => block.name === names[index])?.defaultState ?? 0;
  });
  select(Number(document.querySelector('[data-block]').dataset.block));
}
async function loadPack(file) {
  registry ??= await loadMinecraftRegistry();
  status('Loading block models and textures…');
  const next = await loadResourcePack(file, { registry });
  pack = next;
  let cacheWarning = '';
  try { await storeResourcePack(file); } catch (error) { cacheWarning = ` · cache unavailable: ${error.message}`; }
  renderer.setTextureAtlas(next.atlas);
  $('pack-status').textContent = `${next.materials.size.toLocaleString()} block states · ${next.atlas.tiles.length} textures${next.diagnostics.unsupportedStates ? ` · ${next.diagnostics.unsupportedStates} placeholder states` : ''}${cacheWarning}`;
  // Replace both WASM registries together and remesh loaded columns.
  if (mode !== 'demo') {
    const columns = [...world.columns.values()], bounds = world.bounds();
    await world.reset({ registry, materials: pack.materials, minY: bounds.min[1], height: bounds.max[1] - bounds.min[1], originX: bounds.min[0] / 16, originZ: bounds.min[2] / 16, hasSkylight: world.hasSkylight, worldKey: world.worldKey, mode });
    if (mode === 'import') world.setOverlay(persistedEdits());
    for (const column of columns) world.ingestColumn(column);
    entities?.clear();
    if (mode === 'server') {
      entities = new EntityScene({ renderer, registry, materials: pack.materials, atlas: pack.atlas });
      for (const entity of session.entities.values()) entities.consume({ type: 'spawn', entity });
    }
  }
  status('Minecraft textures and models loaded');
  return next;
}
async function resumeImported() {
  const saved = JSON.parse(localStorage.getItem('pomme-last-import') || 'null');
  if (!saved?.worldKey || !Array.isArray(saved.spawn) || !saved.spawn.every(Number.isFinite)) throw new Error('No saved Java world is available.');
  registry ??= await loadMinecraftRegistry();
  if (!pack) { const cached = await restoreResourcePack(); if (cached) await loadPack(cached); }
  session?.disconnect(); gameplay?.close(); gameplay = null; entities?.clear(); entities = null;
  mode = 'import'; loadingWorld = true; ready = false;
  switchSaveKey(`pomme-web-edits:${saved.worldKey}`);
  await world.reset({ registry, materials: pack?.materials, originX: Math.floor(saved.spawn[0] / 16) - 8, originZ: Math.floor(saved.spawn[2] / 16) - 8, worldKey: saved.worldKey, mode });
  world.setOverlay(persistedEdits());
  if (!world.store.keys().length) throw new Error('The saved chunks were evicted from browser storage. Import the region files again.');
  await world.restoreNearColumns(); nativeHotbar(); player.setPosition(saved.spawn); player.fly = false;
  for (const block of persistedEdits()) { world.setBlock(...block); edits.set(block.slice(0, 3).join(','), block); }
  phase = saved.phase ?? 0.22; loadingWorld = false; ready = true;
  $('play').disabled = false; $('welcome').hidden = true; $('pause').hidden = false;
  status(`${saved.name} · restored from browser storage`);
}
async function importFiles(files) {
  registry ??= await loadMinecraftRegistry();
  session?.disconnect(); gameplay?.close(); gameplay = null; entities?.clear(); entities = null;
  if (document.pointerLockElement) document.exitPointerLock();
  const regions = [...files].filter(file => /\.mca$/i.test(file.name));
  if (!regions.length) throw new Error('Select one or more r.x.z.mca files from your Java world’s region folder.');
  if (regions.length > 64 || regions.reduce((sum, file) => sum + file.size, 0) > 256 * 1024 * 1024) throw new Error('Import at most 64 region files, totaling 256 MB.');
  const level = [...files].find(file => file.name === 'level.dat');
  const metadata = level ? await importLevelDat(level) : null;
  const first = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(regions[0].name);
  if (!first) throw new Error('Keep the original r.x.z.mca region filenames.');
  const spawn = metadata?.spawn ?? [Number(first[1]) * 512 + 8, 100, Number(first[2]) * 512 + 8];
  mode = 'import'; serverDimension = null;
  const worldKey = `import:${regions.map(file => `${file.name}:${file.size}:${file.lastModified}`).sort().join('|')}`;
  switchSaveKey(`pomme-web-edits:${worldKey}`);
  loadingWorld = true; ready = false; $('play').disabled = true;
  await world.reset({ registry, materials: pack?.materials, originX: Math.floor(spawn[0] / 16) - 8, originZ: Math.floor(spawn[2] / 16) - 8, worldKey, mode });
  world.setOverlay(persistedEdits());
  nativeHotbar();
  let count = 0, skipped = 0, firstOccupied = null;
  for (const file of regions) {
    const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(file.name);
    if (!match) throw new Error(`Invalid region filename: ${file.name}`);
    status(`Importing ${file.name}…`);
    const result = await importAnvil(file, { regionX: Number(match[1]), regionZ: Number(match[2]), registry, onSection: section => {
      if (!firstOccupied) {
        const index = section.states.findIndex(id => !(world.materialRegistry.materials.get(id)?.flags & 128));
        if (index >= 0) firstOccupied = [section.cx * 16 + index % 16 + 0.5, 100, section.cz * 16 + (Math.floor(index / 16) % 16) + 0.5];
      }
      return world.ingestSection(section);
    } });
    count += result.chunks; skipped += result.diagnostics.skippedChunks.length;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await world.finishImport();
  for (const block of persistedEdits()) { world.setBlock(...block); edits.set(block.slice(0, 3).join(','), block); }
  if (!metadata || !core.world_column_loaded(Math.floor(spawn[0] / 16), Math.floor(spawn[2] / 16))) {
    if (!firstOccupied) throw new Error('The selected region files contain no visible terrain.');
    spawn.splice(0, 3, ...firstOccupied); world.updateCamera(spawn);
    await world.restoreNearColumns();
    spawn[1] = core.terrain_height(Math.floor(spawn[0]), Math.floor(spawn[2])) + 2;
  }
  player.setPosition(spawn); player.fly = false;
  phase = metadata?.dayTime != null ? Number(BigInt(metadata.dayTime) % 24000n) / 24000 : 0.22;
  loadingWorld = false; ready = true; $('play').disabled = false; $('welcome').hidden = true; $('pause').hidden = false;
  try { localStorage.setItem('pomme-last-import', JSON.stringify({ worldKey, spawn: player.position, phase, name: metadata?.name || 'Java world' })); } catch {}
  status(`${metadata?.name || 'Java world'} · ${count} chunks imported${skipped ? ` · ${skipped} unsupported entries` : ''}`);
  return { chunks: count, skipped };
}
async function connectServer(options) {
  registry ??= await loadMinecraftRegistry();
  session?.disconnect(); gameplay?.close(); entities?.clear();
  mode = 'server'; serverDimension = null; serverStatus = null; switchSaveKey('pomme-web-server-no-local-edits');
  ready = false;
  $('connection-status').textContent = 'Connecting…'; $('account-code').hidden = true;
  session = new MinecraftSession({ registry,
    onState: state => {
      $('connection-status').textContent = `${state.status}${state.reason ? ` · ${state.reason}` : ''}`;
      $('disconnect').hidden = state.status === 'disconnected'; gameplay?.state(state);
      const dimensionKey = `${state.dimension}:${state.minY}:${state.height}:${state.hasSkylight}`;
      if (state.status === 'loading' && (serverStatus !== 'loading' || serverDimension !== dimensionKey)) {
        serverDimension = dimensionKey;
        enqueue(async () => {
          entities?.clear();
          await world.reset({ registry, materials: pack?.materials, minY: state.minY, height: state.height, hasSkylight: state.hasSkylight, worldKey: `server:${options.host}:${options.port || 25565}:${state.dimension}`, mode });
          nativeHotbar();
        });
      }
      serverStatus = state.status;
      if (state.status === 'playing') { $('welcome').hidden = true; $('pause').hidden = locked; }
    },
    onColumn: column => enqueue(() => world.ingestColumn(column)),
    onBlock: block => enqueue(() => world.setBlock(block.x, block.y, block.z, block.stateId)),
    onUnload: column => enqueue(() => world.unload(column.x, column.z)),
    onPosition: position => enqueue(() => { player.setPosition([position.x, position.y, position.z], position); world.updateCamera(player.eye); ready = true; }),
    onTime: time => { phase = ((Number(time.timeOfDay) / 24000) + 1) % 1; $('cycle').checked = time.daylightCycle; },
    onInventory: inventory => gameplay?.inventory(inventory),
    onEntity: event => enqueue(() => entities?.consume(event)),
    onEvent: event => {
      gameplay?.event(event);
      if (event.type === 'light') enqueue(() => world.loadLight(event.x, event.z, event.light));
      if (event.type === 'msa-code') {
        $('account-code').hidden = false; $('account-code-text').textContent = event.userCode;
        const url = new URL(event.verificationUri || 'https://www.microsoft.com/link');
        if (url.protocol === 'https:') $('account-link').href = url.href;
      } else if (event.type === 'error') { $('connection-status').textContent = event.message; status(event.message); }
    },
  });
  gameplay = new ServerGameplay({ session, registry, player, world, onStatus: status, getEntities: () => entities });
  entities = new EntityScene({ renderer, registry, materials: pack?.materials, atlas: pack?.atlas });
  await session.connect(options.gateway || $('server-gateway').value, options);
  return session;
}
async function lock() {
  if (!ready) return;
  try { await $('world').requestPointerLock(); }
  catch { $('world-status').textContent = 'Click Enter world again to capture the mouse'; }
}
function startBenchmark() {
  if (!ready || benchmark) return;
  if (mode === 'server') { $('benchmark-status').textContent = 'Disconnect before running the fixed camera benchmark.'; return; }
  benchmark = { start: performance.now(), frames: [], gpu: [], lastGpuSample: renderer.stats().gpuSampleCount, saved: { position: [...player.position], yaw: player.yaw, pitch: player.pitch, phase, adaptive: $('adaptive').checked, cycle: $('cycle').checked } };
  // Hold settings constant so exported runs are reproducible and comparable.
  $('adaptive').checked = false; $('cycle').checked = false; phase = 0.22;
  $('welcome').hidden = true; $('pause').hidden = true;
  for (const id of ['quality', 'resolution', 'adaptive', 'cycle', 'sun']) $(id).disabled = true;
  $('benchmark-status').textContent = 'Running fixed camera route: 30 seconds';
  $('benchmark').disabled = true;
}
function finishBenchmark(cancelled = false, cancellationReason = 'tab hidden or renderer stopped') {
  if (!benchmark) return;
  const stats = renderer.stats();
  lastResult = { schemaVersion: 2, build: 'pomme-web-minecraft', timestamp: new Date().toISOString(), seed, worldMode: mode, worldRevision: core.world_revision(), editCount: edits.size, cancelled, durationSeconds: (performance.now() - benchmark.start) / 1000, quality: $('quality').value, outputPixels: [$('world').width, $('world').height], renderPixels: [stats.renderWidth, stats.renderHeight], scale, dayPhase: phase, clock: 'requestAnimationFrame intervals (includes browser pacing)', frames: summarizeFrames(benchmark.frames), gpuClock: benchmark.gpu.length ? 'WebGPU timestamp-query' : 'unavailable', gpu: summarizeGpuTimes(benchmark.gpu), renderer: stats, distantTerrain: world.distant?.stats(), userAgent: navigator.userAgent, limits: 'WebGPU shaders inspired by Photon; original GLSL packs and Java mods are not directly loaded. Hardware results must be measured on the target GPU.' };
  if (cancelled) lastResult.cancellationReason = cancellationReason;
  lastResult.samples = { frameIntervalsMs: [...benchmark.frames], gpuDurationsMs: [...benchmark.gpu] };
  lastResult.localLighting = world.lightingStats();
  const saved = benchmark.saved;
  player.position = saved.position; player.yaw = saved.yaw; player.pitch = saved.pitch; phase = saved.phase;
  $('adaptive').checked = saved.adaptive; $('cycle').checked = saved.cycle;
  $('pause').hidden = locked; $('welcome').hidden = true;
  for (const id of ['quality', 'resolution', 'adaptive', 'cycle', 'sun']) $(id).disabled = false;
  $('benchmark-status').textContent = cancelled ? `Benchmark cancelled: ${cancellationReason}` : `${lastResult.frames?.averageFps.toFixed(1) ?? '—'} FPS · p95 ${lastResult.frames?.p95Ms.toFixed(1) ?? '—'} ms`;
  benchmark = null; $('benchmark').disabled = false; $('export-results').disabled = false;
}
function exportResult() {
  if (!lastResult) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `pomme-web-benchmark-${Date.now()}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function frame(now) {
  if (!renderer || document.documentElement.dataset.engine === 'error') return;
  const elapsedMs = lastTime ? now - lastTime : 1000 / 60;
  lastTime = now;
  const dt = Math.min(elapsedMs / 1000, 0.25);
  try { if (ready && !document.hidden) {
    frames.push(elapsedMs); if (frames.length > 180) frames.shift();
    if (benchmark) {
      const t = (now - benchmark.start) / 1000;
      const angle = t * Math.PI * 2 / 30;
      const center = mode === 'demo' ? [64, 38, 64] : benchmark.saved.position;
      player.position = [center[0] + Math.sin(angle) * 31, center[1] + Math.sin(angle * 2) * 4, center[2] + Math.cos(angle) * 31];
      player.yaw = -angle; player.pitch = -0.37;
      if (t > 2) {
        benchmark.frames.push(elapsedMs);
        const stats = renderer.stats();
        if (stats.lastGpuMs != null && stats.gpuSampleCount !== benchmark.lastGpuSample) {
          benchmark.gpu.push(stats.lastGpuMs); benchmark.lastGpuSample = stats.gpuSampleCount;
        }
      }
      if (t >= 30) finishBenchmark();
    } else {
      if ($('cycle').checked) phase = (phase + Math.min(elapsedMs, 250) / 1_200_000) % 1;
      accumulator += dt;
      while (accumulator >= 1 / 120) { player.step(1 / 120, locked && !gameplay?.blocking ? keys : new Set()); accumulator -= 1 / 120; }
      world.updateCamera(player.eye);
      session?.tick(player, dt); gameplay?.tick(dt);
      entities?.update(now / 1000, player.eye, { direction: player.direction, fov: 75 * Math.PI / 180, aspect: $('world').width / $('world').height });
      if ($('adaptive').checked) {
        const next = controller.update(Math.max(elapsedMs, renderer.stats().lastGpuMs ?? 0), now, Number($('resolution').value));
        if (Math.abs(next - scale) > 0.001) { scale = next; renderer.resize(scale); }
      }
    }
  } } catch (error) { fail(error); return; }
  try { renderer.render({ eye: player.eye, yaw: player.yaw, pitch: player.pitch, timeSeconds: now / 1000, dayPhase: phase, revision, quality: $('quality').value, scale }); }
  catch (error) { fail(error); return; }
  if (now - hudAt > 500) {
    hudAt = now;
    const report = summarizeFrames(frames), stats = renderer.stats();
    $('fps').textContent = report ? report.averageFps.toFixed(0) : '—';
    $('frame-time').textContent = report ? `${report.p95Ms.toFixed(1)} ms p95` : '— ms';
    $('gpu-time').textContent = stats.gpuMs == null ? 'unavailable' : `${stats.gpuMs.toFixed(1)} ms`;
    $('geometry').textContent = `${stats.visibleChunks ?? 0}/${stats.totalChunks ?? 0} chunks · ${Math.round((stats.triangles ?? 0) / 1000)}k triangles`;
    $('shadow-cache').textContent = `${stats.shadowUpdates ?? 0} updates${stats.shadowCached ? ' · reused' : ''}`;
    $('render-scale').textContent = `${Math.round(scale * 100)}% · ${stats.renderWidth}×${stats.renderHeight}`;
  }
  requestAnimationFrame(frame);
}

async function boot() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current Chrome or Edge on HTTPS or localhost, with hardware acceleration enabled.');
  $('play').disabled = true; $('export-results').disabled = true;
  const stored = persistedEdits();
  core = await loadCore(seed);
  for (const b of stored) { core.block_set(...b); edits.set(b.slice(0, 3).join(','), b); }
  player = new Player(core);
  renderer = await createRenderer($('world'), { onStatus: message => { $('world-status').textContent = message; } });
  renderer.resize(scale);
  world = new BrowserWorld({ core, renderer,
    onMesh: () => { revision++; },
    onReady: () => {
      ready = mode === 'demo' || (mode === 'server' && session?.state.status === 'playing') || (mode === 'import' && !loadingWorld);
      $('play').disabled = !ready; $('world-status').textContent = 'World ready · edits saved on this device';
      document.documentElement.dataset.engine = 'ready';
    }, onError: fail, onStatus: status,
  });
  world.initDemo(seed, stored);
  try { $('resume-import').hidden = !localStorage.getItem('pomme-last-import'); } catch {}
  window.pomme = { get core() { return core; }, get player() { return player; }, get renderer() { return renderer; }, get world() { return world; }, get session() { return session; }, get gameplay() { return gameplay; }, get entities() { return entities; }, get registry() { return registry; }, get mode() { return mode; }, connectServer, importFiles, loadPack, edit, startBenchmark, get benchmark() { return lastResult; }, get ready() { return ready; }, get revision() { return revision; } };
  requestAnimationFrame(frame);
}

$('play').addEventListener('click', lock); $('resume').addEventListener('click', lock);
$('world').addEventListener('click', () => { if (!locked) lock(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === $('world'); keys.clear();
  if (locked) $('world').focus();
  $('welcome').hidden = locked || ready || !!benchmark; $('pause').hidden = locked || !ready || !!benchmark;
});
document.addEventListener('mousemove', event => { if (locked && !benchmark) player.look(event.movementX, event.movementY); });
document.addEventListener('keydown', event => {
  if (gameplay?.key(event)) { if (gameplay.blocking) keys.clear(); return; }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === 'KeyE' && locked) { document.exitPointerLock(); return; }
  if (!locked) return;
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  const buttons = [...document.querySelectorAll('[data-block]')];
  const index = Number(event.key) - 1;
  if (index >= 0 && index < buttons.length) select(Number(buttons[index].dataset.block));
});
document.addEventListener('keyup', event => { gameplay?.key(event); keys.delete(event.code); });
window.addEventListener('blur', () => keys.clear());
window.addEventListener('pagehide', flushSave);
window.addEventListener('pagehide', saveImportedLocation);
setInterval(saveImportedLocation, 10000);
document.addEventListener('visibilitychange', () => { lastTime = 0; frames = []; if (document.hidden) { keys.clear(); finishBenchmark(true); } });
$('world').addEventListener('contextmenu', event => event.preventDefault());
$('world').addEventListener('mousedown', event => {
  if (!locked || benchmark || (event.button !== 0 && event.button !== 2)) return;
  const hit = player.target();
  if (mode === 'server') { gameplay?.mouseDown(event.button, hit); return; }
  if (!hit) return;
  if (event.button === 0) edit(...hit.slice(0, 3), 0);
  else { const [x, y, z] = hit.slice(3, 6); if (!player.intersectsBlock(x, y, z)) edit(x, y, z, selected); }
});
document.addEventListener('mouseup', event => gameplay?.mouseUp(event.button));
document.querySelectorAll('[data-block]').forEach(button => button.addEventListener('click', () => select(Number(button.dataset.block))));
$('settings-toggle').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden)); });
$('resolution').addEventListener('input', () => { scale = Number($('resolution').value); controller = new ResolutionController(scale); renderer?.resize(scale); });
$('sun').addEventListener('input', () => { phase = Number($('sun').value); $('cycle').checked = false; });
$('benchmark').addEventListener('click', startBenchmark); $('export-results').addEventListener('click', exportResult);
$('worlds-toggle').addEventListener('click', () => { $('worlds').hidden = !$('worlds').hidden; $('worlds-toggle').setAttribute('aria-expanded', String(!$('worlds').hidden)); });
$('resource-pack').addEventListener('change', event => { const file = event.target.files[0]; if (file) enqueue(() => loadPack(file)); });
$('world-files').addEventListener('change', event => enqueue(() => importFiles([...event.target.files])).then(() => { $('resume-import').hidden = !localStorage.getItem('pomme-last-import'); }));
$('resume-import').addEventListener('click', () => enqueue(resumeImported));
$('server-form').addEventListener('submit', event => {
  event.preventDefault();
  enqueue(() => connectServer({ host: $('server-host').value.trim(), port: Number($('server-port').value), username: $('server-username').value.trim(), auth: $('server-auth').value, gateway: $('server-gateway').value }));
});
$('disconnect').addEventListener('click', () => { session?.disconnect(); gameplay?.close(); gameplay = null; entities?.clear(); entities = null; mode = 'import'; });
window.addEventListener('resize', () => { if (benchmark) finishBenchmark(true, 'window size changed'); renderer?.resize(scale); });
boot().catch(fail);
