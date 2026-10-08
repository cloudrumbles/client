// An optional, bounded lighting approximation. Native sky/block light stays
// authoritative; these cells supply source color and one material-colored
// bounce. This is independent code, not a translated shader-pack algorithm.
export const IRRADIANCE_LIMITS = Object.freeze({ dimensions: [48, 32, 48], maxCells: 48 * 32 * 48, sunBuckets: 240, maxColumns: 16, maxSections: 3, materialBytes: 8 * 65536,
  maxSunCacheBytes: 32 * 1024 * 1024 });
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const srgb = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
const byte = value => Math.round(clamp(Number(value) || 0, 0, 1) * 255);
const normalize = vector => { const length = Math.hypot(...vector); return vector.map(value => value / length); };

/** Compact tables do not retain the resource pack or 384-block-height columns. */
export function irradianceMaterials(materials, atlas = null) {
  if (!(materials instanceof Map) || materials.size > 65536) throw new Error('Irradiance requires at most 65536 native materials.');
  const opacity = new Uint8Array(65536).fill(15), emission = new Uint8Array(65536);
  const albedo = new Uint8Array(65536 * 3), emissionColor = new Uint8Array(65536 * 3);
  for (const [id, material] of materials) {
    if (!Number.isInteger(id) || id < 0 || id > 65535 || !material || typeof material !== 'object') throw new Error('Invalid irradiance material.');
    const filter = Number(material.opacity ?? material.filterLight);
    opacity[id] = Number.isFinite(filter) ? clamp(Math.ceil(filter), 0, 15) : (material.flags & 2 ? 15 : material.flags & 36 ? 1 : 0);
    emission[id] = clamp(Math.ceil(Number(material.emitLight) || 0), 0, 15);
    let reflected = [0, 0, 0], faces = 0;
    for (const face of Object.values(material.faces ?? {})) {
      const texture = atlas?.tiles?.[face.tile]?.averageColor;
      if (!texture) continue;
      const tint = face.tint ?? material.color ?? [1, 1, 1];
      for (let channel = 0; channel < 3; channel++) reflected[channel] += srgb(clamp((texture[channel] ?? 1) * (tint[channel] ?? 1), 0, 1));
      faces++;
    }
    reflected = faces ? reflected.map(value => value / faces) : (material.color ?? [.5, .5, .5]).map(value => srgb(clamp(Number(value) || 0, 0, 1)));
    albedo.set(reflected.map(byte), id * 3);
    // Native light levels have no RGB definition. These explicitly artistic
    // source hues can be overridden by an imported material's emissionColor.
    const name = String(material.name ?? '');
    let source = material.emissionColor ?? (/soul_(?:torch|lantern|fire|campfire)/.test(name) ? [.2, .8, 1] : /redstone_(?:torch|wall_torch)/.test(name) ? [1, .08, .025] : /(?:torch|lantern|campfire|lava|fire)$/.test(name) ? [1, .55, .18] : reflected);
    const peak = Math.max(...source, .001);
    emissionColor.set(source.map(value => byte(value / peak)), id * 3);
  }
  opacity[0] = 0;
  return { opacity, emission, albedo, emissionColor };
}

export function validateIrradianceTables(tables) {
  for (const [name, size] of [['opacity', 65536], ['emission', 65536], ['albedo', 196608], ['emissionColor', 196608]]) {
    if (!(tables?.[name] instanceof Uint8Array) || tables[name].length !== size) throw new Error(`Invalid irradiance ${name} table.`);
  }
  if (tables.opacity.some(value => value > 15) || tables.emission.some(value => value > 15)) throw new Error('Irradiance light levels must fit native nibbles.');
  return tables;
}

export function validateIrradianceSnapshot(input) {
  if (!input || !Array.isArray(input.origin) || input.origin.length !== 3 || !input.origin.every(Number.isSafeInteger)) throw new Error('Invalid irradiance origin.');
  const dimensions = input.dimensions;
  if (!Array.isArray(dimensions) || dimensions.length !== 3 || dimensions.some((value, axis) => !Number.isInteger(value) || value < 1 || value > IRRADIANCE_LIMITS.dimensions[axis])) throw new Error('Irradiance exceeds the fixed spatial budget.');
  const cells = dimensions.reduce((a, b) => a * b, 1);
  if (cells > IRRADIANCE_LIMITS.maxCells || input.origin.some((value, axis) => !Number.isSafeInteger(value + dimensions[axis]))) throw new Error('Irradiance exceeds the fixed spatial budget.');
  for (const [name, Type] of [['states', Uint16Array], ['known', Uint8Array], ['sky', Uint8Array], ['block', Uint8Array]]) {
    if (!(input[name] instanceof Type) || input[name].length !== cells) throw new Error(`Invalid irradiance ${name} snapshot.`);
  }
  if (input.known.some(value => value > 1) || input.sky.some(value => value > 15) || input.block.some(value => value > 15)) throw new Error('Invalid irradiance visibility or native light.');
  if (!Number.isInteger(input.sunBucket) || input.sunBucket < 0 || input.sunBucket >= IRRADIANCE_LIMITS.sunBuckets || typeof input.hasSkylight !== 'boolean') throw new Error('Invalid irradiance sun state.');
  return cells;
}

export function irradianceSun(bucket, hasSkylight = true) {
  const angle = (bucket + .5) / IRRADIANCE_LIMITS.sunBuckets * Math.PI * 2;
  const source = normalize([Math.cos(angle) * .75, Math.sin(angle), -Math.cos(angle) * .45]);
  const daytime = source[1] >= 0;
  const direction = normalize([source[0] * (daytime ? 1 : -1), Math.max(Math.abs(source[1]), .1), source[2] * (daytime ? 1 : -1)]);
  const warm = 1 - clamp((source[1] - .08) / (.65 - .08), 0, 1);
  return { direction, color: daytime ? [1, .96 - warm * .28, .85 - warm * .42] : [.42, .57, .89], intensity: hasSkylight ? (daytime ? clamp((source[1] + .1) / .32, 0, 1) : .018) : 0 };
}

export function floatToHalf(value) {
  // Lighting is finite, positive and bounded. This avoids per-cell typed-array
  // allocations and handles subnormal values with nearest rounding.
  if (!(value > 0)) return 0;
  if (value < 2 ** -14) return Math.min(1023, Math.round(value * 2 ** 24));
  if (value >= 65504) return 0x7bff;
  const exponent = Math.floor(Math.log2(value)), scale = 2 ** exponent;
  return ((exponent + 15) << 10) + Math.round((value / scale - 1) * 1024);
}

const workSlice = 4096;
const offsetsFor = ([width, height]) => [-1, 1, -width * height, width * height, -width, width];
const neighborMask = (index, dimensions) => {
  const [width, height, depth] = dimensions, x = index % width, y = Math.floor(index / width) % height, z = Math.floor(index / (width * height));
  return Number(x > 0) | Number(x + 1 < width) << 1 | Number(z > 0) << 2 | Number(z + 1 < depth) << 3 | Number(y > 0) << 4 | Number(y + 1 < height) << 5;
};

export function snapshotGeometryKey(input) {
  // Include sky/block arrays: server light updates can change bounce visibility
  // independently of geometry. Sun is intentionally excluded from local reuse.
  let hash = 2166136261;
  for (const bytes of [input.states, input.known, input.sky, input.block]) {
    for (let index = 0; index < bytes.length; index++) { hash ^= bytes[index]; hash = Math.imul(hash, 16777619); }
  }
  return `${input.origin.join(',')}:${input.dimensions.join(',')}:${hash >>> 0}`;
}

/** Each yielded slice has a fixed cell budget. A worker may process reset or
 * cancellation messages between slices. The native arrays are never mutated. */
export function* computeIrradiance(input, tables, cachedLocal = null) {
  const cells = validateIrradianceSnapshot(input);
  validateIrradianceTables(tables);
  const { states, known, sky, dimensions } = input, offsets = offsetsFor(dimensions);
  const opacity = new Uint8Array(cells).fill(15), masks = new Uint8Array(cells), seed = new Uint8Array(cells * 3);
  let current = new Uint8Array(cells * 3), next = new Uint8Array(cells * 3), sourceCells = 0, processedCells = 0;
  for (let start = 0; start < cells; start += workSlice) {
    for (let index = start; index < Math.min(cells, start + workSlice); index++) {
      if (!known[index]) continue;
      const id = states[index]; opacity[index] = tables.opacity[id];
      if (opacity[index] < 15) masks[index] = neighborMask(index, dimensions);
      if (tables.emission[id]) {
        sourceCells++;
        for (let channel = 0; channel < 3; channel++) seed[index * 3 + channel] = Math.round(tables.emission[id] * tables.emissionColor[id * 3 + channel] / 255);
      }
    }
    yield { stage: 'geometry', processedCells: processedCells += Math.min(workSlice, cells - start) };
  }
  let localCacheHit = false;
  if (cachedLocal instanceof Uint8Array && cachedLocal.length === cells * 3) {
    current.set(cachedLocal); localCacheHit = true;
  } else {
    current.set(seed);
    // Component-wise max propagation is stable and energy bounded. Its native
    // voxel opacity prevents color crossing an unknown cell or a solid wall.
    for (let pass = 0; pass < 15 && sourceCells; pass++) {
      let changed = false;
      next.set(seed);
      for (let start = 0; start < cells; start += workSlice) {
        for (let index = start; index < Math.min(cells, start + workSlice); index++) {
          const mask = masks[index];
          if (!mask) continue;
          const target = index * 3, attenuation = Math.max(1, opacity[index]);
          let red = seed[target], green = seed[target + 1], blue = seed[target + 2];
          for (let face = 0; face < 6; face++) if (mask & 1 << face) {
            const source = (index + offsets[face]) * 3;
            red = Math.max(red, current[source] - attenuation);
            green = Math.max(green, current[source + 1] - attenuation);
            blue = Math.max(blue, current[source + 2] - attenuation);
          }
          changed ||= red !== current[target] || green !== current[target + 1] || blue !== current[target + 2];
          next[target] = red; next[target + 1] = green; next[target + 2] = blue;
        }
        yield { stage: 'local', pass, processedCells: processedCells += Math.min(workSlice, cells - start) };
      }
      [current, next] = [next, current];
      if (!changed) break;
    }
  }
  const sun = irradianceSun(input.sunBucket, input.hasSkylight), normal = [[-1,0,0], [1,0,0], [0,0,-1], [0,0,1], [0,-1,0], [0,1,0]];
  const bounceSeed = new Float32Array(cells * 3);
  const [width, height, depth] = dimensions;
  const sunVisible = index => {
    if (!known[index] || sky[index] < 1) return 0;
    const point = [index % width + .5, Math.floor(index / width) % height + .5, Math.floor(index / (width * height)) + .5];
    let visibility = 1;
    // A short exact-voxel ray adds nearby directional occlusion. Outside the
    // band only native level-15 sky permits continuation; unknown is blocked.
    const position = point.map(Math.floor), direction = sun.direction.map(value => Math.sign(value));
    const delta = sun.direction.map(value => Math.abs(value) < 1e-12 ? Infinity : Math.abs(1 / value));
    const nextBoundary = delta.map(value => value * .5);
    for (let step = 0; step < 64; step++) {
      const distance = Math.min(...nextBoundary);
      if (distance > 16) return visibility * sky[index] / 15;
      for (let axis = 0; axis < 3; axis++) if (nextBoundary[axis] <= distance + 1e-10) { position[axis] += direction[axis]; nextBoundary[axis] += delta[axis]; }
      const [x, y, z] = position;
      if (x < 0 || x >= width || y < 0 || y >= height || z < 0 || z >= depth) return sky[index] === 15 ? visibility : 0;
      const cell = (z * height + y) * width + x;
      if (!known[cell] || opacity[cell] === 15) return 0;
      visibility *= 1 - opacity[cell] / 15;
      if (visibility < .01) return 0;
    }
    return visibility * sky[index] / 15;
  };
  for (let start = 0; start < cells; start += workSlice) {
    if (sun.intensity) for (let index = start; index < Math.min(cells, start + workSlice); index++) {
      if (!known[index] || opacity[index] >= 15) continue;
      const mask = masks[index];
      let visible = null;
      for (let face = 0; face < 6; face++) {
        if (!(mask & 1 << face)) continue;
        const surface = index + offsets[face];
        if (!known[surface] || opacity[surface] < 15) continue;
        const facing = Math.max(0, -normal[face].reduce((sum, value, axis) => sum + value * sun.direction[axis], 0));
        if (!facing) continue;
        visible ??= sunVisible(index);
        const strength = visible * facing * sun.intensity * .16;
        for (let channel = 0; channel < 3; channel++) bounceSeed[index * 3 + channel] += tables.albedo[states[surface] * 3 + channel] / 255 * sun.color[channel] * strength;
      }
    }
    yield { stage: 'sun-bounce', processedCells: processedCells += Math.min(workSlice, cells - start) };
  }
  let bounce = bounceSeed.slice(), bounceNext = new Float32Array(cells * 3);
  for (let pass = 0; pass < 4 && sun.intensity; pass++) {
    for (let start = 0; start < cells; start += workSlice) {
      for (let index = start; index < Math.min(cells, start + workSlice); index++) {
        const target = index * 3, mask = masks[index], attenuation = .66 * (1 - opacity[index] / 15);
        let red = bounceSeed[target], green = bounceSeed[target + 1], blue = bounceSeed[target + 2];
        for (let face = 0; face < 6; face++) if (mask & 1 << face) {
          const source = (index + offsets[face]) * 3;
          red = Math.max(red, bounce[source] * attenuation);
          green = Math.max(green, bounce[source + 1] * attenuation);
          blue = Math.max(blue, bounce[source + 2] * attenuation);
        }
        bounceNext[target] = Math.min(.5, red); bounceNext[target + 1] = Math.min(.5, green); bounceNext[target + 2] = Math.min(.5, blue);
      }
      yield { stage: 'bounce-transport', pass, processedCells: processedCells += Math.min(workSlice, cells - start) };
    }
    [bounce, bounceNext] = [bounceNext, bounce];
  }
  const localData = new Uint16Array(cells * 4), bounceData = new Uint16Array(cells * 4);
  for (let start = 0; start < cells; start += workSlice) {
    for (let index = start; index < Math.min(cells, start + workSlice); index++) {
      const source = index * 3, target = index * 4;
      for (let channel = 0; channel < 3; channel++) {
        localData[target + channel] = floatToHalf(current[source + channel] / 15);
        bounceData[target + channel] = floatToHalf(bounce[source + channel]);
      }
      localData[target + 3] = floatToHalf(Math.max(current[source], current[source + 1], current[source + 2]) / 15);
      bounceData[target + 3] = known[index] && opacity[index] < 15 ? 0x3c00 : 0;
    }
    yield { stage: 'pack', processedCells: processedCells += Math.min(workSlice, cells - start) };
  }
  return { origin: [...input.origin], dimensions: [...dimensions], cellSize: 1, format: 'rgba16float', layout: 'x-fastest,y,z', localData, bounceData,
    localCache: current, stats: { cells, sourceCells, processedCells, localCacheHit, outputBytes: localData.byteLength + bounceData.byteLength, algorithm: 'bounded max RGB transport and one diffuse sun bounce' } };
}

export function solveIrradiance(input, tables, cachedLocal = null) {
  const computation = computeIrradiance(input, tables, cachedLocal);
  let step; do { step = computation.next(); } while (!step.done);
  return step.value;
}
