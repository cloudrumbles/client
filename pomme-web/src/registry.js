import { registryStates } from './anvil.js';
import { MATERIAL_FLAGS as F, FACE_NAMES } from './assets.js';

/** The generated registry contains names/data, never proprietary textures. */
export async function loadMinecraftRegistry({ url = '/data/1.20.4-registry.json', fetcher = globalThis.fetch } = {}) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Minecraft registry could not be loaded (HTTP ${response.status})`);
  const registry = await response.json();
  if (!Array.isArray(registry.blocks) || !registry.blocks.length || registry.blocks[0].name !== 'air' || registry.blocks[0].minStateId !== 0) throw new Error('Invalid native Minecraft registry');
  return registry;
}

function fallbackColor(name) {
  if (/water|bubble_column/.test(name)) return [.12, .38, .53];
  if (/lava|magma/.test(name)) return [1, .35, .06];
  if (/grass|leaves|fern|vine|moss/.test(name)) return [.30, .50, .19];
  if (/sand|end_stone/.test(name)) return [.75, .69, .48];
  if (/snow|quartz|white|bone/.test(name)) return [.88, .89, .86];
  if (/dirt|mud|farmland/.test(name)) return [.39, .27, .17];
  if (/log|wood|planks|fence|sign|chest/.test(name)) return [.49, .35, .21];
  if (/netherrack|nether_brick|redstone/.test(name)) return [.47, .19, .16];
  if (/glass|ice/.test(name)) return [.59, .77, .86];
  return [.49, .51, .54];
}

/** Procedural colors preserve native IDs and exact collisions before importing textures. */
export function fallbackMaterials(registry) {
  const states = registryStates(registry), materials = new Map();
  for (const state of states.byId.values()) {
    const block = state.block, name = block.name;
    const shapeRefs = states.collisionShapes?.blocks?.[name];
    const shapeId = Array.isArray(shapeRefs) ? shapeRefs[state.id - block.minStateId] : shapeRefs;
    const boxes = shapeId !== undefined ? states.collisionShapes?.shapes?.[shapeId] : undefined;
    const fluid = name === 'water' || name === 'lava' || name === 'bubble_column';
    const invisible = ['air', 'cave_air', 'void_air', 'structure_void', 'barrier', 'light'].includes(name);
    const solid = boxes ? boxes.length > 0 : block.boundingBox !== 'empty' && !fluid;
    let flags = (solid ? F.SOLID : 0) | (invisible ? F.INVISIBLE : 0) | (fluid ? F.FLUID : 0);
    if (solid && !block.transparent && !invisible && block.filterLight !== 0) flags |= F.AO_OPAQUE;
    if (fluid || /(?:glass|ice)$/.test(name)) flags |= F.BLEND;
    if (/leaves|grass|fern|flower|sapling|vine/.test(name)) flags |= F.CUTOUT;
    if (/(?:leaves|log|wood|stem|hyphae|sapling|grass|fern|flower|vine|mushroom|roots|bush)$/.test(name)) flags |= F.HEIGHT_IGNORED;
    let emitLight = block.emitLight ?? 0;
    if (state.properties.lit === 'false' || (name === 'sea_pickle' && state.properties.waterlogged === 'false') || (name === 'respawn_anchor' && state.properties.charges === '0')) emitLight = 0;
    if (name === 'light') emitLight = Number(state.properties.level ?? emitLight);
    if (emitLight > 0) flags |= F.EMISSIVE;
    const collisionBoxes = boxes ?? (solid ? [[0, 0, 0, 1, 1, 1]] : []);
    materials.set(state.id, { id: state.id, name: state.name, properties: state.properties, color: fallbackColor(name), flags, faces: {}, fullCube: true, collisionBoxes, templateVertices: null, emitLight, opacity: block.filterLight, procedural: true });
  }
  return materials;
}

const entries = materials => materials instanceof Map ? materials.values() : Array.isArray(materials) ? materials : Object.values(materials);
const find = (materials, id) => materials instanceof Map ? materials.get(id) : Array.isArray(materials) ? materials.find(m => m.id === id) : materials[id];
function accepted(result, action, id) { if (result !== undefined && !result) throw new Error(`WASM rejected ${action} for block state ${id}`); }
function begin(core) { if (core.block_registry_begin) accepted(core.block_registry_begin(), 'registry batch', 'all'); }
function end(core) { if (core.block_registry_end) accepted(core.block_registry_end(), 'registry batch completion', 'all'); }
function metadata(core, material, flags) {
  const { id } = material, color = material.color ?? [1, 1, 1];
  accepted(core.block_register(id, ...color, flags), 'material metadata', id);
  if (core.block_light_emission) accepted(core.block_light_emission(id, material.emitLight ?? 0), 'light emission', id);
  for (let i = 0; i < FACE_NAMES.length; i++) {
    const face = material.faces?.[FACE_NAMES[i]], uv = face?.uv ?? [0, 0, 1, 1];
    if (core.block_face_tile) accepted(core.block_face_tile(id, i, face?.tile ?? -1, face?.rotation ?? 0), 'face texture', id);
    if (core.block_face_uv) accepted(core.block_face_uv(id, i, ...uv), 'face UV', id);
  }
}
function stage(core, values, action, id, count = values.length) {
  const capacity = core.world_float_stage_capacity?.();
  if (!Number.isInteger(capacity) || values.length > capacity || !core.world_float_stage_ptr) throw new Error(`Block state ${id} exceeds the WASM material staging capacity`);
  const ptr = core.world_float_stage_ptr();
  new Float32Array(core.memory.buffer, ptr, values.length).set(values);
  const method = core[action];
  if (!method) throw new Error(`WASM is missing ${action}`);
  accepted(method(id, ptr, count), action, id);
}

/** Register inexpensive metadata for all native IDs; geometry is activated only where used. */
export function applyMaterials(core, materials, { models = false, activatedSet = new Set(), clear = true } = {}) {
  begin(core);
  try {
    if (clear && core.block_registry_clear) { accepted(core.block_registry_clear(), 'registry reset', 'all'); activatedSet.clear(); }
    for (const material of entries(materials)) metadata(core, material, material.flags & ~F.CUSTOM_MODEL);
  } finally { end(core); }
  if (models) activateMaterials(core, materials, Array.from(entries(materials), m => m.id), activatedSet);
  return activatedSet;
}

/** Stage templates and exact collision forms once per core and per used state ID. */
export function activateMaterials(core, materials, ids, activatedSet = new Set()) {
  begin(core);
  try {
    for (const rawId of new Set(ids)) {
      const id = Number(rawId);
      if (activatedSet.has(id)) continue;
      const material = find(materials, id);
      if (!material) throw new Error(`Unknown native Minecraft block state: ${id}`);
      const template = material.templateVertices;
      const custom = !!(material.flags & F.CUSTOM_MODEL) && template?.length > 0;
      if (custom) stage(core, template, 'block_model_register', id);
      const boxes = material.collisionBoxes;
      if (boxes) {
        const flattened = new Float32Array(boxes.length * 6);
        for (let i = 0; i < boxes.length; i++) { if (boxes[i].length !== 6) throw new Error(`Invalid collision box for block state ${id}`); flattened.set(boxes[i], i * 6); }
        stage(core, flattened, 'block_collision_register', id, boxes.length);
      }
      metadata(core, material, custom ? material.flags : material.flags & ~F.CUSTOM_MODEL);
      activatedSet.add(id);
    }
  } finally { end(core); }
  return activatedSet;
}

/** Lightweight worker initialization; requested definitions carry the heavy templates later. */
export function serializableMaterials(materials) {
  return new Map(Array.from(entries(materials), material => [material.id, {
    id: material.id, name: material.name, color: material.color, flags: material.flags, fullCube: material.fullCube, emitLight: material.emitLight, opacity: material.opacity,
    faces: Object.fromEntries(Object.entries(material.faces ?? {}).map(([name, face]) => [name, { tile: face.tile, uv: face.uv, rotation: face.rotation ?? 0 }])),
  }]));
}

export class MaterialRegistry {
  constructor(registry, materials = null) { this.registry = registry; this.materials = materials ?? fallbackMaterials(registry); this.active = new WeakMap(); }
  register(core) { const activated = new Set(); this.active.set(core, activated); applyMaterials(core, this.materials); return activated; }
  activate(core, ids) { let activated = this.active.get(core); if (!activated) { activated = new Set(); this.active.set(core, activated); } return activateMaterials(core, this.materials, ids, activated); }
  configuration() { return serializableMaterials(this.materials); }
  definitionsFor(ids) { return [...new Set(ids)].map(id => { const material = this.materials.get(id); if (!material) throw new Error(`Unknown native Minecraft block state: ${id}`); return material; }); }
}
