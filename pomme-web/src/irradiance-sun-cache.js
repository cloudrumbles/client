import { IRRADIANCE_LIMITS } from './irradiance.js';

// A single exact source band owns all cached angles. Compression preserves
// half-float RGB bits; alpha is source-dependent and shared by all angles.
export function sameIrradianceSource(left, right) {
  if (!left || !right || left.hasSkylight !== right.hasSkylight) return false;
  for (const name of ['origin', 'dimensions', 'states', 'known', 'sky', 'block']) {
    const a = left[name], b = right[name]; if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  }
  return true;
}
export function copyIrradianceSource(snapshot) {
  return Object.fromEntries(['origin', 'dimensions', 'states', 'known', 'sky', 'block'].map(name => [name, snapshot[name].slice()]).concat([['hasSkylight', snapshot.hasSkylight]]));
}

export class IrradianceSunCache {
  constructor({ maxBytes = IRRADIANCE_LIMITS.maxSunCacheBytes } = {}) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > IRRADIANCE_LIMITS.maxSunCacheBytes) throw new Error('Invalid irradiance sun-cache budget.');
    this.maxBytes = maxBytes; this.clear();
  }
  clear() { this.entries = new Map(); this.bytes = 0; this.alpha = null; }
  import(bucket, { alpha, entry }) {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= IRRADIANCE_LIMITS.sunBuckets || !(alpha instanceof Uint16Array) || !alpha.length || alpha.length > IRRADIANCE_LIMITS.maxCells || alpha.some(value => value !== 0 && value !== 0x3c00) || !(entry?.rgb instanceof Uint16Array) || entry.rgb.some(value => value > 0x3800)) throw new Error('Invalid stored irradiance sun cache.');
    if (entry.lengths !== undefined) {
      if (!(entry.lengths instanceof Uint32Array) || !entry.lengths.length || entry.lengths.length > alpha.length || entry.rgb.length !== entry.lengths.length * 3 || entry.lengths.some(value => !value || value > alpha.length) || entry.lengths.reduce((total, value) => total + value, 0) !== alpha.length) throw new Error('Invalid stored irradiance sun runs.');
    } else if (entry.rgb.length !== alpha.length * 3) throw new Error('Invalid stored irradiance sun RGB.');
    if (this.alpha && (this.alpha.length !== alpha.length || this.alpha.some((value, index) => value !== alpha[index]))) throw new Error('Stored irradiance visibility differs from the active source.');
    this.alpha ??= alpha.slice();
    const copy = { rgb: entry.rgb.slice(), ...(entry.lengths ? { lengths: entry.lengths.slice() } : {}) };
    copy.bytes = copy.rgb.byteLength + (copy.lengths?.byteLength ?? 0);
    this.retain(bucket, copy);
  }
  export(bucket) {
    const entry = this.entries.get(bucket); return entry ? { alpha: this.alpha, entry } : null;
  }
  store(bucket, data) {
    if (!Number.isInteger(bucket) || bucket < 0 || bucket >= IRRADIANCE_LIMITS.sunBuckets || !(data instanceof Uint16Array) || !data.length || data.length % 4 || data.length / 4 > IRRADIANCE_LIMITS.maxCells) throw new Error('Invalid irradiance sun-cache result.');
    const cells = data.length / 4;
    if (!this.alpha) { this.alpha = new Uint16Array(cells); for (let cell = 0; cell < cells; cell++) this.alpha[cell] = data[cell * 4 + 3]; }
    else if (this.alpha.length !== cells || this.alpha.some((value, cell) => value !== data[cell * 4 + 3])) throw new Error('Irradiance sun cache requires unchanged source visibility.');
    let runs = 1;
    for (let cell = 1; cell < cells; cell++) {
      const at = cell * 4, previous = at - 4;
      if (data[at] !== data[previous] || data[at + 1] !== data[previous + 1] || data[at + 2] !== data[previous + 2]) runs++;
    }
    let entry;
    if (runs * 10 < cells * 6) {
      const lengths = new Uint32Array(runs), rgb = new Uint16Array(runs * 3);
      let run = 0; lengths[0] = 1; rgb.set(data.subarray(0, 3));
      for (let cell = 1; cell < cells; cell++) {
        const at = cell * 4, current = run * 3;
        if (data[at] === rgb[current] && data[at + 1] === rgb[current + 1] && data[at + 2] === rgb[current + 2]) lengths[run]++;
        else { run++; lengths[run] = 1; const target = run * 3; rgb[target] = data[at]; rgb[target + 1] = data[at + 1]; rgb[target + 2] = data[at + 2]; }
      }
      entry = { lengths, rgb, bytes: lengths.byteLength + rgb.byteLength };
    } else {
      const rgb = new Uint16Array(cells * 3);
      for (let cell = 0; cell < cells; cell++) { const at = cell * 4, target = cell * 3; rgb[target] = data[at]; rgb[target + 1] = data[at + 1]; rgb[target + 2] = data[at + 2]; }
      entry = { rgb, bytes: rgb.byteLength };
    }
    this.retain(bucket, entry);
  }
  retain(bucket, entry) {
    const previous = this.entries.get(bucket);
    if (previous) { this.bytes -= previous.bytes; this.entries.delete(bucket); }
    if (entry.bytes > this.maxBytes) return;
    while (this.bytes + entry.bytes > this.maxBytes || this.entries.size >= IRRADIANCE_LIMITS.sunBuckets) {
      const key = this.entries.keys().next().value, oldest = this.entries.get(key);
      this.entries.delete(key); this.bytes -= oldest.bytes;
    }
    this.entries.set(bucket, entry); this.bytes += entry.bytes;
  }
  get(bucket) {
    const entry = this.entries.get(bucket); if (!entry) return null;
    this.entries.delete(bucket); this.entries.set(bucket, entry);
    const data = new Uint16Array(this.alpha.length * 4);
    let cell = 0;
    if (entry.lengths) {
      for (let run = 0; run < entry.lengths.length; run++) {
        const source = run * 3, red = entry.rgb[source], green = entry.rgb[source + 1], blue = entry.rgb[source + 2];
        for (let count = 0; count < entry.lengths[run]; count++, cell++) {
          const at = cell * 4; data[at] = red; data[at + 1] = green; data[at + 2] = blue; data[at + 3] = this.alpha[cell];
        }
      }
    } else for (; cell < this.alpha.length; cell++) { const at = cell * 4, source = cell * 3; data[at] = entry.rgb[source]; data[at + 1] = entry.rgb[source + 1]; data[at + 2] = entry.rgb[source + 2]; data[at + 3] = this.alpha[cell]; }
    return data;
  }
  stats() { return { sunCacheEntries: this.entries.size, sunCacheBytes: this.bytes + (this.alpha?.byteLength ?? 0), sunCacheMaxBytes: this.maxBytes + IRRADIANCE_LIMITS.maxCells * 2 }; }
}
