// Persistent LOD stores source occupancy, not invented terrain or a heightmap.
// The 4-block level retains caves, overhangs, and isolated visible voxels.
const MIN_Y = -64, HEIGHT = 384, INVISIBLE = 128, FLUID = 4;
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
function allocateTops(length) { const tops = new Int16Array(length); tops.fill(MIN_Y - 1); return tops; }
function selectRepresentative(counts) {
  let best = 0, frequency = -1;
  for (const [id, count] of counts) if (count > frequency || (count === frequency && id < best)) { best = id; frequency = count; }
  return best;
}

/** Reduce native sections in (y * 16 + z) * 16 + x order. */
export function reduceColumn(column, materialsInput) {
  if (!Number.isInteger(column?.x) || !Number.isInteger(column?.z)) throw new Error('LOD columns require integer x/z coordinates');
  const materials = materialMap(materialsInput), cells = new Uint16Array(4 * 4 * 96);
  const tops = allocateTops(cells.length), occupancy = new Uint32Array(cells.length * 2);
  const frequencies = new Array(cells.length), seen = new Set();
  for (const section of column.sections ?? []) {
    if (!Number.isInteger(section.sectionY) || !(section.blocks instanceof Uint16Array) || section.blocks.length !== 4096) throw new Error('LOD sections require sectionY and 4096 Uint16 block states');
    if (seen.has(section.sectionY)) throw new Error('Duplicate LOD section');
    seen.add(section.sectionY);
    const sectionBase = section.sectionY * 16;
    if (sectionBase < MIN_Y || sectionBase >= MIN_Y + HEIGHT) continue;
    for (let localY = 0; localY < 16; localY++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const id = section.blocks[index(x, localY, z, 16)];
      if (!visible(id, materials)) continue;
      const y = sectionBase + localY, cell = index(x >> 2, (y - MIN_Y) >> 2, z >> 2, 4);
      const bit = ((y - MIN_Y) & 3) * 16 + (z & 3) * 4 + (x & 3);
      occupancy[cell * 2 + (bit >> 5)] |= 1 << (bit & 31);
      if (y > tops[cell]) { tops[cell] = y; frequencies[cell] = new Map(); }
      if (y === tops[cell]) { const counts = frequencies[cell]; counts.set(id, (counts.get(id) ?? 0) + 1); }
    }
  }
  for (let cell = 0; cell < cells.length; cell++) if (frequencies[cell]) cells[cell] = selectRepresentative(frequencies[cell]);
  const record = { x: column.x, z: column.z, minY: MIN_Y, height: HEIGHT, levels: { 4: cells }, topHeights: { 4: tops }, occupancy, materialStale: false };
  rebuildHigherLevels(record);
  return record;
}

function rebuildHigherLevels(record) {
  for (const size of [8, 16]) {
    const previous = size / 2, previousN = 16 / previous, n = 16 / size;
    const source = record.levels[previous], sourceTops = record.topHeights[previous];
    const cells = new Uint16Array(n * n * HEIGHT / size), tops = allocateTops(cells.length);
    for (let y = 0; y < HEIGHT / size; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const target = index(x, y, z, n), counts = new Map();
      for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const child = index(x * 2 + dx, y * 2 + dy, z * 2 + dz, previousN), id = source[child];
        if (!id) continue;
        const top = sourceTops[child];
        if (top > tops[target]) { tops[target] = top; counts.clear(); }
        if (top === tops[target]) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      if (counts.size) cells[target] = selectRepresentative(counts);
    }
    record.levels[size] = cells; record.topHeights[size] = tops;
  }
}

/**
 * Apply a world-coordinate edit without retaining 4096 raw states per section.
 * Occupancy remains exact. Removing the representative can leave its material
 * approximate until full-column reingestion; materialStale makes that explicit.
 */
export function updateReducedBlock(record, x, y, z, stateId, materialsInput) {
  if (![x, y, z, stateId].every(Number.isInteger) || stateId < 0 || stateId > 65535) throw new Error('LOD block edits require integer coordinates and a Uint16 state');
  const localX = x - record.x * 16, localZ = z - record.z * 16;
  if (localX < 0 || localX >= 16 || localZ < 0 || localZ >= 16 || y < MIN_Y || y >= MIN_Y + HEIGHT) return null;
  if (!(record.occupancy instanceof Uint32Array) || record.occupancy.length !== 3072) throw new Error('LOD edit requires exact occupancy data');
  const materials = materialMap(materialsInput), cellY = (y - MIN_Y) >> 2, cell = index(localX >> 2, cellY, localZ >> 2, 4);
  const bit = ((y - MIN_Y) & 3) * 16 + (localZ & 3) * 4 + (localX & 3), word = cell * 2 + (bit >> 5), mask = 1 << (bit & 31);
  const occupiedBefore = !!(record.occupancy[word] & mask), occupiedAfter = visible(stateId, materials);
  if (occupiedAfter) record.occupancy[word] |= mask; else record.occupancy[word] &= ~mask;
  const low = record.occupancy[cell * 2], high = record.occupancy[cell * 2 + 1];
  if (!low && !high) { record.levels[4][cell] = 0; record.topHeights[4][cell] = MIN_Y - 1; }
  else {
    const highestBit = high ? 63 - Math.clz32(high) : 31 - Math.clz32(low);
    const top = MIN_Y + cellY * 4 + (highestBit >> 4), previousTop = record.topHeights[4][cell];
    if (occupiedAfter && (!record.levels[4][cell] || y > previousTop)) record.levels[4][cell] = stateId;
    else if (occupiedAfter && y === top) {
      // Exact source frequencies are intentionally not persisted. This tie is
      // deterministic, and the next full ingestion restores the majority rule.
      record.levels[4][cell] = Math.min(record.levels[4][cell], stateId); record.materialStale = true;
    }
    if (occupiedBefore && (!occupiedAfter || y <= previousTop)) record.materialStale = true;
    record.topHeights[4][cell] = top;
  }
  rebuildHigherLevels(record);
  return record;
}

/** Mesh standalone closed LOD cubes; differing levels may have visible steps. */
export function meshColumn(record, cellSize, materialsInput) {
  if (![4, 8, 16].includes(cellSize)) throw new Error('LOD cell size must be 4, 8 or 16');
  const materials = materialMap(materialsInput), cells = record.levels[cellSize], n = 16 / cellSize, layers = HEIGHT / cellSize;
  if (!(cells instanceof Uint16Array) || cells.length !== n * n * layers) throw new Error('Invalid LOD level data');
  const opaque = [], water = [], originX = record.x * 16, originZ = record.z * 16;
  const at = (x, y, z) => x < 0 || x >= n || y < 0 || y >= layers || z < 0 || z >= n ? 0 : cells[index(x, y, z, n)];
  for (let y = 0; y < layers; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const stateId = at(x, y, z); if (!stateId || !visible(stateId, materials)) continue;
    const material = materials.get(stateId) ?? UNKNOWN, flags = material.flags ?? 3, fluid = !!(flags & FLUID), output = fluid ? water : opaque;
    for (const [name, normal, corners] of FACE_DATA) {
      const neighbor = at(x + normal[0], y + normal[1], z + normal[2]);
      if (neighbor && visible(neighbor, materials)) {
        const neighborFlags = materials.get(neighbor)?.flags ?? 3;
        const solidNeighbor = !(neighborFlags & (FLUID | 32 | 64));
        if (solidNeighbor || (fluid && (neighborFlags & FLUID) && neighbor === stateId) || neighbor === stateId) continue;
      }
      const face = material.faces?.[name], rectangle = face?.uv ?? [0, 0, 1, 1], rotation = ((face?.rotation ?? 0) / 90) & 3;
      const coordinates = [[rectangle[0], rectangle[3]], [rectangle[0], rectangle[1]], [rectangle[2], rectangle[1]], [rectangle[2], rectangle[3]]];
      const tint = face?.tint ?? material.color ?? [1, 1, 1], tile = face?.tile ?? -1;
      // Source custom meshes become cubes at distance. Preserve alpha/emission
      // and mark full skylight, since compact LOD does not store per-voxel light.
      const packedFlags = (flags & ~16) | 512 | (15 << 10);
      for (const vertex of TRIANGLES) {
        const point = corners[vertex], uv = coordinates[(vertex + rotation) % 4];
        output.push(originX + (x + point[0]) * cellSize, MIN_Y + (y + point[1]) * cellSize, originZ + (z + point[2]) * cellSize,
          ...normal, ...tint, 1, rectangle[0] + (uv[0] - rectangle[0]) * cellSize, rectangle[1] + (uv[1] - rectangle[1]) * cellSize, tile, packedFlags);
      }
    }
  }
  return { key: `lod:${record.x},${record.z}`, opaque: new Float32Array(opaque), water: new Float32Array(water), bounds: { min: [originX, MIN_Y, originZ], max: [originX + 16, MIN_Y + HEIGHT, originZ + 16] }, stride: 14 };
}

/** Batch only known source columns; gaps inside a region remain genuinely empty. */
export function meshRegion(records, regionX, regionZ, regionBatchSize, materialsInput) {
  if (![1, 2, 4, 8].includes(regionBatchSize) || !Number.isInteger(regionX) || !Number.isInteger(regionZ)) throw new Error('Invalid distant region bounds');
  const meshes = records.map(({ record, cellSize }) => {
    if (Math.floor(record.x / regionBatchSize) !== regionX || Math.floor(record.z / regionBatchSize) !== regionZ) throw new Error('Column lies outside the distant mesh region');
    return meshColumn(record, cellSize, materialsInput);
  });
  const combine = kind => {
    const values = new Float32Array(meshes.reduce((sum, mesh) => sum + mesh[kind].length, 0));
    let offset = 0; for (const mesh of meshes) { values.set(mesh[kind], offset); offset += mesh[kind].length; }
    return values;
  };
  const extent = regionBatchSize * 16;
  return { key: `lod:${regionX},${regionZ}`, opaque: combine('opaque'), water: combine('water'),
    bounds: { min: [regionX * extent, MIN_Y, regionZ * extent], max: [(regionX + 1) * extent, MIN_Y + HEIGHT, (regionZ + 1) * extent] }, stride: 14 };
}

if (typeof self !== 'undefined' && typeof document === 'undefined' && typeof self.postMessage === 'function') {
  let cachedMaterials = new Map();
  const sendRecord = (id, record) => {
    const transfer = record ? [record.occupancy.buffer] : [];
    if (record) for (const size of [4, 8, 16]) transfer.push(record.levels[size].buffer, record.topHeights[size].buffer);
    self.postMessage({ id, record }, transfer);
  };
  self.onmessage = ({ data }) => {
    try {
      if (data.type === 'materials') {
        cachedMaterials = materialMap(data.materials);
        self.postMessage({ id: data.id, ready: true });
      } else if (data.type === 'reduce') {
        sendRecord(data.id, reduceColumn(data.column, data.materials ?? cachedMaterials));
      } else if (data.type === 'mesh') {
        const mesh = meshColumn(data.record, data.cellSize, data.materials ?? cachedMaterials);
        self.postMessage({ id: data.id, mesh }, [mesh.opaque.buffer, mesh.water.buffer]);
      } else if (data.type === 'region-mesh') {
        const mesh = meshRegion(data.records, data.regionX, data.regionZ, data.regionBatchSize, data.materials ?? cachedMaterials);
        self.postMessage({ id: data.id, mesh }, [mesh.opaque.buffer, mesh.water.buffer]);
      } else if (data.type === 'update') {
        sendRecord(data.id, updateReducedBlock(data.record, data.x, data.y, data.z, data.stateId, data.materials ?? cachedMaterials));
      } else throw new Error('Unknown LOD worker request');
    } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  };
}
