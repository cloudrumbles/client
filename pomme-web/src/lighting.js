const SIDE = 48;
const PLANE = SIDE * SIDE;
const SECTION_BYTES = 2048;
const OPAQUE = 2, FLUID = 4, CUTOUT = 32;

const keyOf = (x, z) => `${x},${z}`;
const levelOf = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Math.max(0, Math.min(15, Math.ceil(Number(value)))) : null;

function materialTables(materials) {
  if (!(materials instanceof Map)) throw new Error('Lighting requires a native-state material Map.');
  const opacity = new Uint8Array(65536).fill(15), emission = new Uint8Array(65536);
  for (const [id, material] of materials) {
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new Error('Lighting material IDs must fit u16.');
    const filter = levelOf(material.opacity ?? material.filterLight);
    const flags = material.flags ?? 0;
    opacity[id] = filter ?? (flags & OPAQUE ? 15 : flags & (FLUID | CUTOUT) ? 1 : 0);
    emission[id] = levelOf(material.emitLight ?? 0) ?? 0;
  }
  opacity[0] = 0; emission[0] = 0;
  return { opacity, emission };
}

function eachRow(x, z, y0, y1, callback) {
  for (let y = y0; y < y1; y++) {
    for (let dz = 0; dz < 16; dz++) callback((y * SIDE + z + dz) * SIDE + x);
  }
}

function push(buckets, level, index, cellCount) {
  let bucket = buckets[level];
  if (!bucket) bucket = buckets[level] = { data: new Int32Array(Math.min(256, cellCount)), length: 0 };
  if (bucket.length === bucket.data.length) {
    const replacement = new Int32Array(Math.min(cellCount, bucket.data.length * 2));
    replacement.set(bucket.data); bucket.data = replacement;
  }
  bucket.data[bucket.length++] = index;
}

function hasLowerNeighbour(index, level, light, opacity, height) {
  const x = index % SIDE, z = Math.floor(index / SIDE) % SIDE, y = Math.floor(index / PLANE);
  if (x > 0 && level - Math.max(1, opacity[index - 1]) > light[index - 1]) return true;
  if (x + 1 < SIDE && level - Math.max(1, opacity[index + 1]) > light[index + 1]) return true;
  if (z > 0 && level - Math.max(1, opacity[index - SIDE]) > light[index - SIDE]) return true;
  if (z + 1 < SIDE && level - Math.max(1, opacity[index + SIDE]) > light[index + SIDE]) return true;
  if (y > 0 && level - Math.max(1, opacity[index - PLANE]) > light[index - PLANE]) return true;
  return y + 1 < height && level - Math.max(1, opacity[index + PLANE]) > light[index + PLANE];
}

// Highest light levels run first, so a cell's best propagated level is found
// before lower levels can enqueue it. Stale initial seeds are skipped.
function propagate(light, opacity, buckets, height, stats) {
  const offsets = [-1, 1, -SIDE, SIDE, -PLANE, PLANE];
  for (let level = 15; level > 1; level--) {
    const bucket = buckets[level];
    if (!bucket) continue;
    for (let item = 0; item < bucket.length; item++) {
      const index = bucket.data[item];
      if (light[index] !== level) continue;
      stats.processed++;
      const x = index % SIDE, z = Math.floor(index / SIDE) % SIDE, y = Math.floor(index / PLANE);
      for (let direction = 0; direction < 6; direction++) {
        if ((direction === 0 && x === 0) || (direction === 1 && x + 1 === SIDE)
          || (direction === 2 && z === 0) || (direction === 3 && z + 1 === SIDE)
          || (direction === 4 && y === 0) || (direction === 5 && y + 1 === height)) continue;
        const next = index + offsets[direction];
        const value = level - Math.max(1, opacity[next]);
        if (value > light[next]) {
          light[next] = value; stats.updated++;
          if (value > 1) push(buckets, value, next, light.length);
        }
      }
    }
    buckets[level] = null;
  }
}

/** Recompute one local column from immutable world data after an edit.
 * sections: [{sectionY, blocks: Uint16Array(4096)}]; neighbours are full columns
 * in a Map keyed "cx,cz". Missing columns are opaque, not invented empty space.
 * The 3x3 halo contains every possible level-15 source affecting the centre.
 * Server-provided lighting remains authoritative and should bypass this solver.
 */
export function solveColumnLighting({ x, z, sections, neighbors = new Map(), materials,
  minY = -64, height = 384, hasSkylight = true }) {
  if (![x, z, minY, height].every(Number.isSafeInteger) || minY % 16 || height % 16 || height < 16 || height > 1024) throw new Error('Invalid local lighting bounds.');
  if (!Array.isArray(sections) || !(neighbors instanceof Map)) throw new Error('Lighting requires decoded sections and a neighbor Map.');
  const table = materialTables(materials);
  const cells = PLANE * height;
  const opacity = new Uint8Array(cells).fill(15), sky = new Uint8Array(cells), block = new Uint8Array(cells);
  const loaded = [], sources = [];
  const stats = { cells, loadedColumns: 0, uniformSections: 0, processed: 0, updated: 0, cacheHit: false };
  let highestOpacity = -1;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const column = dx === 0 && dz === 0 ? { sections } : neighbors.get(keyOf(x + dx, z + dz));
      if (!column) continue;
      if (!Array.isArray(column.sections)) throw new Error('Lighting neighbors require decoded sections.');
      const gx = (dx + 1) * 16, gz = (dz + 1) * 16;
      loaded.push([gx, gz]); stats.loadedColumns++;
      eachRow(gx, gz, 0, height, row => opacity.fill(0, row, row + 16));
      const seen = new Set();
      for (const section of column.sections) {
        const sy = section.sectionY ?? section.sy;
        if (!Number.isInteger(sy) || seen.has(sy)) throw new Error('Lighting sections require distinct integer Y coordinates.');
        seen.add(sy);
        const values = section.blocks ?? section.states;
        if (!(values instanceof Uint16Array) || values.length !== 4096) throw new Error('Lighting sections require 4096 Uint16 states.');
        const y0 = sy * 16 - minY;
        if (y0 < 0 || y0 >= height) continue;
        const first = values[0];
        let uniform = true;
        for (let i = 1; i < values.length && uniform; i++) uniform = values[i] === first;
        if (uniform) {
          stats.uniformSections++;
          const filter = table.opacity[first], emission = table.emission[first];
          if (filter) { highestOpacity = Math.max(highestOpacity, y0 + 15); eachRow(gx, gz, y0, y0 + 16, row => opacity.fill(filter, row, row + 16)); }
          if (emission) eachRow(gx, gz, y0, y0 + 16, row => {
            block.fill(emission, row, row + 16);
            for (let i = row; i < row + 16; i++) sources.push(i);
          });
        } else {
          for (let ly = 0; ly < 16; ly++) {
            for (let lz = 0; lz < 16; lz++) {
              const row = ((y0 + ly) * SIDE + gz + lz) * SIDE + gx;
              const input = ly * 256 + lz * 16;
              for (let lx = 0; lx < 16; lx++) {
                const id = values[input + lx], filter = table.opacity[id], emission = table.emission[id];
                opacity[row + lx] = filter;
                if (filter) highestOpacity = Math.max(highestOpacity, y0 + ly);
                if (emission) { block[row + lx] = emission; sources.push(row + lx); }
              }
            }
          }
        }
      }
    }
  }

  if (hasSkylight) {
    for (const [gx, gz] of loaded) {
      // Uniform open sky needs neither a per-voxel descent nor a BFS seed.
      eachRow(gx, gz, highestOpacity + 1, height, row => sky.fill(15, row, row + 16));
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          let level = 15;
          for (let y = highestOpacity; y >= 0 && level > 0; y--) {
            const index = (y * SIDE + gz + lz) * SIDE + gx + lx;
            const filter = opacity[index];
            level = Math.max(0, level - (level === 15 ? filter : Math.max(1, filter)));
            sky[index] = level;
          }
        }
      }
    }
    if (highestOpacity >= 0) {
      const buckets = new Array(16);
      const limit = Math.min(height, highestOpacity + 2) * PLANE;
      for (let index = 0; index < limit; index++) {
        const level = sky[index];
        if (level > 1 && hasLowerNeighbour(index, level, sky, opacity, height)) push(buckets, level, index, cells);
      }
      propagate(sky, opacity, buckets, height, stats);
    }
  }
  const buckets = new Array(16);
  for (const index of sources) {
    const level = block[index];
    if (level > 1 && hasLowerNeighbour(index, level, block, opacity, height)) push(buckets, level, index, cells);
  }
  propagate(block, opacity, buckets, height, stats);

  const packedSky = new Map(), packedBlock = new Map();
  for (let s = 0; s < height / 16; s++) {
    const skyBytes = new Uint8Array(SECTION_BYTES), blockBytes = new Uint8Array(SECTION_BYTES);
    for (let ly = 0; ly < 16; ly++) {
      for (let lz = 0; lz < 16; lz++) {
        const row = ((s * 16 + ly) * SIDE + 16 + lz) * SIDE + 16;
        const input = ly * 256 + lz * 16;
        for (let lx = 0; lx < 16; lx++) {
          const index = input + lx, shift = (index & 1) * 4;
          skyBytes[index >>> 1] |= sky[row + lx] << shift;
          blockBytes[index >>> 1] |= block[row + lx] << shift;
        }
      }
    }
    packedSky.set(minY / 16 + s, skyBytes); packedBlock.set(minY / 16 + s, blockBytes);
  }
  return { sky: packedSky, block: packedBlock, stats };
}

function copied(result, cacheHit) {
  return { sky: new Map([...result.sky].map(([sy, bytes]) => [sy, bytes.slice()])),
    block: new Map([...result.block].map(([sy, bytes]) => [sy, bytes.slice()])), stats: { ...result.stats, cacheHit } };
}

/** Optional bounded cache. Every loaded column needs an explicit monotonic
 * revision; calls without reliable revisions bypass caching. Bump
 * materialsRevision after editing a material map, or clear/invalidate manually.
 * Returned arrays are detached copies suitable for worker transfers.
 */
export class ColumnLightingCache {
  constructor({ maxEntries = 32, maxBytes = 8 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('Invalid light-cache budget.');
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.entries = new Map(); this.bytes = 0; this.materialIds = new WeakMap(); this.nextMaterialId = 1;
  }
  signature(input) {
    if (!Number.isSafeInteger(input.revision) || !(input.materials instanceof Map)) return null;
    if (!this.materialIds.has(input.materials)) this.materialIds.set(input.materials, this.nextMaterialId++);
    const signature = [input.revision, this.materialIds.get(input.materials), input.materialsRevision ?? 0, input.minY ?? -64, input.height ?? 384, input.hasSkylight ?? true];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const neighbor = input.neighbors?.get(keyOf(input.x + dx, input.z + dz));
      if (!neighbor) signature.push('missing');
      else if (!Number.isSafeInteger(neighbor.revision)) return null;
      else signature.push(neighbor.revision);
    }
    return signature.join('|');
  }
  solve(input) {
    const key = keyOf(input.x, input.z), signature = this.signature(input), hit = this.entries.get(key);
    if (signature !== null && hit?.signature === signature) {
      this.entries.delete(key); this.entries.set(key, hit); return copied(hit.result, true);
    }
    if (hit) { this.entries.delete(key); this.bytes -= hit.bytes; }
    const result = solveColumnLighting(input);
    if (signature === null) return result;
    const bytes = [...result.sky.values(), ...result.block.values()].reduce((sum, data) => sum + data.byteLength, 0);
    if (this.maxEntries && bytes <= this.maxBytes) {
      this.entries.set(key, { signature, result, bytes }); this.bytes += bytes;
      while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
        const [oldKey, old] = this.entries.entries().next().value;
        this.entries.delete(oldKey); this.bytes -= old.bytes;
      }
    }
    return copied(result, false);
  }
  invalidate(x, z) {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const key = keyOf(x + dx, z + dz), entry = this.entries.get(key);
      if (entry) { this.entries.delete(key); this.bytes -= entry.bytes; }
    }
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}
