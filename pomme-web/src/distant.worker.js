import { loadCore } from './wasm.js';
import { applyBiomeTints, setBiomeSeed, createBiomeSampler, tintComponents } from './biome-tints.js';
// Persistent LOD stores source occupancy, not invented terrain or a heightmap.
// The 4-block level retains caves, overhangs, and isolated visible voxels.
const INVISIBLE = 128, FLUID = 4;
/** Same section-aligned vertical bounds accepted by the native WASM world. */
export function dimensionBounds({ minY = -64, height = 384 } = {}) {
  if (!Number.isInteger(minY) || minY % 16 !== 0 || minY <= -2147483646
    || !Number.isInteger(height) || height < 16 || height > 1024 || height % 16 !== 0
    || minY + height >= 2147483645) throw new Error('Unsupported distant terrain dimension bounds.');
  return { minY, height };
}
export function validColumnCoordinates(x, z) {
  return [x, z].every(value => Number.isInteger(value) && value * 16 > -2147483646 && value * 16 + 16 < 2147483645);
}
const FACE_DATA = [
  ['east', [1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  ['west', [-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
  ['up', [0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]]],
  ['down', [0, -1, 0], [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]]],
  ['south', [0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
  ['north', [0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
];
const TRIANGLES = [0, 1, 2, 0, 2, 3];
const UNKNOWN = { flags: 3, color: [.65, .65, .65] };
function materialMap(materials) { return materials instanceof Map ? materials : new Map(materials ?? []); }
function visible(id, materials) { return id !== 0 && (materials.has(id) ? !(materials.get(id).flags & INVISIBLE) : true); }
function index(x, y, z, n) { return (y * n + z) * n + x; }
function allocateTops(length, minY) { const tops = new Int32Array(length); tops.fill(minY - 1); return tops; }
function selectRepresentative(counts) {
  let best = 0, frequency = -1;
  for (const [id, count] of counts) if (count > frequency || (count === frequency && id < best)) { best = id; frequency = count; }
  return best;
}

/** Reduce native sections in (y * 16 + z) * 16 + x order. */
export function reduceColumn(column, materialsInput, bounds = {}) {
  if (!validColumnCoordinates(column?.x, column?.z)) throw new Error('LOD columns require safe native integer x/z coordinates');
  const { minY, height } = dimensionBounds(bounds), maxY = minY + height;
  const materials = materialMap(materialsInput), cells = new Uint16Array(4 * 4 * height / 4);
  const tops = allocateTops(cells.length, minY), occupancy = new Uint32Array(cells.length * 2);
  const frequencies = new Array(cells.length), seen = new Set();
  for (const section of column.sections ?? []) {
    if (!Number.isInteger(section.sectionY) || !(section.blocks instanceof Uint16Array) || section.blocks.length !== 4096) throw new Error('LOD sections require sectionY and 4096 Uint16 block states');
    if (seen.has(section.sectionY)) throw new Error('Duplicate LOD section');
    seen.add(section.sectionY);
    const sectionBase = section.sectionY * 16;
    if (sectionBase < minY || sectionBase >= maxY) continue;
    for (let localY = 0; localY < 16; localY++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const id = section.blocks[index(x, localY, z, 16)];
      if (!visible(id, materials)) continue;
      const y = sectionBase + localY, cell = index(x >> 2, (y - minY) >> 2, z >> 2, 4);
      const bit = ((y - minY) & 3) * 16 + (z & 3) * 4 + (x & 3);
      occupancy[cell * 2 + (bit >> 5)] |= 1 << (bit & 31);
      if (y > tops[cell]) { tops[cell] = y; frequencies[cell] = new Map(); }
      if (y === tops[cell]) { const counts = frequencies[cell]; counts.set(id, (counts.get(id) ?? 0) + 1); }
    }
  }
  for (let cell = 0; cell < cells.length; cell++) if (frequencies[cell]) cells[cell] = selectRepresentative(frequencies[cell]);
  const biomes = new Uint32Array(height / 16 * 64); biomes.fill(0xffffffff);
  for (const section of column.sections ?? []) if (section.biomes) {
    if (!(section.biomes instanceof Uint32Array) || section.biomes.length !== 64) throw new Error('LOD biome arrays require 64 Uint32 entries.');
    const offset = (section.sectionY * 16 - minY) / 16 * 64;
    if (offset < 0 || offset >= biomes.length) continue;
    biomes.set(section.biomes, offset);
  }
  const record = { biomes, x: column.x, z: column.z, minY, height, levels: { 4: cells }, topHeights: { 4: tops }, occupancy, materialStale: false };
  rebuildHigherLevels(record);
  return record;
}

function rebuildHigherLevels(record) {
  const { minY, height } = dimensionBounds(record);
  for (const size of [8, 16]) {
    const n = 16 / size;
    record.levels[size] = new Uint16Array(n * n * height / size);
    record.topHeights[size] = allocateTops(record.levels[size].length, minY);
    for (let y = 0; y < height / size; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) rebuildHigherCell(record, size, x, y, z);
  }
}

function rebuildHigherCell(record, size, x, y, z) {
  const previous = size / 2, previousN = 16 / previous, n = 16 / size;
  const source = record.levels[previous], sourceTops = record.topHeights[previous], target = index(x, y, z, n);
  const counts = new Map(); let top = record.minY - 1;
  for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
    const child = index(x * 2 + dx, y * 2 + dy, z * 2 + dz, previousN), id = source[child];
    if (!id) continue;
    const childTop = sourceTops[child];
    if (childTop > top) { top = childTop; counts.clear(); }
    if (childTop === top) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const id = counts.size ? selectRepresentative(counts) : 0;
  const changed = record.levels[size][target] !== id || record.topHeights[size][target] !== top;
  record.levels[size][target] = id; record.topHeights[size][target] = top;
  return changed;
}

/**
 * Apply a world-coordinate edit without retaining 4096 raw states per section.
 * Occupancy remains exact. Removing the representative can leave its material
 * approximate until full-column reingestion; materialStale makes that explicit.
 */
export function updateReducedBlock(record, x, y, z, stateId, materialsInput) {
  if (![x, y, z, stateId].every(Number.isInteger) || stateId < 0 || stateId > 65535) throw new Error('LOD block edits require integer coordinates and a Uint16 state');
  const { minY, height } = dimensionBounds(record), localX = x - record.x * 16, localZ = z - record.z * 16;
  if (localX < 0 || localX >= 16 || localZ < 0 || localZ >= 16 || y < minY || y >= minY + height) return null;
  if (!(record.occupancy instanceof Uint32Array) || record.occupancy.length !== 4 * 4 * height / 4 * 2) throw new Error('LOD edit requires exact occupancy data');
  const materials = materialMap(materialsInput), cellY = (y - minY) >> 2, cell = index(localX >> 2, cellY, localZ >> 2, 4);
  const previousId = record.levels[4][cell], previousHeight = record.topHeights[4][cell];
  const bit = ((y - minY) & 3) * 16 + (localZ & 3) * 4 + (localX & 3), word = cell * 2 + (bit >> 5), mask = 1 << (bit & 31);
  const occupiedBefore = !!(record.occupancy[word] & mask), occupiedAfter = visible(stateId, materials);
  if (occupiedAfter) record.occupancy[word] |= mask; else record.occupancy[word] &= ~mask;
  const low = record.occupancy[cell * 2], high = record.occupancy[cell * 2 + 1];
  if (!low && !high) { record.levels[4][cell] = 0; record.topHeights[4][cell] = minY - 1; }
  else {
    const highestBit = high ? 63 - Math.clz32(high) : 31 - Math.clz32(low);
    const top = minY + cellY * 4 + (highestBit >> 4), previousTop = record.topHeights[4][cell];
    if (occupiedAfter && (!record.levels[4][cell] || y > previousTop)) record.levels[4][cell] = stateId;
    else if (occupiedAfter && y === top) {
      // Exact source frequencies are intentionally not persisted. This tie is
      // deterministic, and the next full ingestion restores the majority rule.
      record.levels[4][cell] = Math.min(record.levels[4][cell], stateId); record.materialStale = true;
    }
    if (occupiedBefore && (!occupiedAfter || y <= previousTop)) record.materialStale = true;
    record.topHeights[4][cell] = top;
  }
  // A single source edit can only affect its two ancestors. Reuse the mip
  // arrays and stop as soon as a parent's representative and height agree.
  if (record.levels[4][cell] !== previousId || record.topHeights[4][cell] !== previousHeight) {
    for (const size of [8, 16]) if (!rebuildHigherCell(record, size, Math.floor(localX / size), Math.floor((y - minY) / size), Math.floor(localZ / size))) break;
  }
  return record;
}

function occludesFace(stateId, neighbor, materials) {
  if (!neighbor || !visible(neighbor, materials)) return false;
  const flags = materials.get(neighbor)?.flags ?? 3;
  return !(flags & (FLUID | 32 | 64)) || neighbor === stateId;
}

/** Mesh standalone closed LOD cubes; differing levels may have visible steps. */
export function meshColumn(record, cellSize, materialsInput, tintAt = null, boundaryOccluded = null) {
  if (![4, 8, 16].includes(cellSize)) throw new Error('LOD cell size must be 4, 8 or 16');
  if (!validColumnCoordinates(record?.x, record?.z)) throw new Error('Invalid distant column coordinates');
  const { minY, height } = dimensionBounds(record);
  const materials = materialMap(materialsInput), cells = record.levels[cellSize], n = 16 / cellSize, layers = height / cellSize;
  if (!(cells instanceof Uint16Array) || cells.length !== n * n * layers) throw new Error('Invalid LOD level data');
  const opaque = [], water = [], originX = record.x * 16, originZ = record.z * 16;
  const at = (x, y, z) => x < 0 || x >= n || y < 0 || y >= layers || z < 0 || z >= n ? 0 : cells[index(x, y, z, n)];
  for (let y = 0; y < layers; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const stateId = at(x, y, z); if (!stateId || !visible(stateId, materials)) continue;
    const material = materials.get(stateId) ?? UNKNOWN, flags = material.flags ?? 3, fluid = !!(flags & FLUID), output = fluid ? water : opaque;
    for (const [name, normal, corners] of FACE_DATA) {
      const neighbor = at(x + normal[0], y + normal[1], z + normal[2]);
      if (occludesFace(stateId, neighbor, materials) || boundaryOccluded?.(x, y, z, normal, stateId)) continue;
      const face = material.faces?.[name], rectangle = face?.uv ?? [0, 0, 1, 1], rotation = ((face?.rotation ?? 0) / 90) & 3;
      const coordinates = [[rectangle[0], rectangle[3]], [rectangle[0], rectangle[1]], [rectangle[2], rectangle[1]], [rectangle[2], rectangle[3]]];
      const baseTint = face?.tint ?? material.color ?? [1, 1, 1], tile = face?.tile ?? -1;
      const kind = face?.tintKind ?? 0, biome = kind && tintAt ? tintAt(originX + x * cellSize + cellSize / 2, record.topHeights[cellSize][index(x, y, z, n)], originZ + z * cellSize + cellSize / 2, kind) : [1, 1, 1];
      const tint = baseTint.map((channel, axis) => channel * biome[axis]);
      // Source custom meshes become cubes at distance. Preserve alpha/emission
      // and mark full skylight, since compact LOD does not store per-voxel light.
      const packedFlags = (flags & ~16) | 512 | (15 << 10);
      for (const vertex of TRIANGLES) {
        const point = corners[vertex], uv = coordinates[(vertex + rotation) % 4];
        // Keep vertices local so Float32 does not erase four-block cells at
        // large signed coordinates. The renderer applies this mesh's origin.
        output.push((x + point[0]) * cellSize, (y + point[1]) * cellSize, (z + point[2]) * cellSize,
          ...normal, ...tint, 1, rectangle[0] + (uv[0] - rectangle[0]) * cellSize, rectangle[1] + (uv[1] - rectangle[1]) * cellSize, tile, packedFlags);
      }
    }
  }
  return { key: `lod:${record.x},${record.z}`, opaque: new Float32Array(opaque), water: new Float32Array(water),
    origin: [originX, minY, originZ], bounds: { min: [originX, minY, originZ], max: [originX + 16, minY + height, originZ + 16] }, stride: 14 };
}

/** Batch only known source columns; gaps inside a region remain genuinely empty. */
export function meshRegion(records, regionX, regionZ, regionBatchSize, materialsInput, tintAt = null, bounds = records[0]?.record ?? {}) {
  if (![1, 2, 4, 8].includes(regionBatchSize) || !Number.isInteger(regionX) || !Number.isInteger(regionZ)) throw new Error('Invalid distant region bounds');
  const { minY, height } = dimensionBounds(bounds), extent = regionBatchSize * 16, origin = [regionX * extent, minY, regionZ * extent];
  const materials = materialMap(materialsInput), columns = new Map();
  for (const entry of records) {
    const { record, cellSize } = entry;
    if (Math.floor(record.x / regionBatchSize) !== regionX || Math.floor(record.z / regionBatchSize) !== regionZ) throw new Error('Column lies outside the distant mesh region');
    if (record.minY !== minY || record.height !== height) throw new Error('Distant mesh region contains incompatible dimension bounds');
    if (![4, 8, 16].includes(cellSize)) throw new Error('LOD cell size must be 4, 8 or 16');
    const key = `${record.x},${record.z}`;
    if (columns.has(key)) throw new Error('Duplicate distant mesh column');
    columns.set(key, entry);
  }
  const meshes = records.map(({ record, cellSize }) => {
    const boundaryOccluded = (x, y, z, normal, stateId) => {
      const n = 16 / cellSize;
      if (!normal[0] && !normal[2] || x + normal[0] >= 0 && x + normal[0] < n && z + normal[2] >= 0 && z + normal[2] < n) return false;
      const neighbor = columns.get(`${record.x + normal[0]},${record.z + normal[2]}`);
      if (!neighbor) return false;
      const size = neighbor.cellSize, width = 16 / size, sampleSize = Math.min(cellSize, size);
      // Fine faces fit inside one coarse neighbor. A coarse face is removed
      // only when every finer cell covering it occludes: partial and unknown
      // neighbors keep the closed face, so mixed resolutions cannot open gaps.
      for (let vertical = 0; vertical < cellSize; vertical += sampleSize) for (let horizontal = 0; horizontal < cellSize; horizontal += sampleSize) {
        const ny = Math.floor((y * cellSize + vertical + sampleSize / 2) / size);
        const nx = normal[0] ? normal[0] > 0 ? 0 : width - 1 : Math.floor((x * cellSize + horizontal + sampleSize / 2) / size);
        const nz = normal[2] ? normal[2] > 0 ? 0 : width - 1 : Math.floor((z * cellSize + horizontal + sampleSize / 2) / size);
        if (!occludesFace(stateId, neighbor.record.levels[size][index(nx, ny, nz, width)], materials)) return false;
      }
      return true;
    };
    return meshColumn(record, cellSize, materials, tintAt, boundaryOccluded);
  });
  const combine = kind => {
    const values = new Float32Array(meshes.reduce((sum, mesh) => sum + mesh[kind].length, 0));
    let offset = 0; for (const mesh of meshes) {
      values.set(mesh[kind], offset);
      for (let vertex = offset; vertex < offset + mesh[kind].length; vertex += 14) for (let axis = 0; axis < 3; axis++) values[vertex + axis] += mesh.origin[axis] - origin[axis];
      offset += mesh[kind].length;
    }
    return values;
  };
  return { key: `lod:${regionX},${regionZ}`, opaque: combine('opaque'), water: combine('water'),
    origin, bounds: { min: [...origin], max: [(regionX + 1) * extent, minY + height, (regionZ + 1) * extent] }, stride: 14 };
}

if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  let cachedMaterials = new Map(), biomeConfiguration = null, biomeSeed = 0n, biomeBlendRadius = 2, core = null, bounds = dimensionBounds();
  function tintSampler(records) {
    if (!biomeConfiguration || !records.length) return null;
    if (!core) return createBiomeSampler(biomeConfiguration, { seed: biomeSeed, blendRadius: biomeBlendRadius, columns: records });
    const minX = Math.min(...records.map(record => record.x)), minZ = Math.min(...records.map(record => record.z));
    const maxX = Math.max(...records.map(record => record.x)), maxZ = Math.max(...records.map(record => record.z));
    if (!core.world_reset(bounds.minY, bounds.height, minX, minZ, Math.min(32, maxX - minX + 1), Math.min(32, maxZ - minZ + 1))) throw new Error('WASM rejected distant biome sampler bounds.');
    for (const record of records) if (record.biomes) for (let section = 0; section < bounds.height / 16; section++) {
      const pointer = core.world_stage_ptr(); new Uint32Array(core.memory.buffer, pointer, 64).set(record.biomes.subarray(section * 64, (section + 1) * 64));
      if (!core.world_load_biomes(record.x, bounds.minY / 16 + section, record.z, pointer, 64)) throw new Error('WASM rejected distant biome section.');
    }
    return (x, y, z, kind) => tintComponents(core.world_biome_tint(Math.floor(x), Math.floor(y), Math.floor(z), kind));
  }
  const sendRecord = (id, record) => {
    const transfer = record ? [record.occupancy.buffer, ...(record.biomes ? [record.biomes.buffer] : [])] : [];
    if (record) for (const size of [4, 8, 16]) transfer.push(record.levels[size].buffer, record.topHeights[size].buffer);
    self.postMessage({ id, record }, transfer);
  };
  let pending = Promise.resolve();
  self.onmessage = ({ data }) => { pending = pending.then(async () => {
    try {
      if (data.type === 'materials') {
        cachedMaterials = materialMap(data.materials);
        bounds = dimensionBounds(data);
        biomeConfiguration = data.biomeConfiguration; biomeSeed = data.biomeSeed ?? 0n; biomeBlendRadius = data.biomeBlendRadius ?? 2;
        if (biomeConfiguration) {
          try { core = await loadCore(1); if (!core.world_reset(bounds.minY, bounds.height, 0, 0, 1, 1)) throw new Error('WASM rejected distant dimension bounds.'); applyBiomeTints(core, biomeConfiguration, { seed: biomeSeed, blendRadius: biomeBlendRadius }); }
          catch { core = null; }
        }
        self.postMessage({ id: data.id, ready: true, biomeSampler: core ? 'wasm' : biomeConfiguration ? 'javascript' : 'none' });
      } else if (data.type === 'biome-seed') {
        biomeSeed = data.seed; if (core) setBiomeSeed(core, biomeSeed); self.postMessage({ id: data.id, ready: true });
      } else if (data.type === 'reduce') {
        sendRecord(data.id, reduceColumn(data.column, data.materials ?? cachedMaterials, bounds));
      } else if (data.type === 'mesh') {
        const mesh = meshColumn(data.record, data.cellSize, data.materials ?? cachedMaterials, tintSampler([data.record]));
        self.postMessage({ id: data.id, mesh }, [mesh.opaque.buffer, mesh.water.buffer]);
      } else if (data.type === 'region-mesh') {
        const mesh = meshRegion(data.records, data.regionX, data.regionZ, data.regionBatchSize, data.materials ?? cachedMaterials, tintSampler(data.records.map(value => value.record)), bounds);
        self.postMessage({ id: data.id, mesh }, [mesh.opaque.buffer, mesh.water.buffer]);
      } else if (data.type === 'update') {
        sendRecord(data.id, updateReducedBlock(data.record, data.x, data.y, data.z, data.stateId, data.materials ?? cachedMaterials));
      } else throw new Error('Unknown LOD worker request');
    } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  }); };
}
