import { BrowserAuthority } from './client.js';

const keyOf = (x, sectionY, z) => `${x},${sectionY},${z}`;
const sameBlocks = (a, b) => a?.length === b?.length && a.every((value, index) => value === b[index]);
const MAX_AUTHORITY_SECTIONS = 1024, BATCH_SECTIONS = 32;

/** Adds a bounded authority scope while preserving the complete imported world. */
export class AuthorityWorldBridge {
  static async open({ world, columns = [], onEvents = () => {}, onRetireOverlays = () => {}, isCurrent = () => true, maxSections = MAX_AUTHORITY_SECTIONS, center, ...options }) {
    const bridge = new AuthorityWorldBridge(world, maxSections, onRetireOverlays, isCurrent);
    bridge.assertCurrent();
    bridge.sources = new Map();
    for (const column of [...(world.columns?.values() ?? []), ...columns]) {
      bridge.trackSource(column);
      const key = `${column.x},${column.z}`, previous = bridge.sources.get(key), sections = new Map((previous?.sections ?? []).map(section => [section.sectionY, section]));
      for (const section of column.sections) sections.set(section.sectionY, section);
      bridge.sources.set(key, { ...previous, ...column, sections: [...sections.values()] });
    }
    bridge.authority = await BrowserAuthority.open({ ...options, autoTick: false, onEvents: (events, state) => {
      if (!bridge.current()) { if (!bridge.closed) void bridge.close({ save: false }).catch(() => {}); return; }
      for (const event of events) { if (!bridge.current()) return; world.setBlock(event.x, event.y, event.z, event.stateId); }
      if (!bridge.current()) return;
      onEvents(events, state);
    } });
    try {
      bridge.assertCurrent();
      const restored = await bridge.authority.sections();
      bridge.assertCurrent();
      for (const section of restored) bridge.keys.add(keyOf(section.x, section.sectionY, section.z));
      const ordered = [...bridge.sources.values()];
      if (center) ordered.sort((a, b) => Math.hypot(a.x * 16 + 8 - center[0], a.z * 16 + 8 - center[2]) - Math.hypot(b.x * 16 + 8 - center[0], b.z * 16 + 8 - center[2]));
      await bridge.admit(ordered);
      bridge.assertCurrent();
      await bridge.authority.save();
      bridge.assertCurrent();
      const savedColumns = await bridge.authority.columns();
      bridge.assertCurrent();
      const authoritative = new Map(savedColumns.map(column => [`${column.x},${column.z}`, column]));
      for (const [key, column] of bridge.sources) bridge.mergeColumn(column, authoritative.get(key), { retireOverlays: true });
      for (const [key, column] of authoritative) if (!bridge.sources.has(key)) bridge.mergeColumn(null, column, { retireOverlays: true });
      bridge.sources.clear();
      if (options.autoTick) { await bridge.authority.start(); bridge.assertCurrent(); }
      return bridge;
    } catch (error) {
      if (bridge.authority && bridge.closedAuthority !== bridge.authority) await bridge.authority.close({ save: false });
      await bridge.close({ save: false }); throw error;
    }
  }
  constructor(world, maxSections, onRetireOverlays, isCurrent = () => true) {
    if (!Number.isInteger(maxSections) || maxSections < 1 || maxSections > MAX_AUTHORITY_SECTIONS) throw new Error('Authority scope must contain between 1 and 1024 sections.');
    this.world = world; this.maxSections = maxSections; this.keys = new Set(); this.catalog = new Map(); this.onRetireOverlays = onRetireOverlays; this.isCurrent = isCurrent;
  }
  current() { return !this.closed && this.isCurrent(); }
  assertCurrent() {
    if (this.current()) return;
    const error = new Error('Browser authority belongs to an inactive world.'); error.name = 'AbortError'; error.code = 'AUTHORITY_STALE_WORLD';
    if (!this.closed) void this.close({ save: false }).catch(() => {});
    throw error;
  }
  get state() { return this.authority.state; }
  covers(x, y, z) { return this.keys.has(keyOf(Math.floor(x / 16), Math.floor(y / 16), Math.floor(z / 16))); }
  trackSource(column) {
    const key = `${column.x},${column.z}`;
    if (!this.catalog.has(key) && this.catalog.size >= 16384) { this.catalogTruncated = true; return; }
    const sections = this.catalog.get(key) ?? new Set();
    for (const section of column.sections) if (sections.size < 256) sections.add(section.sectionY);
    this.catalog.set(key, sections);
  }
  stats() { return { sections: this.keys.size, maxSections: this.maxSections, sourceSections: [...this.catalog.values()].reduce((sum, sections) => sum + sections.size, 0), complete: !this.catalogTruncated && [...this.catalog].every(([key, sections]) => { const [x, z] = key.split(',').map(Number); return [...sections].every(sectionY => this.keys.has(keyOf(x, sectionY, z))); }) }; }
  async admit(columns, { overwrite = false } = {}) {
    this.assertCurrent();
    let batch = [], count = 0;
    const send = async () => {
      if (!batch.length) return;
      this.assertCurrent();
      await this.authority.loadColumns(batch);
      this.assertCurrent();
      for (const column of batch) for (const section of column.sections) this.keys.add(keyOf(column.x, section.sectionY, column.z));
      batch = []; count = 0;
    };
    for (const column of columns) for (const section of column.sections) {
      const key = keyOf(column.x, section.sectionY, column.z), present = this.keys.has(key);
      if (present && !overwrite || !present && this.keys.size + count >= this.maxSections) continue;
      batch.push({ ...column, sections: [section] }); count++;
      if (count >= BATCH_SECTIONS) { await send(); this.assertCurrent(); }
    }
    await send();
    this.assertCurrent();
  }
  needsOverlayRetirement(x, z) {
    const overlays = this.world.overlays?.get(`${x},${z}`);
    return [...(overlays?.values() ?? [])].some(edit => this.covers(edit[0], edit[1], edit[2]));
  }
  mergeColumn(source, authoritative, { retireOverlays = false } = {}) {
    this.assertCurrent();
    if (!source && !authoritative) return;
    const x = source?.x ?? authoritative.x, z = source?.z ?? authoritative.z;
    const existing = this.world.columns?.get(`${x},${z}`), base = { ...source, ...existing }, sections = new Map((base.sections ?? []).map(section => [section.sectionY, section]));
    for (const section of source?.sections ?? []) if (!sections.has(section.sectionY)) sections.set(section.sectionY, section);
    let changed = false;
    for (const section of authoritative?.sections ?? []) {
      const previous = sections.get(section.sectionY);
      const original = source?.sections.find(entry => entry.sectionY === section.sectionY);
      if (previous && !sameBlocks(previous.blocks, section.blocks) || original && !sameBlocks(original.blocks, section.blocks)) changed = true;
      sections.set(section.sectionY, { ...previous, ...section });
    }
    const merged = { ...source, ...authoritative, ...existing, x, z, sections: [...sections.values()] };
    const overlays = this.world.overlays?.get(`${x},${z}`), covered = new Set((authoritative?.sections ?? []).map(section => section.sectionY)), retired = [];
    for (const [key, edit] of overlays ?? []) if (retireOverlays && covered.has(Math.floor(edit[1] / 16))) { this.assertCurrent(); overlays.delete(key); retired.push(edit); }
    if (overlays && !overlays.size) { this.assertCurrent(); this.world.overlays.delete(`${x},${z}`); }
    if (retired.length) { this.assertCurrent(); this.onRetireOverlays(retired); }
    this.assertCurrent();
    this.world.ingestColumn(merged);
    this.assertCurrent();
    this.trackSource(this.world.columns?.get(`${x},${z}`) ?? merged);
    if (changed) { this.assertCurrent(); this.world.dirtyLighting?.(x, z); }
  }
  async loadColumn(column, { overwrite = false } = {}) {
    this.assertCurrent();
    this.trackSource(column);
    const key = `${column.x},${column.z}`, previous = this.world.columns?.get(key), sections = new Map((previous?.sections ?? []).map(section => [section.sectionY, section]));
    for (const section of column.sections) sections.set(section.sectionY, section);
    const source = { ...previous, ...column, sections: [...sections.values()] };
    await this.admit([column], { overwrite });
    this.assertCurrent();
    const covered = [...(this.catalog.get(key) ?? [])].some(sectionY => this.keys.has(keyOf(column.x, sectionY, column.z)));
    if (this.needsOverlayRetirement(column.x, column.z)) { await this.authority.save(); this.assertCurrent(); }
    const authoritative = covered ? await this.authority.column(column.x, column.z) : null;
    this.assertCurrent();
    this.mergeColumn(source, authoritative, { retireOverlays: true });
    return { handled: column.sections.every(section => this.keys.has(keyOf(column.x, section.sectionY, column.z))) };
  }
  async setBlock(x, y, z, stateId) {
    this.assertCurrent();
    if (!this.covers(x, y, z)) return { handled: false, events: [] };
    const result = await this.authority.setBlock(x, y, z, stateId); this.assertCurrent();
    return { handled: true, ...result };
  }
  async useBlock(x, y, z) { this.assertCurrent(); if (!this.covers(x, y, z)) return false; const result = await this.authority.useBlock(x, y, z); this.assertCurrent(); return result; }
  async step(ticks = 1) { this.assertCurrent(); const result = await this.authority.step(ticks); this.assertCurrent(); return result; }
  async save() { this.assertCurrent(); const result = await this.authority.save(); this.assertCurrent(); return result; }
  close(options) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const authority = this.authority; this.closedAuthority = authority;
    this.closePromise = (async () => { try { await authority?.close(options); } finally { this.sources?.clear(); this.catalog.clear(); this.keys.clear(); } })();
    return this.closePromise;
  }
}
