import { summarizeFrames, summarizeGpuTimes } from './performance.js';

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|software|microsoft basic render|warp(?:\s|$)/i;
const TARGET_MODEL = /(?:geforce\s+)?(?:gtx\s+)?1650\s*ti\b/i;
const NVIDIA_ADAPTER = /nvidia|geforce|\b(?:0x)?10de\b/i;

export function identifyBenchmarkAdapter(adapter = {}) {
  const description = [adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(value => typeof value === 'string').join(' ');
  const software = adapter.isFallbackAdapter === true || SOFTWARE_ADAPTER.test(description);
  return {
    software,
    hardwareAdapter: adapter.isFallbackAdapter === false && !software,
    targetModelDetected: !software && NVIDIA_ADAPTER.test(description) && TARGET_MODEL.test(description),
    evidence: description || 'Adapter model was not exposed by the browser.',
  };
}

/** Qualify measured samples, never an adapter name or average FPS alone. */
export function qualifyBenchmark(result, { softwareSmoke = false, errors = [], source = null, requestedSettings = null } = {}) {
  const budgetMs = 1000 / 60;
  const reasons = [];
  const intervals = result?.samples?.frameIntervalsMs;
  const gpuTimes = result?.samples?.gpuDurationsMs;
  const validSamples = values => Array.isArray(values) && values.every(value => Number.isFinite(value) && value > 0);
  const framesValid = validSamples(intervals) && intervals.length > 0;
  const gpuValid = validSamples(gpuTimes ?? []);
  const frames = framesValid ? summarizeFrames(intervals) : null;
  const gpu = gpuValid && gpuTimes?.length ? summarizeGpuTimes(gpuTimes) : null;
  const adapter = identifyBenchmarkAdapter(result?.renderer?.adapterInfo);
  const completed = Boolean(result) && result.cancelled === false && Number.isFinite(result.durationSeconds) && result.durationSeconds >= 29;
  const finitePixels = pixels => Array.isArray(pixels) && pixels.length === 2 && pixels.every(value => Number.isInteger(value) && value > 0);
  const settingsPresent = requestedSettings && finitePixels(result?.outputPixels) && finitePixels(result?.renderPixels) && Number.isFinite(result?.scale);
  const settingsMatch = Boolean(settingsPresent && result.quality === requestedSettings.quality && result.scale === requestedSettings.scale
    && result.outputPixels[0] === requestedSettings.width && result.outputPixels[1] === requestedSettings.height
    && result.renderPixels[0] === Math.round(requestedSettings.width * requestedSettings.scale)
    && result.renderPixels[1] === Math.round(requestedSettings.height * requestedSettings.scale));
  const importedTerrain = result?.worldMode === 'import' && Array.isArray(source?.regions) && source.regions.length > 0;
  const geometryPresent = result?.renderer?.totalChunks > 0 && result?.renderer?.vertices > 0;
  const timestampSamplesMissing = result?.renderer?.gpuTimingSupported === true && !gpu;
  const engineErrors = errors.length > 0 || Boolean(result?.renderer?.lastError);
  const harnessValid = completed && framesValid && gpuValid && settingsMatch && geometryPresent && !engineErrors;
  const measuredSeconds = framesValid ? intervals.reduce((sum, value) => sum + value, 0) / 1000 : 0;
  const routeCoverage = completed && measuredSeconds >= result.durationSeconds - 5 && measuredSeconds <= result.durationSeconds + 1;
  const measurementValid = harnessValid && frames.samples >= 120 && routeCoverage && !timestampSamplesMissing;
  const frameBudgetPassed = Boolean(frames && frames.averageFps >= 60 && frames.p95Ms <= budgetMs);
  const gpuBudgetPassed = gpu ? gpu.p95Ms <= budgetMs : null;
  const targetVerified = measurementValid && importedTerrain && adapter.hardwareAdapter && adapter.targetModelDetected
    && !softwareSmoke && frameBudgetPassed && gpuBudgetPassed !== false;

  if (!completed) reasons.push(result?.cancelled ? 'The benchmark was cancelled.' : 'A complete 30-second camera route was not recorded.');
  if (!framesValid) reasons.push('Frame samples are empty, non-finite, or non-positive.');
  if (!gpuValid) reasons.push('GPU timestamp samples contain invalid values.');
  if (frames && frames.samples < 120) reasons.push('Fewer than 120 measured frame intervals were recorded.');
  if (completed && !routeCoverage) reasons.push('Recorded frame intervals do not cover the measured camera route after warmup.');
  if (!settingsMatch) reasons.push('Measured output size, render size, quality, or scale differs from the requested settings.');
  if (!geometryPresent) reasons.push('The measured world has no rendered terrain geometry.');
  if (engineErrors) reasons.push('The browser or renderer reported errors.');
  if (timestampSamplesMissing) reasons.push('The adapter supports GPU timestamps, but the run recorded no timestamp samples.');
  if (!importedTerrain) reasons.push('Target verification requires imported saved-region terrain.');
  if (softwareSmoke || adapter.software) reasons.push('Software rendering validates the harness only.');
  else if (!adapter.hardwareAdapter) reasons.push('The browser did not identify a hardware adapter.');
  if (!adapter.targetModelDetected) reasons.push('The browser did not expose the target NVIDIA GeForce GTX 1650 Ti model.');
  if (frames && !frameBudgetPassed) reasons.push('Average FPS or the p95 frame interval misses the 60 FPS / 16.67 ms budget.');
  if (gpuBudgetPassed === false) reasons.push('The p95 measured GPU duration misses the 16.67 ms budget.');

  return {
    status: targetVerified ? 'target-verified' : !harnessValid ? 'invalid-run' : softwareSmoke || adapter.software ? 'software-smoke'
      : !adapter.targetModelDetected ? 'target-model-unverified' : 'target-unverified',
    harnessValid, measurementValid, targetVerified, ...adapter,
    target: { model: 'NVIDIA GeForce GTX 1650 Ti', averageFps: 60, p95FrameBudgetMs: budgetMs, p95GpuBudgetMs: budgetMs },
    importedTerrain, settingsMatch, routeCoverage, measuredSeconds, frameBudgetPassed, gpuBudgetPassed,
    frames, gpu, reasons,
  };
}
