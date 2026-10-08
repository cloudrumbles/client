import { defaultBiomeTint, tintComponents } from './biome-tints.js';
import { bakeModelElements } from './model-elements.js';
import { quadGeometry } from './mesh-geometry.js';
import { builtinItemParts } from './entity-items.js';
export { quadGeometry } from './mesh-geometry.js';
const qualify = value => value.includes(':') ? value : `minecraft:${value}`;
const itemModelName = value => qualify(value).replace(':item/', ':');
const EMPTY = { parts: [], display: {} };
const nbtValue = value => value && typeof value === 'object' && typeof value.type === 'string' && Object.hasOwn(value, 'value') ? value.value : value;
export function crossbowProperties(item) {
  const tag = nbtValue(item?.nbtData ?? item?.nbt) || {}, stored = item?.components?.find(component => ['charged_projectiles', 'minecraft:charged_projectiles'].includes(component.type));
  const projectiles = nbtValue(nbtValue(tag.ChargedProjectiles)?.value ?? tag.ChargedProjectiles) || stored?.data?.projectiles || stored?.data || [];
  return { charged: Number(Boolean(nbtValue(tag.Charged) || Array.isArray(projectiles) && projectiles.length)), firework: Number(Array.isArray(projectiles) && projectiles.some(projectile => ['minecraft:firework_rocket', 'firework_rocket'].includes(nbtValue(nbtValue(projectile)?.id)))) };
}
const CUBE_FACES = [
  { name: 'east', normal: [1, 0, 0], points: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
  { name: 'west', normal: [-1, 0, 0], points: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]] },
  { name: 'up', normal: [0, 1, 0], points: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { name: 'down', normal: [0, -1, 0], points: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { name: 'south', normal: [0, 0, 1], points: [[0.5, -0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5]] },
  { name: 'north', normal: [0, 0, -1], points: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
];

export function generatedSpriteGeometry(atlas, tile, layer = 0) {
  const rectangle = atlas?.tiles?.[tile];
  if (!rectangle) return new Float32Array();
  const width = rectangle.width, height = rectangle.height, z0 = -0.03125 - layer * 0.0002, z1 = 0.03125 + layer * 0.0002;
  const vertices = [];
  const emit = (points, uv, normal) => vertices.push(...quadGeometry(points, uv, normal));
  emit([[-0.5, -0.5, z1], [0.5, -0.5, z1], [0.5, 0.5, z1], [-0.5, 0.5, z1]], [[0, 1], [1, 1], [1, 0], [0, 0]], [0, 0, 1]);
  emit([[0.5, -0.5, z0], [-0.5, -0.5, z0], [-0.5, 0.5, z0], [0.5, 0.5, z0]], [[1, 1], [0, 1], [0, 0], [1, 0]], [0, 0, -1]);
  const pixels = atlas.pixelsRGBA || atlas.pixels;
  const opaque = (x, y) => x >= 0 && y >= 0 && x < width && y < height && (!pixels || pixels[((rectangle.y + y) * atlas.width + rectangle.x + x) * 4 + 3] > 0);
  for (let x = 0; x < width; x++) for (const side of [-1, 1]) {
    let first = -1;
    for (let y = 0; y <= height; y++) {
      const edge = y < height && opaque(x, y) && !opaque(x + side, y);
      if (edge && first < 0) first = y;
      if (!edge && first >= 0) {
        const px = (x + (side > 0 ? 1 : 0)) / width - 0.5, top = 0.5 - first / height, bottom = 0.5 - y / height, u = (x + 0.5) / width;
        emit([[px, bottom, z0], [px, bottom, z1], [px, top, z1], [px, top, z0]], [[u, (y - 0.5) / height], [u, (y - 0.5) / height], [u, (first + 0.5) / height], [u, (first + 0.5) / height]], [side, 0, 0]); first = -1;
      }
    }
  }
  for (let y = 0; y < height; y++) for (const side of [-1, 1]) {
    let first = -1;
    for (let x = 0; x <= width; x++) {
      const edge = x < width && opaque(x, y) && !opaque(x, y + side);
      if (edge && first < 0) first = x;
      if (!edge && first >= 0) {
        const py = 0.5 - (y + (side > 0 ? 1 : 0)) / height, left = first / width - 0.5, right = x / width - 0.5, v = (y + 0.5) / height;
        emit([[left, py, z0], [right, py, z0], [right, py, z1], [left, py, z1]], [[(first + 0.5) / width, v], [(x - 0.5) / width, v], [(x - 0.5) / width, v], [(first + 0.5) / width, v]], [0, -side, 0]); first = -1;
      }
    }
  }
  return new Float32Array(vertices);
}

export class ItemMeshLibrary {
  constructor({ registry = {}, materials = null, atlas = null } = {}) {
    this.items = new Map((registry.items || []).map(item => [item.id, item]));
    this.blocks = new Map((registry.blocks || []).map(block => [block.name, block]));
    this.materials = materials; this.atlas = atlas; this.cache = new Map(); this.cacheBytes = 0;
  }
  setAssets(atlas, materials = this.materials) { this.atlas = atlas; this.materials = materials; this.cache.clear(); this.cacheBytes = 0; }
  definition(item) { return item?.present ? this.items.get(item.itemId) : null; }
  resolve(name, seen = new Set()) {
    name = itemModelName(name);
    if (seen.has(name) || seen.size > 24) return null;
    seen.add(name);
    const own = this.atlas?.itemModels?.get(name) ?? this.atlas?.blockModels?.get(name);
    if (!own) return null;
    const namespace = name.split(':')[0], parentName = own.parent && (own.parent.includes(':') ? own.parent : `${namespace}:${own.parent}`);
    const parent = parentName && !parentName.includes('builtin/') ? this.resolve(parentName, seen) : null;
    return { ...parent, ...own, namespace, display: { ...parent?.display, ...own.display }, textures: { ...parent?.textures, ...own.textures }, generated: parent?.generated || own.parent?.includes('generated') || own.parent?.includes('handheld') };
  }
  get(item, predicates = {}) {
    const definition = this.definition(item);
    if (!definition) return EMPTY;
    if (definition.name === 'crossbow') predicates = { ...crossbowProperties(item), ...predicates };
    const inHand = !['ground', 'gui', 'fixed'].includes(predicates.displayContext || 'ground') && ['trident', 'spyglass'].includes(definition.name);
    let modelName = `minecraft:${definition.name}${inHand ? '_in_hand' : ''}`, model = this.resolve(modelName);
    for (const override of model?.overrides || []) if (Object.entries(override.predicate || {}).every(([key, threshold]) => (predicates[key] || 0) >= threshold)) modelName = itemModelName(override.model);
    if (modelName !== `minecraft:${definition.name}`) model = this.resolve(modelName) || model;
    if (this.cache.has(modelName)) return this.cache.get(modelName);
    const parts = [], block = this.blocks.get(definition.name), material = block ? this.materials?.get(block.defaultState) : null;
    if (material?.templateVertices?.length) {
      const groups = new Map(), source = material.templateVertices;
      for (let index = 0; index < source.length; index += 14) {
        const tile = source[index + 12], kind = material.templateTintKinds?.[index / 14] || 0;
        const tint = kind ? defaultBiomeTint(kind, this.atlas?.colormaps) : definition.name === 'lily_pad' ? tintComponents(7455580) : Array.from(source.subarray(index + 6, index + 9));
        const key = `${tile},${tint.join(',')}`; if (!groups.has(key)) groups.set(key, { tile, tint, vertices: [] });
        groups.get(key).vertices.push(source[index] - 0.5, source[index + 1] - 0.5, source[index + 2] - 0.5, ...source.subarray(index + 3, index + 6), source[index + 10], source[index + 11]);
      }
      for (const { tile, vertices, tint } of groups.values()) parts.push({ vertices: new Float32Array(vertices), tile, flags: material.flags & 511, tint });
    } else if (model?.elements?.length) parts.push(...bakeModelElements(model, this.atlas));
    else if (model?.parent?.includes('builtin/entity') && ['shield', 'trident'].includes(definition.name)) parts.push(...builtinItemParts(definition.name, this.atlas));
    else if (material?.fullCube) {
      // The local fallback palette has no resource-pack templates, but its
      // registry still identifies real full-cube block items.
      for (const face of CUBE_FACES) parts.push({ vertices: new Float32Array(quadGeometry(face.points, [[0, 1], [1, 1], [1, 0], [0, 0]], face.normal)), tile: material.faces?.[face.name]?.tile ?? -1, flags: material.flags & 511, tint: material.color || [1, 1, 1] });
    } else {
      const textures = model?.textures || { layer0: `minecraft:item/${definition.name}` };
      for (let layer = 0; layer < 5; layer++) {
        let texture = textures[`layer${layer}`]; if (!texture) continue;
        const seen = new Set(); while (texture.startsWith('#') && !seen.has(texture)) { seen.add(texture); texture = textures[texture.slice(1)] || ''; }
        if (!texture) continue;
        const tile = this.atlas?.itemTiles?.get(qualify(texture)) ?? this.atlas?.tileByName?.get(qualify(texture));
        if (tile !== undefined) { const vertices = generatedSpriteGeometry(this.atlas, tile, layer); if (vertices.length) parts.push({ vertices, tile, flags: 32, tint: [1, 1, 1] }); }
      }
    }
    const display = model?.display || {}, result = { parts, display, block: Boolean(material), gui3d: Boolean(material || model?.elements?.length || model?.parent?.includes('builtin/entity')), name: definition.name, modelName };
    result.bytes = parts.reduce((sum, part) => sum + part.vertices.byteLength, 0);
    if (result.bytes <= 32 * 1024 * 1024) { this.cache.set(modelName, result); this.cacheBytes += result.bytes; }
    while (this.cache.size > 128 || this.cacheBytes > 32 * 1024 * 1024) { const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key); }
    return result;
  }
}

