// Retain only the source registry data needed by immersion fog. Definitions
// replace lower pack entries; native tag values append unless replace=true.
export const ENVIRONMENT_SOURCE_LIMITS = Object.freeze({ definitions: 4096, tagValues: 4096, nodes: 100000, depth: 64 });
export class EnvironmentSources {
  constructor() { this.dimensions = new Map(); this.timelines = new Map(); this.timelineTags = new Map(); this.biomeTags = new Map(); this.biomeMembership = new Map(); }
  ingest(path, definition) {
    const match = /^data\/([a-z0-9_.-]+)\/(dimension_type|timeline|tags\/timeline|tags\/worldgen\/biome)\/([a-z0-9_./-]+)\.json$/.exec(path);
    if (!match) return false;
    if (match[3].split('/').includes('..') || !definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('Invalid native environment source definition.');
    let nodes = 0;
    function visit(value, depth = 0) {
      if (++nodes > ENVIRONMENT_SOURCE_LIMITS.nodes || depth > ENVIRONMENT_SOURCE_LIMITS.depth) throw new Error('Native environment source exceeds its structural bound.');
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Native environment source contains a nonfinite number.');
      if (typeof value === 'string' && value.length > 4096) throw new Error('Native environment source string exceeds its bound.');
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (key.length > 256) throw new Error('Native environment source key exceeds its bound.'); visit(child, depth + 1); }
    }
    visit(definition);
    const id = `${match[1]}:${match[3]}`, map = match[2] === 'dimension_type' ? this.dimensions : match[2] === 'timeline' ? this.timelines : match[2] === 'tags/timeline' ? this.timelineTags : this.biomeTags;
    if (!map.has(id) && map.size >= ENVIRONMENT_SOURCE_LIMITS.definitions) throw new Error('Native environment source registry exceeds its bound.');
    if (match[2].startsWith('tags/')) {
      if (!Array.isArray(definition.values) || definition.values.length > ENVIRONMENT_SOURCE_LIMITS.tagValues || definition.replace !== undefined && typeof definition.replace !== 'boolean') throw new Error('Invalid native environment source tag.');
      const values = definition.replace ? [] : map.get(id)?.values ?? [];
      const merged = [...values, ...definition.values];
      if (merged.length > ENVIRONMENT_SOURCE_LIMITS.tagValues) throw new Error('Native environment tag stack exceeds its value bound.');
      map.set(id, { ...definition, values: merged }); this.biomeMembership.clear();
    } else map.set(id, definition);
    return true;
  }
  biomeHasTag(tag, name, diagnostics = []) {
    const qualify = value => value.includes(':') ? value : `minecraft:${value}`;
    const id = qualify(tag), cached = this.biomeMembership.get(id); if (cached) return cached.has(name);
    const visited = new Set(), members = new Set(); let references = 0;
    const walk = (current, path = new Set()) => {
      if (path.has(current) || path.size >= 32) throw new Error('Cyclic or excessively deep native environment biome tag.');
      if (visited.has(current)) return;
      const source = this.biomeTags.get(current);
      if (!source) { diagnostics.push(`Missing native biome tag ${current}.`); return; }
      visited.add(current); const next = new Set(path); next.add(current);
      for (const entry of source.values) {
        if (++references > ENVIRONMENT_SOURCE_LIMITS.nodes) throw new Error('Native biome tag expansion exceeds its reference bound.');
        const value = typeof entry === 'string' ? entry : entry?.id;
        if (typeof value !== 'string') throw new Error('Invalid native biome tag entry.');
        if (value.startsWith('#')) { const ref = qualify(value.slice(1)); if (entry?.required === false && !this.biomeTags.has(ref)) continue; walk(ref, next); }
        else { members.add(qualify(value)); if (members.size > ENVIRONMENT_SOURCE_LIMITS.tagValues) throw new Error('Native biome tag membership exceeds its bound.'); }
      }
    };
    walk(id);
    if (this.biomeMembership.size >= 32) this.biomeMembership.delete(this.biomeMembership.keys().next().value);
    if (diagnostics.length === 0) this.biomeMembership.set(id, members);
    return members.has(name);
  }
}
