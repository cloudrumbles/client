import { computeIrradiance, snapshotGeometryKey, validateIrradianceSnapshot, validateIrradianceTables } from './irradiance.js';
import { IrradianceSunCache, copyIrradianceSource, sameIrradianceSource } from './irradiance-sun-cache.js';
import { IrradianceDiskCache } from './irradiance-disk-cache.js';
import { irradianceMaterialKey, irradianceSourceKey } from './irradiance-source-key.js';

const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

/** A repeated sun angle reuses lossless packed bounce bits for the exact source
 * band. Geometry/light changes clear angles; resets cancel at the next slice. */
export function createIrradianceProcessor({ yieldControl = yieldTask, now = () => performance.now(), slicesPerYield = 8, sunCacheBytes, diskCache } = {}) {
  if (!Number.isInteger(slicesPerYield) || slicesPerYield < 1 || slicesPerYield > 32) throw new Error('Invalid irradiance worker slice budget.');
  let epoch = 0, generation = null, tables = null, localCache = null, localKey = null, source = null, packedLocal = null, cachedStats = null;
  const sunCache = new IrradianceSunCache(sunCacheBytes === undefined ? {} : { maxBytes: sunCacheBytes });
  const disk = diskCache ?? (globalThis.indexedDB && globalThis.crypto?.subtle ? new IrradianceDiskCache() : null);
  let persistent = false, materialKeyPromise = null, sourceKeyPromise = null;
  const prefetched = new Set();
  const validStored = (value, snapshot) => value?.localData instanceof Uint16Array && value.localData.length === snapshot.states.length * 4 &&
    value.alpha instanceof Uint16Array && value.alpha.length === snapshot.states.length &&
    value.alpha.every((alpha, index) => alpha === (snapshot.known[index] && tables.opacity[snapshot.states[index]] < 15 ? 0x3c00 : 0));
  function prefetch(sourceKey, bucket, activeEpoch, snapshot) {
    const next = (bucket + 1) % 240;
    if (!persistent || !sourceKey || !snapshot.hasSkylight || sunCache.export(next)) return;
    void disk.get(sourceKey, next).then(value => {
      if (epoch !== activeEpoch || !validStored(value, snapshot)) return;
      try { sunCache.import(next, value); prefetched.add(next); } catch {}
    }).catch(() => {});
  }
  const cacheStats = () => ({ ...sunCache.stats(), cacheBytes: localCache?.byteLength ?? 0,
    residentCacheBytes: (localCache?.byteLength ?? 0) + (packedLocal?.byteLength ?? 0) + sunCache.stats().sunCacheBytes +
      (source ? ['states', 'known', 'sky', 'block'].reduce((bytes, name) => bytes + source[name].byteLength, 0) : 0) });
  return async message => {
    if (!message || !Number.isSafeInteger(message.generation)) throw new Error('Invalid irradiance worker generation.');
    if (message.type === 'init') {
      tables = validateIrradianceTables(message.tables);
      generation = message.generation; epoch++; localCache = null; localKey = null; source = null; packedLocal = null; cachedStats = null; sunCache.clear();
      prefetched.clear(); persistent = Boolean(disk) && message.persistentCache !== false;
      materialKeyPromise = persistent ? irradianceMaterialKey(tables).catch(() => null) : null; sourceKeyPromise = null;
      return null;
    }
    if (message.type !== 'solve') throw new Error('Unknown irradiance worker message.');
    if (message.generation !== generation) return null;
    if (!tables || !Number.isSafeInteger(message.id) || typeof message.key !== 'string' || message.key.length > 256) throw new Error('Invalid irradiance worker job.');
    const started = now(); validateIrradianceSnapshot(message.snapshot);
    const activeEpoch = ++epoch, key = snapshotGeometryKey(message.snapshot);
    if (key !== localKey || !sameIrradianceSource(source, message.snapshot)) {
      source = copyIrradianceSource(message.snapshot); localKey = key; localCache = null; packedLocal = null; cachedStats = null; sunCache.clear();
      prefetched.clear(); const captured = source;
      sourceKeyPromise = persistent ? materialKeyPromise.then(materialKey => materialKey ? irradianceSourceKey(captured, materialKey).catch(() => null) : null) : null;
    }
    const previousBounce = packedLocal && sunCache.get(message.snapshot.sunBucket);
    if (previousBounce) {
      const prefetchHit = prefetched.delete(message.snapshot.sunBucket);
      if (sourceKeyPromise) void sourceKeyPromise.then(sourceKey => { if (epoch === activeEpoch) prefetch(sourceKey, message.snapshot.sunBucket, activeEpoch, message.snapshot); });
      return { type: 'irradiance-result', generation, id: message.id, key: message.key,
      origin: [...message.snapshot.origin], dimensions: [...message.snapshot.dimensions], cellSize: 1, format: 'rgba16float', layout: 'x-fastest,y,z',
      localData: packedLocal.slice(), bounceData: previousBounce,
      stats: { ...cachedStats, processedCells: 0, localCacheHit: true, sunCacheHit: true, diskCacheHit: false, prefetchedSunCacheHit: prefetchHit, ...cacheStats(), workerMs: Math.max(0, now() - started) } };
    }
    const sourceKey = sourceKeyPromise ? await sourceKeyPromise : null;
    if (epoch !== activeEpoch) return null;
    let stored = null;
    if (persistent && sourceKey) try { stored = await disk.get(sourceKey, message.snapshot.sunBucket); } catch {}
    if (epoch !== activeEpoch) return null;
    if (validStored(stored, message.snapshot)) {
      try {
        sunCache.import(message.snapshot.sunBucket, stored);
        const bounceData = sunCache.get(message.snapshot.sunBucket);
        if (bounceData) {
          packedLocal = stored.localData.slice(); cachedStats = stored.stats;
          prefetch(sourceKey, message.snapshot.sunBucket, activeEpoch, message.snapshot);
          return { type: 'irradiance-result', generation, id: message.id, key: message.key,
            origin: [...message.snapshot.origin], dimensions: [...message.snapshot.dimensions], cellSize: 1, format: 'rgba16float', layout: 'x-fastest,y,z',
            localData: packedLocal.slice(), bounceData,
            stats: { ...cachedStats, processedCells: 0, localCacheHit: true, sunCacheHit: true, diskCacheHit: true, prefetchedSunCacheHit: false,
              diskReadMs: stored.readMs, ...cacheStats(), workerMs: Math.max(0, now() - started) } };
        }
      } catch {}
    }
    const computationStarted = now(), computation = computeIrradiance(message.snapshot, tables, key === localKey ? localCache : null);
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
    packedLocal = result.localData.slice(); cachedStats = result.stats;
    sunCache.store(message.snapshot.sunBucket, result.bounceData);
    const computeMs = Math.max(0, now() - computationStarted);
    const entry = sunCache.export(message.snapshot.sunBucket);
    if (persistent && sourceKey && entry) void disk.put(sourceKey, message.snapshot.sunBucket, { ...entry, localData: packedLocal, stats: { ...result.stats, computeMs } }).catch(() => {});
    prefetch(sourceKey, message.snapshot.sunBucket, activeEpoch, message.snapshot);
    delete result.localCache;
    return { type: 'irradiance-result', generation, id: message.id, key: message.key, ...result,
      stats: { ...result.stats, computeMs, sunCacheHit: false, diskCacheHit: false, prefetchedSunCacheHit: false, ...cacheStats(), workerMs: Math.max(0, now() - started) } };
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
