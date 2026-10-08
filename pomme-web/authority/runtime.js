import { registryStates } from '../src/anvil.js';

const directions = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
function coordinates(...values) {
  if (values.some(value => !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)) throw new Error('Authority coordinates must be signed 32-bit integers.');
}
export function authorityStateDefinitions(registry) {
  const native = registryStates(registry), definitions = [];
  for (const state of native.byId.values()) {
    const { block, properties } = state, name = block.name;
    const kind = name === 'lever' ? 1 : name === 'stone_button' || name === 'polished_blackstone_button' ? 2 : name.endsWith('_button') ? 3 : name === 'redstone_lamp' ? 4 : name === 'redstone_block' ? 5 : 0;
    const active = properties[kind === 4 ? 'lit' : 'powered'] === 'true';
    const counterpart = kind && kind !== 5 ? native.lookup(state.name, { ...properties, [kind === 4 ? 'lit' : 'powered']: String(!active) }) : state.id;
    if (!Number.isInteger(counterpart)) throw new Error(`Missing native authority counterpart for ${state.name}.`);
    const shapeIds = native.collisionShapes?.blocks?.[name], shapeId = Array.isArray(shapeIds) ? shapeIds[state.id - block.minStateId] : shapeIds;
    const shape = native.collisionShapes?.shapes?.[shapeId];
    const solid = !block.transparent && shape?.length === 1 && shape[0].every((value, index) => value === (index < 3 ? 0 : 1));
    const direction = properties.face === 'floor' ? 1 : properties.face === 'ceiling' ? 0 : directions[properties.facing] ?? 0;
    definitions.push([state.id, block.id, kind, (solid ? 1 : 0) | (active ? 2 : 0), counterpart, direction]);
  }
  return definitions;
}

/** No native process, sockets or wall-clock calls occur inside the WASM engine. */
export class AuthorityRuntime {
  static async create({ registry, minY = -64, height = 384, wasmUrl = new URL('./authority.wasm', import.meta.url), wasmBytes } = {}) {
    const bytes = wasmBytes ?? await (await fetch(wasmUrl)).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const runtime = new AuthorityRuntime(instance.exports, registry.version.minecraftVersion);
    for (const definition of authorityStateDefinitions(registry)) runtime.accept(instance.exports.authority_register(...definition), 'native state registration');
    runtime.accept(instance.exports.authority_reset(minY, height), 'dimension bounds');
    return runtime;
  }
  constructor(core, version) { this.core = core; this.version = version; }
  accept(result, action) { if (!result) throw new Error(`Browser authority rejected ${action}.`); }
  loadSection(x, sectionY, z, blocks) {
    coordinates(x, sectionY, z);
    if (!(blocks instanceof Uint16Array) || blocks.length !== 4096) throw new Error('Authority sections require 4096 native state IDs.');
    const pointer = this.core.authority_stage_ptr();
    new Uint16Array(this.core.memory.buffer, pointer, 4096).set(blocks);
    this.accept(this.core.authority_load_section(x, sectionY, z), 'section data');
  }
  setBlock(x, y, z, stateId) { coordinates(x, y, z); if (!Number.isInteger(stateId) || stateId < 0 || stateId > 65535) throw new Error('Authority block state must be a native unsigned 16-bit ID.'); this.accept(this.core.authority_block_set(x, y, z, stateId), 'block mutation'); }
  useBlock(x, y, z) { coordinates(x, y, z); if (!this.core.authority_can_use_block(x, y, z)) return false; this.accept(this.core.authority_use_block(x, y, z), 'block interaction'); return true; }
  blockAt(x, y, z) { coordinates(x, y, z); const id = this.core.authority_block_get(x, y, z); return id === 0xffffffff ? null : id; }
  step(ticks = 1) { if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1000) throw new Error('Authority tick batch must be between 0 and 1000.'); this.accept(this.core.authority_tick(ticks), 'tick batch'); }
  setTime(time, daylight = true) { const native = BigInt(time); if (BigInt.asIntN(64, native) !== native) throw new Error('Authority time must be a signed 64-bit native value.'); this.core.authority_set_time(native, daylight ? 1 : 0); }
  state() { return { version: this.version, age: this.core.authority_world_age(), daytime: this.core.authority_daytime(), sections: this.core.authority_section_count(), pendingTicks: this.core.authority_pending_ticks() }; }
  events() {
    const count = this.core.authority_drain_events(), view = new Int32Array(this.core.memory.buffer, this.core.authority_events_ptr(), count * 4);
    return Array.from({ length: count }, (_, index) => ({ type: 'block-update', x: view[index * 4], y: view[index * 4 + 1], z: view[index * 4 + 2], stateId: view[index * 4 + 3] }));
  }
  sections() {
    const count = this.core.authority_section_keys();
    const keys = new Int32Array(this.core.memory.buffer, this.core.authority_events_ptr(), count * 3).slice(), result = [];
    for (let index = 0; index < count; index++) {
      const [x, sectionY, z] = keys.slice(index * 3, index * 3 + 3);
      this.accept(this.core.authority_read_section(x, sectionY, z), 'section read');
      result.push({ x, sectionY, z, blocks: new Uint16Array(this.core.memory.buffer, this.core.authority_stage_ptr(), 4096).slice() });
    }
    return result;
  }
  column(x, z) {
    coordinates(x, z);
    const count = this.core.authority_column_keys(x, z);
    const keys = new Int32Array(this.core.memory.buffer, this.core.authority_events_ptr(), count).slice(), sections = [];
    for (const sectionY of keys) {
      this.accept(this.core.authority_read_section(x, sectionY, z), 'column section read');
      sections.push({ sectionY, blocks: new Uint16Array(this.core.memory.buffer, this.core.authority_stage_ptr(), 4096).slice() });
    }
    return { x, z, sections };
  }
  snapshot() {
    const count = this.core.authority_snapshot();
    return { version: this.version, bytes: new Uint8Array(this.core.memory.buffer, this.core.authority_snapshot_ptr(), count).slice() };
  }
  restore({ version, bytes } = {}) {
    if (version !== this.version) throw new Error('Authority save belongs to a different native Minecraft version.');
    if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024) throw new Error('Invalid or oversized authority save.');
    new Uint8Array(this.core.memory.buffer, this.core.authority_restore_ptr(), bytes.length).set(bytes);
    this.accept(this.core.authority_restore(bytes.length), 'saved world');
  }
}
