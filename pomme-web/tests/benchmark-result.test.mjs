import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identifyBenchmarkAdapter, qualifyBenchmark } from '../src/benchmark-result.js';
import { parseBenchmarkArguments } from '../scripts/benchmark.mjs';

const settings = { width: 1280, height: 720, quality: 'balanced', scale: .85 };
const source = { regions: [{ name: 'r.0.0.mca', bytes: 12288, sha256: 'local-fixture' }], registryVersion: '1.20.4' };
const makeResult = () => ({
  cancelled: false, durationSeconds: 30, worldMode: 'import', quality: 'balanced', scale: .85,
  outputPixels: [1280, 720], renderPixels: [1088, 612],
  samples: { frameIntervalsMs: Array(1800).fill(15), gpuDurationsMs: Array(900).fill(8) },
  renderer: { adapterInfo: { vendor: 'nvidia', architecture: 'turing', device: 'GTX 1650 Ti', description: 'NVIDIA GeForce GTX 1650 Ti', isFallbackAdapter: false },
    totalChunks: 256, vertices: 120000, gpuTimingSupported: true, lastError: null },
});
const qualify = (result, options = {}) => qualifyBenchmark(result, { source, requestedSettings: settings, ...options });

test('target verification requires actual target model, complete saved terrain route, and both measured budgets', () => {
  const qualification = qualify(makeResult());
  assert.equal(qualification.status, 'target-verified'); assert.equal(qualification.targetVerified, true);
  assert.equal(qualification.frames.averageFps, 1000 / 15); assert.equal(qualification.measuredSeconds, 27);
  assert.equal(qualification.frames.p95Ms, 15); assert.equal(qualification.gpu.p95Ms, 8);
  assert.deepEqual(qualification.reasons, []);
});

test('fast average with slow p95 tail fails the 60 FPS target', () => {
  const result = makeResult(); result.samples.frameIntervalsMs = [...Array(1600).fill(10), ...Array(400).fill(30)];
  const qualification = qualify(result);
  assert.ok(qualification.frames.averageFps > 60); assert.equal(qualification.frames.p95Ms, 30);
  assert.equal(qualification.routeCoverage, true); assert.equal(qualification.measurementValid, true);
  assert.equal(qualification.frameBudgetPassed, false); assert.equal(qualification.targetVerified, false);
});

test('reported FPS cannot override slower raw measurements', () => {
  const result = makeResult(); result.frames = { averageFps: 9000, p95Ms: 1 }; result.samples.frameIntervalsMs = Array(1400).fill(20);
  const qualification = qualify(result); assert.equal(qualification.frames.averageFps, 50); assert.equal(qualification.targetVerified, false);
});

test('actual GPU timestamp tail exceeding frame budget fails even with fast RAF samples', () => {
  const result = makeResult(); result.samples.gpuDurationsMs = Array(900).fill(18);
  const qualification = qualify(result); assert.equal(qualification.frameBudgetPassed, true); assert.equal(qualification.gpuBudgetPassed, false); assert.equal(qualification.targetVerified, false);
});

test('software and fallback adapters can never verify hardware performance', () => {
  for (const adapter of [
    { vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: false },
    { vendor: 'nvidia', description: 'NVIDIA GTX 1650 Ti', isFallbackAdapter: true },
    { vendor: 'mesa', description: 'llvmpipe', isFallbackAdapter: false },
    { vendor: 'microsoft', description: 'Microsoft Basic Render Driver', isFallbackAdapter: false },
  ]) {
    const result = makeResult(); result.renderer.adapterInfo = adapter;
    assert.equal(qualify(result).targetVerified, false); assert.equal(identifyBenchmarkAdapter(adapter).software, true);
  }
  const explicitSmoke = qualify(makeResult(), { softwareSmoke: true });
  assert.equal(explicitSmoke.harnessValid, true); assert.equal(explicitSmoke.targetVerified, false); assert.equal(explicitSmoke.status, 'software-smoke');
});

test('anonymous hardware retains measurements while model verification remains false', () => {
  const result = makeResult(); result.renderer.adapterInfo = { vendor: 'nvidia', device: 'undisclosed', description: 'WebGPU adapter', isFallbackAdapter: false };
  const qualification = qualify(result); assert.equal(qualification.measurementValid, true); assert.equal(qualification.hardwareAdapter, true);
  assert.equal(qualification.targetModelDetected, false); assert.equal(qualification.targetVerified, false); assert.equal(qualification.status, 'target-model-unverified');
});

test('1650 without Ti and different GPU families do not satisfy model verification', () => {
  for (const description of ['NVIDIA GeForce GTX 1650', 'NVIDIA GeForce GTX 1650 SUPER', 'NVIDIA GeForce RTX 4060', 'AMD 1650 Ti'])
    assert.equal(identifyBenchmarkAdapter({ description, isFallbackAdapter: false }).targetModelDetected, false);
});

test('cancelled, empty, demo, errors, and missing terrain cannot verify target', () => {
  for (const change of [
    result => { result.cancelled = true; }, result => { result.samples.frameIntervalsMs = []; },
    result => { result.worldMode = 'demo'; }, result => { result.renderer.totalChunks = 0; },
    result => { result.renderer.vertices = 0; }, result => { result.renderer.lastError = 'device lost'; },
    result => { result.durationSeconds = 10; },
  ]) { const result = makeResult(); change(result); assert.equal(qualify(result).targetVerified, false); }
  assert.equal(qualify(makeResult(), { errors: ['validation failed'] }).targetVerified, false);
  assert.equal(qualify(makeResult(), { source: null }).targetVerified, false);
});

test('non-finite, zero, negative and missing raw samples fail qualification', () => {
  for (const bad of [NaN, Infinity, 0, -1]) {
    const result = makeResult(); result.samples.frameIntervalsMs[2] = bad;
    assert.equal(qualify(result).measurementValid, false); assert.equal(qualify(result).targetVerified, false);
  }
  const result = makeResult(); delete result.samples;
  assert.equal(qualify(result).harnessValid, false);
});

test('short sample series cannot stand in for an otherwise completed camera route', () => {
  const result = makeResult(); result.samples.frameIntervalsMs = Array(120).fill(10);
  const qualification = qualify(result); assert.equal(qualification.routeCoverage, false); assert.equal(qualification.measurementValid, false); assert.equal(qualification.targetVerified, false);
});

test('measured settings must exactly match requested output and internal resolution', () => {
  for (const change of [result => { result.quality = 'low'; }, result => { result.scale = .5; },
    result => { result.outputPixels = [640, 360]; }, result => { result.renderPixels = [640, 360]; }]) {
    const result = makeResult(); change(result); assert.equal(qualify(result).settingsMatch, false); assert.equal(qualify(result).targetVerified, false);
  }
});

test('missing timestamps on a supporting adapter are recorded as incomplete measurement', () => {
  const result = makeResult(); result.samples.gpuDurationsMs = [];
  assert.equal(qualify(result).measurementValid, false); assert.equal(qualify(result).targetVerified, false);
  result.renderer.gpuTimingSupported = false;
  const unsupported = qualify(result); assert.equal(unsupported.measurementValid, true); assert.equal(unsupported.gpu, null); assert.equal(unsupported.targetVerified, true);
});

test('benchmark CLI requires private source inputs in hardware mode and validates reproducible settings', () => {
  assert.throws(() => parseBenchmarkArguments([]), /requires --jar/);
  const options = parseBenchmarkArguments(['--jar', 'client.jar', '--region', 'r.0.0.mca', '--region', 'r.-1.2.mca', '--width', '1920', '--height', '1080', '--quality', 'high', '--scale', '.75', '--headless']);
  assert.equal(options.regions.length, 2); assert.equal(options.width, 1920); assert.equal(options.scale, .75); assert.equal(options.headless, true);
  assert.equal(parseBenchmarkArguments(['--software-smoke']).softwareSmoke, true);
  assert.throws(() => parseBenchmarkArguments(['--software-smoke', '--scale', '.25']), /scale must/);
  assert.throws(() => parseBenchmarkArguments(['--software-smoke', '--width', 'NaN']), /width must/);
  assert.throws(() => parseBenchmarkArguments(['--software-smoke', '--region', 'renamed.mca']), /original/);
  assert.throws(() => parseBenchmarkArguments(['--software-smoke', '--level', 'other.dat']), /level.dat/);
  assert.throws(() => parseBenchmarkArguments(['--software-smoke', '--headless', '--mystery']), /Unknown option/);
});
