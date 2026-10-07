import { createRenderer } from './renderer.js';
import { loadCore } from './wasm.js';
import { Player } from './player.js';
import { ResolutionController, summarizeFrames, summarizeGpuTimes } from './performance.js';

const $ = id => document.getElementById(id);
const seed = 1650;
const saveKey = 'pomme-web-world-v1';
const keys = new Set();
const edits = new Map();
let renderer, core, player, worker, ready = false, locked = false;
let selected = 1, scale = 0.85, phase = 0.22, revision = 0;
let controller = new ResolutionController(scale);
let lastTime = 0, accumulator = 0, hudAt = 0, frames = [], benchmark = null, lastResult = null;
let saveTimer;
let saveDirty = false;

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  ready = false;
  if (benchmark) finishBenchmark(true);
  worker?.terminate();
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
    return stored.filter(b => Array.isArray(b) && b.length === 4 && b.every(Number.isInteger) && b[0] >= 0 && b[0] < 128 && b[1] >= 0 && b[1] < 64 && b[2] >= 0 && b[2] < 128 && b[3] >= 0 && b[3] <= 8);
  } catch { return []; }
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!saveDirty) return;
  try { localStorage.setItem(saveKey, JSON.stringify([...edits.values()])); saveDirty = false; }
  catch { $('world-status').textContent = 'Save storage is full; this session remains playable'; }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}
function edit(x, y, z, id) {
  if (!core.block_set(x, y, z, id)) return false;
  const block = [x, y, z, id];
  edits.set(`${x},${y},${z}`, block);
  saveDirty = true;
  worker.postMessage({ type: 'edit', block });
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
async function lock() {
  if (!ready) return;
  try { await $('world').requestPointerLock(); }
  catch { $('world-status').textContent = 'Click Enter world again to capture the mouse'; }
}
function startBenchmark() {
  if (!ready || benchmark) return;
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
  lastResult = { schemaVersion: 1, build: 'pomme-web-milestone-1', timestamp: new Date().toISOString(), seed, worldRevision: core.world_revision(), editCount: edits.size, cancelled, durationSeconds: (performance.now() - benchmark.start) / 1000, quality: $('quality').value, outputPixels: [$('world').width, $('world').height], renderPixels: [stats.renderWidth, stats.renderHeight], scale, dayPhase: phase, clock: 'requestAnimationFrame intervals (includes browser pacing)', frames: summarizeFrames(benchmark.frames), gpuClock: benchmark.gpu.length ? 'WebGPU timestamp-query' : 'unavailable', gpu: summarizeGpuTimes(benchmark.gpu), renderer: stats, userAgent: navigator.userAgent, limits: 'Procedural editable terrain; not original Photon, Minecraft protocol, or Voxy compatibility.' };
  if (cancelled) lastResult.cancellationReason = cancellationReason;
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
  const dt = Math.min(elapsedMs / 1000, 0.05);
  if (ready && !document.hidden) {
    frames.push(elapsedMs); if (frames.length > 180) frames.shift();
    if (benchmark) {
      const t = (now - benchmark.start) / 1000;
      const angle = t * Math.PI * 2 / 30;
      player.position = [64 + Math.sin(angle) * 31, 38 + Math.sin(angle * 2) * 4, 64 + Math.cos(angle) * 31];
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
      while (accumulator >= 1 / 120) { player.step(1 / 120, locked ? keys : new Set()); accumulator -= 1 / 120; }
      if ($('adaptive').checked) {
        const next = controller.update(elapsedMs, now, Number($('resolution').value));
        if (Math.abs(next - scale) > 0.001) { scale = next; renderer.resize(scale); }
      }
    }
  }
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
  worker = new Worker(new URL('./world.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (document.documentElement.dataset.engine === 'error') return;
    if (data.type === 'mesh') {
      try { renderer.uploadChunk(data.index, data.opaque, data.water, data.bounds); revision++; }
      catch (error) { fail(error); }
    } else if (data.type === 'ready') {
      ready = true; $('play').disabled = false; $('world-status').textContent = 'World ready · edits saved on this device';
      document.documentElement.dataset.engine = 'ready';
    } else if (data.type === 'error') fail(data.message);
  };
  worker.onerror = event => fail(event.message);
  worker.postMessage({ type: 'init', seed, edits: stored });
  window.pomme = { get core() { return core; }, get player() { return player; }, get renderer() { return renderer; }, edit, startBenchmark, get benchmark() { return lastResult; }, get ready() { return ready; }, get revision() { return revision; } };
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
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  if (event.code === 'KeyE' && locked) { document.exitPointerLock(); return; }
  if (!locked) return;
  if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  const buttons = [...document.querySelectorAll('[data-block]')];
  const index = Number(event.key) - 1;
  if (index >= 0 && index < buttons.length) select(Number(buttons[index].dataset.block));
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { lastTime = 0; frames = []; if (document.hidden) { keys.clear(); finishBenchmark(true); } });
$('world').addEventListener('contextmenu', event => event.preventDefault());
$('world').addEventListener('mousedown', event => {
  if (!locked || benchmark || (event.button !== 0 && event.button !== 2)) return;
  const hit = player.target(); if (!hit) return;
  if (event.button === 0) edit(...hit.slice(0, 3), 0);
  else { const [x, y, z] = hit.slice(3, 6); if (!player.intersectsBlock(x, y, z)) edit(x, y, z, selected); }
});
document.querySelectorAll('[data-block]').forEach(button => button.addEventListener('click', () => select(Number(button.dataset.block))));
$('settings-toggle').addEventListener('click', () => { $('settings').hidden = !$('settings').hidden; $('settings-toggle').setAttribute('aria-expanded', String(!$('settings').hidden)); });
$('resolution').addEventListener('input', () => { scale = Number($('resolution').value); controller = new ResolutionController(scale); renderer?.resize(scale); });
$('sun').addEventListener('input', () => { phase = Number($('sun').value); $('cycle').checked = false; });
$('benchmark').addEventListener('click', startBenchmark); $('export-results').addEventListener('click', exportResult);
window.addEventListener('resize', () => { if (benchmark) finishBenchmark(true, 'window size changed'); renderer?.resize(scale); });
boot().catch(fail);
