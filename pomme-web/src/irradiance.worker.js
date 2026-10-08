import { computeIrradiance, snapshotGeometryKey, validateIrradianceSnapshot, validateIrradianceTables } from './irradiance.js';

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** One compact local-light cache is retained. Changing only the quantized sun
 * reuses that cache; reset messages cancel a computation at its next slice. */
export function createIrradianceProcessor({ yieldControl = yieldTask, now = () => performance.now(), slicesPerYield = 8 } = {}) {
  if (!Number.isInteger(slicesPerYield) || slicesPerYield < 1 || slicesPerYield > 32) throw new Error('Invalid irradiance worker slice budget.');
  let epoch = 0, generation = null, tables = null, localCache = null, localKey = null;
  return async message => {
    if (!message || !Number.isSafeInteger(message.generation)) throw new Error('Invalid irradiance worker generation.');
    if (message.type === 'init') {
      tables = validateIrradianceTables(message.tables);
      generation = message.generation; epoch++; localCache = null; localKey = null;
      return null;
    }
    if (message.type !== 'solve') throw new Error('Unknown irradiance worker message.');
    if (message.generation !== generation) return null;
    if (!tables || !Number.isSafeInteger(message.id) || typeof message.key !== 'string' || message.key.length > 256) throw new Error('Invalid irradiance worker job.');
    validateIrradianceSnapshot(message.snapshot);
    const activeEpoch = epoch, key = snapshotGeometryKey(message.snapshot), started = now();
    const computation = computeIrradiance(message.snapshot, tables, key === localKey ? localCache : null);
    let step, slices = 0;
    do {
      step = computation.next();
      if (!step.done && ++slices % slicesPerYield === 0) {
        await yieldControl();
        if (epoch !== activeEpoch) { computation.return(); return null; }
      }
    } while (!step.done);
    if (epoch !== activeEpoch) return null;
    const result = step.value;
    localCache = result.localCache; localKey = key;
    delete result.localCache;
    return { type: 'irradiance-result', generation, id: message.id, key: message.key, ...result,
      stats: { ...result.stats, workerMs: Math.max(0, now() - started), cacheBytes: localCache.byteLength } };
  };
}

if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  const process = createIrradianceProcessor();
  self.onmessage = async ({ data }) => {
    try {
      const result = await process(data);
      if (result) self.postMessage(result, [result.localData.buffer, result.bounceData.buffer]);
    } catch (error) { self.postMessage({ type: 'irradiance-error', generation: data?.generation, id: data?.id, error: error.message }); }
  };
}
