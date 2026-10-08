import { ColumnLightingCache } from './lighting.js';

const MAX_TARGETS = 9, MAX_COLUMNS = 81, MAX_SECTIONS = 64;
const keyOf = (x, z) => `${x},${z}`;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

function integer(value, name) {
  if (!Number.isSafeInteger(value)) throw new Error(`Lighting ${name} must be a safe integer.`);
  return value;
}

function columnCoordinate(value) {
  integer(value, 'column coordinate');
  if (Math.abs(value) >= Number.MAX_SAFE_INTEGER) throw new Error('Lighting column halo exceeds safe coordinates.');
  return value;
}

function slimMaterials(entries) {
  if (!Array.isArray(entries) || entries.length > 65536) throw new Error('Lighting initialization requires at most 65536 material entries.');
  const materials = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Invalid lighting material entry.');
    const [id, source] = entry;
    if (!Number.isInteger(id) || id < 0 || id > 65535 || materials.has(id) || !source || typeof source !== 'object') throw new Error('Lighting materials require distinct u16 IDs and metadata.');
    const material = {};
    for (const name of ['flags', 'opacity', 'filterLight', 'emitLight']) {
      const value = source[name];
      if (value === undefined || value === null) continue;
      if (!Number.isFinite(value) || value < 0 || (name === 'flags' ? !Number.isInteger(value) || value > 65535 : value > 15)) throw new Error(`Invalid lighting material ${name}.`);
      material[name] = value;
    }
    materials.set(id, material);
  }
  return materials;
}

function solveInput(message) {
  const minY = integer(message.minY, 'minimum Y'), height = integer(message.height, 'height');
  integer(message.revision, 'job revision');
  if (minY % 16 || height % 16 || height < 16 || height > 1024 || !Number.isSafeInteger(minY + height)) throw new Error('Invalid lighting world bounds.');
  if (message.hasSkylight !== undefined && typeof message.hasSkylight !== 'boolean') throw new Error('Lighting skylight flag must be boolean.');
  if (!Array.isArray(message.targets) || !message.targets.length || message.targets.length > MAX_TARGETS) throw new Error(`Lighting jobs require 1–${MAX_TARGETS} targets.`);
  if (!Array.isArray(message.columns) || message.columns.length > MAX_COLUMNS) throw new Error(`Lighting jobs allow at most ${MAX_COLUMNS} source columns.`);
  const targets = [], targetKeys = new Set(), allowedColumns = new Set();
  for (const key of message.targets) {
    if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key)) throw new Error('Invalid lighting target coordinates.');
    const [x, z] = key.split(',').map(Number);
    columnCoordinate(x); columnCoordinate(z);
    if (keyOf(x, z) !== key || targetKeys.has(key)) throw new Error('Lighting targets require distinct canonical coordinates.');
    targetKeys.add(key); targets.push({ x, z, key });
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) allowedColumns.add(keyOf(x + dx, z + dz));
  }
  const columns = new Map(), firstSection = minY / 16, lastSection = firstSection + height / 16;
  for (const column of message.columns) {
    if (!column || typeof column !== 'object') throw new Error('Invalid lighting source column.');
    const x = columnCoordinate(column.x), z = columnCoordinate(column.z), key = keyOf(x, z);
    integer(column.revision, 'column revision');
    if (columns.has(key)) throw new Error('Duplicate lighting source column.');
    if (!allowedColumns.has(key)) throw new Error('Lighting source column lies outside target halos.');
    if (!Array.isArray(column.sections) || column.sections.length > Math.min(MAX_SECTIONS, height / 16)) throw new Error('Too many lighting source sections.');
    const seen = new Set();
    for (const section of column.sections) {
      if (!section || !Number.isInteger(section.sectionY) || section.sectionY < firstSection || section.sectionY >= lastSection) throw new Error('Lighting section lies outside world bounds.');
      if (seen.has(section.sectionY)) throw new Error('Duplicate lighting source section.');
      seen.add(section.sectionY);
      if (!(section.blocks instanceof Uint16Array) || section.blocks.length !== 4096) throw new Error('Lighting sections require 4096 Uint16 block states.');
    }
    columns.set(key, column);
  }
  for (const target of targets) if (!columns.has(target.key)) throw new Error('Lighting targets require a loaded source column.');
  return { minY, height, hasSkylight: message.hasSkylight ?? true, targets, columns };
}

/** The worker owns its material metadata and bounded cache. Each result owns
 * copies of packed nibble arrays, so transferring results leaves the cache
 * intact. Yielding between columns lets a reset invalidate unfinished jobs.
 */
export function createLightingProcessor({ yieldControl = yieldTask, now = () => performance.now() } = {}) {
  const cache = new ColumnLightingCache({ maxEntries: 32, maxBytes: 8 * 1024 * 1024 });
  let generation = null, epoch = 0, materials = null;
  return async message => {
    if (!message || typeof message !== 'object') throw new Error('Invalid lighting worker request.');
    integer(message.generation, 'generation');
    if (message.type === 'init') {
      const nextMaterials = slimMaterials(message.materials);
      epoch++; generation = message.generation; materials = nextMaterials; cache.clear();
      return null;
    }
    if (message.type !== 'solve') throw new Error('Unknown lighting worker request.');
    if (message.generation !== generation) return null;
    if (!materials) throw new Error('Lighting worker has not been initialized.');
    const input = solveInput(message), activeEpoch = epoch, started = now(), results = [];
    let cacheHits = 0;
    for (let index = 0; index < input.targets.length; index++) {
      const { x, z, key } = input.targets[index], center = input.columns.get(key);
      const result = cache.solve({ x, z, sections: center.sections, revision: center.revision,
        neighbors: input.columns, materials, minY: input.minY, height: input.height, hasSkylight: input.hasSkylight });
      results.push({ x, z, ...result });
      if (result.stats.cacheHit) cacheHits++;
      if (index + 1 < input.targets.length) {
        await yieldControl();
        if (epoch !== activeEpoch) return null;
      }
    }
    if (epoch !== activeEpoch) return null;
    return { type: 'light-result', generation: message.generation, id: message.id, revision: message.revision,
      results, elapsedMs: Math.max(0, now() - started), cacheHits };
  };
}

if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  const process = createLightingProcessor();
  self.onmessage = async ({ data }) => {
    try {
      const response = await process(data);
      if (response) {
        const transfer = response.results.flatMap(result => [...result.sky.values(), ...result.block.values()].map(bytes => bytes.buffer));
        self.postMessage(response, transfer);
      }
    } catch (error) {
      self.postMessage({ type: 'light-error', generation: data?.generation, id: data?.id, revision: data?.revision,
        error: error instanceof Error ? error.message : String(error) });
    }
  };
}
