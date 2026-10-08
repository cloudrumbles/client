import { registryStates } from './anvil.js';
import { simplifyNbt } from './minecraft.js';
import { textSegments, parseTextComponent } from './text.js';
import { PlayerSkinCache } from './entity-skins.js';
import { buildEntityPreview, MeshWriter as EntityMeshWriter } from './entities.js';
import { bakeEntityCube } from './entity-models.js';
import { ItemMeshLibrary } from './item-geometry.js';
import { HandPose } from './first-person.js';
import { nativeBeamProfile, nativeBeamTexture, nativeBeamTime, nativeBeamQuads, nativeBeamColorMix, nativeGatewayExtent, nativeSin } from './native-beams.js';

// Fullbright sign flags contain only multiples of 32, retaining exact Float32
// storage even with bit 24 set; they never inherit the low SOLID/emission bits.
const SIGN_FULLBRIGHT = 16777216;
const STRIDE = 14, EMPTY = new Float32Array(0), clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DIRECTIONS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const DYES = [0xf9fffe, 0xf9801d, 0xc74ebd, 0x3ab3da, 0xfed83d, 0x80c71f, 0xf38baa, 0x474f52, 0x9d9d97, 0x169c9c, 0x8932b8, 0x3c44aa, 0x835432, 0x5e7c16, 0xb02e26, 0x1d1d21].map(hex => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map(v => v / 255));
const DYE_NAMES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const BEACON_BASES = new Set(['iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'netherite_block']);
const PATTERNS = { b: 'base', bl: 'square_bottom_left', br: 'square_bottom_right', tl: 'square_top_left', tr: 'square_top_right', bs: 'stripe_bottom', ts: 'stripe_top', ls: 'stripe_left', rs: 'stripe_right', cs: 'stripe_center', ms: 'stripe_middle', drs: 'stripe_downright', dls: 'stripe_downleft', ss: 'small_stripes', cr: 'cross', sc: 'straight_cross', bt: 'triangle_bottom', tt: 'triangle_top', bts: 'triangles_bottom', tts: 'triangles_top', ld: 'diagonal_left', rd: 'diagonal_up_right', lud: 'diagonal_up_left', rud: 'diagonal_right', mc: 'circle', mr: 'rhombus', vh: 'half_vertical', hh: 'half_horizontal', vhr: 'half_vertical_right', hhb: 'half_horizontal_bottom', bo: 'border', cbo: 'curly_border', gra: 'gradient', gru: 'gradient_up', bri: 'bricks', glb: 'globe', cre: 'creeper', sku: 'skull', flo: 'flower', moj: 'mojang', pig: 'piglin' };
const keyFor = (x, y, z) => `${x},${y},${z}`;
const kindFor = name => name === 'moving_piston' ? 'piston' : /^(?:(?:trapped_|ender_)?chest|(?:waxed_)?(?:exposed_|weathered_|oxidized_)?copper_chest)$/.test(name) ? 'chest' : /(?:^|_)shulker_box$/.test(name) ? 'shulker' : name.endsWith('_sign') ? 'sign' : name.endsWith('_banner') ? 'banner' : name === 'decorated_pot' ? 'pot' : name === 'beacon' ? 'beacon' : /^(?:player_head|player_wall_head)$/.test(name) ? 'head' : /^(?:piglin|dragon)_(?:wall_)?head$/.test(name) ? 'animated-head' : name === 'enchanting_table' ? 'enchanting' : name === 'lectern' ? 'lectern' : /^(?:suspicious_sand|suspicious_gravel)$/.test(name) ? 'brushable' : /^(?:soul_)?campfire$/.test(name) ? 'campfire' : name === 'spawner' ? 'spawner' : name === 'bell' ? 'bell' : name === 'conduit' ? 'conduit' : /^(?:end_portal|end_gateway)$/.test(name) ? 'portal' : null;
const BOOK_PARTS = [
  ['left_lid', [0, 0], [-6, -5, -.005], [6, 10, .005], [0, 0, -1]],
  ['right_lid', [16, 0], [0, -5, -.005], [6, 10, .005], [0, 0, 1]],
  ['seam', [12, 0], [-1, -5, 0], [2, 10, .005], [0, 0, 0]],
  ['left_pages', [0, 10], [0, -4, -.99], [5, 8, 1], [0, 0, 0]],
  ['right_pages', [12, 10], [0, -4, -.01], [5, 8, 1], [0, 0, 0]],
  ['flip_page1', [24, 10], [0, -4, 0], [5, 8, .005], [0, 0, 0]],
  ['flip_page2', [24, 10], [0, -4, 0], [5, 8, .005], [0, 0, 0]],
].map(([name, uv, origin, size, offset]) => ({ name, offset, vertices: bakeEntityCube({ uv, origin, size, inflate: 0, mirror: false }, [64, 32]) }));
const nativeCube = (uv, origin, size, sheet = [64, 64], mirror = false, inflate = 0) => bakeEntityCube({ uv, origin, size, mirror, inflate }, sheet);
const BANNER_GEOMETRY = { cloth: nativeCube([0, 0], [-10, 0, -2], [20, 40, 1]), pole: nativeCube([44, 0], [-1, -30, -1], [2, 42, 2]), bar: nativeCube([0, 42], [-10, -32, -1], [20, 2, 2]) };
const BELL_GEOMETRY = [nativeCube([0, 0], [-3, -6, -3], [6, 7, 6], [32, 32]), nativeCube([0, 13], [-4, -8, -4], [8, 2, 8], [32, 32])];
const PIGLIN_GEOMETRY = [nativeCube([0, 0], [-5, -8, -4], [10, 8, 8]), nativeCube([31, 1], [-2, -4, -5], [4, 4, 1]), nativeCube([2, 4], [2, -2, -5], [1, 2, 1]), nativeCube([2, 0], [-3, -2, -5], [1, 2, 1])];
const PIGLIN_EARS = [nativeCube([51, 6], [0, 0, -2], [1, 5, 4]), nativeCube([39, 6], [-1, 0, -2], [1, 5, 4])];
const DRAGON_GEOMETRY = [[[176, 44], [-6, -1, -24], [12, 5, 16]], [[112, 30], [-8, -8, -10], [16, 16, 16]], [[0, 0], [-5, -12, -4], [2, 4, 6], true], [[112, 0], [-5, -3, -22], [2, 2, 4], true], [[0, 0], [3, -12, -4], [2, 4, 6]], [[112, 0], [3, -3, -22], [2, 2, 4]]].map(([uv, origin, size, mirror]) => nativeCube(uv, origin, size, [256, 256], mirror));
const DRAGON_JAW = nativeCube([176, 65], [-6, 0, -16], [12, 4, 16], [256, 256]);
const CONDUIT_GEOMETRY = { shell: nativeCube([0, 0], [-3, -3, -3], [6, 6, 6], [32, 16]), cage: nativeCube([0, 0], [-4, -4, -4], [8, 8, 8], [32, 16]), wind: nativeCube([0, 0], [-8, -8, -8], [16, 16, 16], [64, 32]), eye: nativeCube([0, 0], [-4, -4, 0], [8, 8, 0], [16, 16], false, .01) };
const CONDUIT_BASES = new Set(['prismarine', 'prismarine_bricks', 'sea_lantern', 'dark_prismarine']);
const clonePose = pose => { const next = new HandPose(); next.matrix = [...pose.matrix]; next.position = [...pose.position]; return next; };
const TAU = Math.PI * 2, degrees = radians => radians * 180 / Math.PI;
const wrapAngle = angle => ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
const fraction = value => value - Math.floor(value);
const SIGN_COLORS = [0xffffff, 16738335, 0xff00ff, 10141901, 0xffff00, 0xbfff00, 16738740, 0x808080, 0xd3d3d3, 65535, 10494192, 255, 9127187, 65280, 0xff0000, 0];
const rgb = hex => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map(value => value / 255);

function rotate(point, axis, angle, pivot = [0, 0, 0]) {
  const result = point.map((v, i) => v - pivot[i]), a = axis === 0 ? 1 : axis === 1 ? 2 : 0, b = (a + 1) % 3;
  const c = Math.cos(angle), s = Math.sin(angle), first = result[a]; result[a] = first * c - result[b] * s; result[b] = first * s + result[b] * c;
  return result.map((v, i) => v + pivot[i]);
}
function orient(point, rotation, normal = false, inverse = false) {
  const pivot = normal ? [0, 0, 0] : [.5, .5, .5], x = -(rotation?.[0] || 0) * Math.PI / 180, y = -(rotation?.[1] || 0) * Math.PI / 180;
  return inverse ? rotate(rotate(point, 1, -y, pivot), 0, -x, pivot) : rotate(rotate(point, 0, x, pivot), 1, y, pivot);
}

export function normalizeBlockEntity(entry, column = null) {
  if (!entry || typeof entry !== 'object') return null;
  const nbt = simplifyNbt(entry.nbt ?? entry.nbtData ?? entry) || {}, local = column && entry.nbtData !== undefined;
  const x = local ? column.x * 16 + entry.x : entry.x ?? nbt.x;
  const z = local ? column.z * 16 + entry.z : entry.z ?? nbt.z;
  const y = entry.y ?? nbt.y;
  if (![x, y, z].every(Number.isInteger) || Math.abs(x) > 30_000_000 || Math.abs(z) > 30_000_000 || y < -2147483648 || y > 2147483647) return null;
  return { x, y, z, nbt: nbt || {}, action: entry.action ?? entry.type };
}

class MeshWriter extends EntityMeshWriter {
  get data() { return this.vertices; }
  set data(value) { this.vertices = value; }
  vertex(values) {
    if (this.light) values[13] = (values[13] & ~(255 << 10)) | 512 | (this.light.sky << 10) | (this.light.block << 14);
    if (this.length + STRIDE > this.data.length) { const next = new Float32Array(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data.set(values, this.length); this.length += STRIDE;
    for (let a = 0; a < 3; a++) { this.min[a] = Math.min(this.min[a], values[a]); this.max[a] = Math.max(this.max[a], values[a]); }
  }
  triangles(source, context, options) { super.triangles(source, context, { ...options, flags: (options.flags ?? 32) | 512 | ((this.light?.sky ?? 15) << 10) | ((this.light?.block ?? 0) << 14) }); }
  template(vertices, position, origin, transform = null, colorAt = null) {
    for (let i = 0; i < vertices.length; i += STRIDE) {
      const row = Array.from(vertices.subarray(i, i + STRIDE));
      if (transform) { const posed = transform(row.slice(0, 3), row.slice(3, 6), i / STRIDE); row.splice(0, 6, ...posed.position, ...posed.normal); }
      const color = colorAt?.(i / STRIDE); if (color) for (let axis = 0; axis < 3; axis++) row[axis + 6] *= color[axis];
      for (let a = 0; a < 3; a++) row[a] += position[a] - origin[a];
      this.vertex(row);
    }
  }
  quad(positions, normal, uv, tile, color, flags, position, origin, alpha = 1) {
    for (const i of [0, 1, 2, 0, 2, 3]) this.vertex([...positions[i].map((v, a) => v + position[a] - origin[a]), ...normal, ...color, alpha, ...uv[i], tile, flags | 512 | (15 << 10)]);
  }
}

export class BlockEntityScene {
  constructor({ renderer, registry, materials, atlas = null, getState = null, setVisualOverride = null, fetchSkin, getGameTime = null, getPartialTick = null, getNearbyPlayers = null, getTint = null, getLight = null, random = Math.random, maxY = 320, maxTracked = 8192, maxVisible = 128, maxDistance = 96, uploadHz = 30 } = {}) {
    if (!renderer?.uploadDynamicMesh || !registry) throw new Error('BlockEntityScene requires a renderer and native registry.');
    this.renderer = renderer; this.registry = registryStates(registry); this.materials = materials; this.atlas = atlas;
    this.version = registry.version; this.beamProfile = nativeBeamProfile(registry.version); this.getPartialTick = getPartialTick;
    this.getState = getState; this.setVisualOverride = setVisualOverride; this.maxTracked = clamp(maxTracked, 1, 65536); this.maxVisible = clamp(maxVisible, 1, 1024); this.maxDistance = clamp(maxDistance, 8, 256); this.interval = 1 / clamp(uploadHz, 10, 60);
    this.getGameTime = getGameTime; this.getNearbyPlayers = getNearbyPlayers; this.getTint = getTint; this.getLight = getLight; this.random = random; this.maxY = clamp(maxY, -2147483648, 2147483648);
    this.itemLibrary = new ItemMeshLibrary({ registry, materials, atlas }); this.itemsByName = new Map((registry.items || []).map(item => [item.name.replace(/^minecraft:/, ''), item]));
    this.nativeRegistry = registry;
    this.entityDefinitions = new Map((registry.entities || []).map(entity => [entity.name.replace(/^minecraft:/, ''), entity]));
    this.entities = new Map(); this.columns = new Map(); this.overrides = new Set(); this.writer = new MeshWriter(); this.key = '__minecraft_block_entities';
    this.time = 0; this.initialized = false; this.lastUpload = -Infinity; this.dirty = false; this.hasMesh = false; this.cameraKey = ''; this.colliders = []; this.colliderOwners = []; this.blockMotions = [];
    this.skinCache = new PlayerSkinCache({ appendTile: renderer.appendAtlasTile?.bind(renderer), fetchSkin, onReady: () => { this.dirty = true; } });
    this.stats = { tracked: 0, visible: 0, vertices: 0, uploads: 0, pistons: 0, containers: 0, signGlyphs: 0, patterns: 0, decoratedSides: 0, customHeads: 0, beaconSegments: 0, enchantingBooks: 0, lecternBooks: 0, brushingItems: 0, potWobbles: 0, signDecorations: 0, signOutlines: 0, cookingItems: 0, spawnerPreviews: 0, bells: 0, animatedHeads: 0, conduits: 0, activeConduits: 0, gatewayBeams: 0, unavailable: 0 };
  }
  stateAt(x, y, z, column = null) {
    const state = this.getState?.(x, y, z);
    if (Number.isInteger(state) && state !== 0) return state;
    const section = column?.sections?.find(s => (s.sectionY ?? s.y ?? s.sy) === Math.floor(y / 16));
    return (section?.blocks ?? section?.states)?.[((y % 16 + 16) % 16) * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16)] ?? state ?? 0;
  }
  loadColumn(column) {
    this.removeColumn(column.x, column.z); const key = `${column.x},${column.z}`, keys = new Set(); this.columns.set(key, keys);
    for (const raw of column.blockEntities || []) {
      const entry = normalizeBlockEntity(raw, column); if (!entry) continue;
      entry.state = this.stateAt(entry.x, entry.y, entry.z, column); this.put(entry); keys.add(keyFor(entry.x, entry.y, entry.z));
    }
  }
  put(entry) {
    const key = keyFor(entry.x, entry.y, entry.z), state = entry.state ?? this.stateAt(entry.x, entry.y, entry.z);
    const material = this.materials?.get(state), kind = kindFor(material?.name?.replace(/^minecraft:/, '') || '');
    if (!kind) { this.remove(key); return; }
    const previous = this.entities.get(key);
    const track = { ...previous, ...entry, key, state, kind, nbt: entry.nbt || previous?.nbt || {}, opened: previous?.opened || false, openness: previous?.openness || 0, motionAt: this.time };
    if (kind === 'piston') track.progress = clamp(Number(track.nbt.progress) || 0, 0, 1);
    if (kind === 'piston' || kind === 'shulker') { track.motionProgress = kind === 'piston' ? track.progress : previous?.motionProgress ?? 0; track.motionRemainder = 0; }
    if (kind === 'enchanting') track.book ||= { time: 0, open: 0, oOpen: 0, rot: 0, oRot: 0, tRot: 0, flip: 0, oFlip: 0, flipT: 0, flipA: 0, remainder: 0 };
    if (kind === 'animated-head') track.skull ||= { ticks: 0, remainder: 0 };
    if (kind === 'conduit') track.conduit ||= { ticks: 0, activeRotation: 0, active: false, hunting: false, remainder: 0, shapeAt: -Infinity };
    if (kind === 'portal') { const age = track.nbt.Age ?? 0n; track.gatewayAge = typeof age === 'bigint' ? age : BigInt(Math.max(0, Math.floor(Number(age) || 0))); track.gatewayRemainder = 0; track.gatewayCooldown ||= 0; }
    if (kind === 'spawner') { track.spawnDelay = Number.isFinite(Number(track.nbt.Delay)) ? clamp(Number(track.nbt.Delay), -1, 32767) : 20; track.spin ||= 0; track.oSpin = track.spin; track.remainder = 0; track.preview = null; }
    this.entities.set(key, track); this.dirty = true;
    const columnKey = `${Math.floor(entry.x / 16)},${Math.floor(entry.z / 16)}`;
    if (!this.columns.has(columnKey)) this.columns.set(columnKey, new Set()); this.columns.get(columnKey).add(key);
    while (this.entities.size > this.maxTracked) this.remove(this.entities.keys().next().value);
  }
  override(track, enabled) {
    if (!this.setVisualOverride) return false;
    if (enabled && !this.overrides.has(track.key)) { this.setVisualOverride(track.x, track.y, track.z, 0); this.overrides.add(track.key); }
    if (!enabled && this.overrides.delete(track.key)) this.setVisualOverride(track.x, track.y, track.z, null);
    return enabled;
  }
  remove(key) { const track = this.entities.get(key); if (!track) return; this.override(track, false); this.entities.delete(key); this.columns.get(`${Math.floor(track.x / 16)},${Math.floor(track.z / 16)}`)?.delete(key); this.blockMotions = this.blockMotions.filter(motion => motion.key !== key); this.dirty = true; }
  removeColumn(x, z) { const key = typeof x === 'object' ? `${x.x},${x.z}` : `${x},${z}`; for (const entity of [...(this.columns.get(key) || [])]) this.remove(entity); this.columns.delete(key); }
  consume(event) {
    if (!event) return;
    if (event.type === 'block-entity') { const entry = normalizeBlockEntity(event); if (entry) this.put(entry); }
    else if (event.type === 'block-action' && [event.x, event.y, event.z].every(Number.isInteger) && (event.actionId ?? event.byte1) === 1) {
      const key = keyFor(event.x, event.y, event.z);
      if (!this.entities.has(key)) this.put({ x: event.x, y: event.y, z: event.z, nbt: {} });
      const track = this.entities.get(key);
      if (track && (track.kind === 'chest' || track.kind === 'shulker')) { track.opened = (event.actionParam ?? event.byte2) > 0; this.dirty = true; }
      else if (track?.kind === 'spawner') { track.spawnDelay = clamp(Number.isFinite(Number(track.nbt.MinSpawnDelay)) ? Number(track.nbt.MinSpawnDelay) : 200, -1, 32767); this.dirty = true; }
      else if (track?.kind === 'bell') { track.ringAt = this.time; track.ringDirection = Number(event.actionParam ?? event.byte2); this.dirty = true; }
      else if (track?.kind === 'pot' && [0, 1].includes(Number(event.actionParam ?? event.byte2))) { track.wobbleStyle = Number(event.actionParam ?? event.byte2); track.wobbleAt = this.time; track.wobbleGameTick = this.getGameTime?.(); this.dirty = true; }
      else if (track?.kind === 'portal') { track.gatewayCooldown = 40; this.dirty = true; }
    } else if (event.type === 'block') {
      for (const track of this.entities.values()) {
        if (track.kind === 'beacon' && Math.abs(track.x - event.x) <= 4 && Math.abs(track.z - event.z) <= 4) { track.beamAt = -Infinity; this.dirty = true; }
        if (track.kind === 'conduit' && Math.max(Math.abs(track.x - event.x), Math.abs(track.y - event.y), Math.abs(track.z - event.z)) <= 2) this.dirty = true;
      }
      const key = keyFor(event.x, event.y, event.z), track = this.entities.get(key);
      if (track) { const material = this.materials?.get(event.state ?? event.stateId); if (kindFor(material?.name?.replace(/^minecraft:/, '') || '') !== track.kind) this.remove(key); else { track.state = event.state ?? event.stateId; this.dirty = true; } }
    }
  }
  container(track, material, origin) {
    if (!material.model?.parts?.length || !this.override(track, true)) { this.stats.unavailable++; return; }
    const openness = track.renderOpenness ?? track.openness, eased = 1 - (1 - openness) ** 3, parts = material.model.parts, position = [track.x, track.y, track.z];
    this.writer.template(material.templateVertices, position, origin, (point, normal, index) => {
      const part = parts.findIndex(p => index >= p.firstVertex && index < p.firstVertex + p.vertexCount);
      if (part > 0) {
        point = orient(point, material.model.rotation, false, true); normal = orient(normal, material.model.rotation, true, true);
        if (track.kind === 'chest') { point = rotate(point, 0, -Math.PI / 2 * eased, [.5, 9 / 16, 1 / 16]); normal = rotate(normal, 0, -Math.PI / 2 * eased); }
        else { point = rotate(point, 1, openness * Math.PI * 1.5, [.5, .5, .5]); normal = rotate(normal, 1, openness * Math.PI * 1.5); point[1] += openness * .5; }
        point = orient(point, material.model.rotation); normal = orient(normal, material.model.rotation, true);
      }
      return { position: point, normal };
    }); this.stats.containers++;
  }
  pistonPose(track) {
    const blockState = track.nbt.blockState ?? track.nbt.block_state, id = blockState && this.registry.lookup(blockState.Name ?? blockState.name, blockState.Properties ?? blockState.properties ?? {}), material = this.materials?.get(id);
    const progress = clamp(track.progress + Math.max(0, this.time - track.motionAt) * 10, 0, 1), amount = track.nbt.extending ? progress - 1 : 1 - progress;
    const direction = DIRECTIONS[Number(track.nbt.facing)] || DIRECTIONS[0], position = [track.x, track.y, track.z].map((v, a) => v + direction[a] * amount);
    let moving = material, body = null;
    if (track.nbt.source && !track.nbt.extending && material && /(?:^|:)sticky_piston$|(?:^|:)piston$/.test(material.name)) {
      const facing = ['down', 'up', 'north', 'south', 'west', 'east'][Number(track.nbt.facing)] || 'down';
      moving = this.materials?.get(this.registry.lookup('minecraft:piston_head', { facing, short: `${progress >= .5}`, type: material.name.endsWith('sticky_piston') ? 'sticky' : 'normal' }));
      body = this.materials?.get(this.registry.lookup(material.name, { ...material.properties, extended: 'true' })) ?? material;
    }
    return { material: moving, body, position };
  }
  piston(track, origin) {
    const pose = this.pistonPose(track);
    if (!pose.material?.templateVertices?.length) { this.stats.unavailable++; return; }
    const tint = material => index => { const kind = material.templateTintKinds?.[index] ?? 0; return kind ? this.getTint?.(track.x, track.y, track.z, kind) : null; };
    this.writer.template(pose.material.templateVertices, pose.position, origin, null, tint(pose.material));
    if (pose.body?.templateVertices?.length) this.writer.template(pose.body.templateVertices, [track.x, track.y, track.z], origin, null, tint(pose.body));
    this.stats.pistons++;
  }
  collisionBoxes(_bounds, options = {}) {
    const { excludeMotion, direction } = options ?? {};
    const bounds = Array.isArray(_bounds) && _bounds.length === 6 ? _bounds : null;
    if (!excludeMotion && !bounds) return this.colliders;
    return this.colliders.filter((box, index) => { const owner = this.colliderOwners[index], included = owner.key !== excludeMotion || !owner.moving || direction && owner.direction.some((value, axis) => value !== direction[axis]); return included && (!bounds || [0, 1, 2].every(axis => box[axis] <= bounds[axis + 3] + 1e-6 && box[axis + 3] >= bounds[axis] - 1e-6)); });
  }
  collisionEntries(bounds, options = {}) {
    const boxes = new Set(this.collisionBoxes(bounds, options));
    return this.colliders.flatMap((box, index) => boxes.has(box) ? [{ box, position: this.colliderOwners[index].key.split(',').map(Number), key: this.colliderOwners[index].key, moving: this.colliderOwners[index].moving }] : []);
  }
  drainBlockMotions() { return this.blockMotions.splice(0); }
  enqueueMotion(track, previousProgress, currentProgress, tick) {
    const material = this.materials?.get(track.state), facing = track.kind === 'piston' ? DIRECTIONS[Number(track.nbt.facing)] || DIRECTIONS[0] : orient([0, 1, 0], material?.model?.rotation, true).map(value => Math.round(value));
    const direction = track.kind === 'piston' && !track.nbt.extending ? facing.map(value => -value) : facing;
    let boxes, staticBoxes = [], materialName = material?.name;
    if (track.kind === 'piston') {
      const pose = this.pistonPose({ ...track, progress: previousProgress, motionAt: this.time }); let collisionMaterial = pose.material;
      if (track.nbt.source && !track.nbt.extending) {
        const head = collisionMaterial?.properties, id = this.registry.lookup('minecraft:piston_head', { ...head, short: `${previousProgress > .25}` });
        collisionMaterial = this.materials?.get(id) || collisionMaterial;
      }
      boxes = (collisionMaterial?.collisionBoxes || []).map(box => box.map((value, axis) => value + pose.position[axis % 3]));
      staticBoxes = (pose.body?.collisionBoxes || []).map(box => box.map((value, axis) => value + [track.x, track.y, track.z][axis % 3]));
      materialName = collisionMaterial?.name;
    } else {
      const box = [track.x, track.y, track.z, track.x + 1, track.y + 1, track.z + 1];
      for (let axis = 0; axis < 3; axis++) { if (facing[axis] < 0) box[axis] -= .5 * previousProgress; if (facing[axis] > 0) box[axis + 3] += .5 * previousProgress; }
      boxes = [box];
    }
    this.blockMotions.push({ kind: track.kind, key: track.key, tick, position: [track.x, track.y, track.z], direction, previousProgress, currentProgress, boxes, staticBoxes, materialName, extending: Boolean(track.nbt.extending), source: Boolean(track.nbt.source) });
    if (this.blockMotions.length > 512) this.blockMotions.splice(0, this.blockMotions.length - 512);
  }
  tickMotions(track, elapsed) {
    track.motionRemainder += Math.min(elapsed, 1) * 20; const ticks = Math.floor(track.motionRemainder + 1e-9); track.motionRemainder = Math.max(0, track.motionRemainder - ticks);
    const age = this.getGameTime?.() ?? Math.floor(this.time * 20);
    for (let step = 0; step < ticks; step++) {
      const previous = track.motionProgress, current = clamp(Math.fround(previous + (track.kind === 'piston' ? .5 : track.opened ? Math.fround(.1) : -Math.fround(.1))), 0, 1); track.motionProgress = current;
      if (current === previous) continue;
      const tick = typeof age === 'bigint' ? age - BigInt(ticks - step - 1) : Math.floor(Number(age)) - ticks + step + 1;
      if (track.kind === 'piston' || current > previous) this.enqueueMotion(track, previous, current, tick);
    }
  }
  partialTick(camera = {}) { return Math.fround(clamp(this.getPartialTick?.() ?? camera.partialTick ?? fraction(this.time * 20), 0, 1)); }
  beam(origin, track, tile, color, options) {
    for (const quad of nativeBeamQuads(options)) this.writer.quad(quad.positions, quad.normal, quad.uv, tile, color, quad.flags, [track.x, track.y, track.z], origin, quad.alpha);
  }
  beacon(track, origin, camera = {}) {
    const tile = this.atlas?.entityTiles?.get(nativeBeamTexture(this.version)); if (tile === undefined) { this.stats.unavailable++; return; }
    if (track.beamAt === undefined || this.time - track.beamAt >= 1) {
      track.beamAt = this.time; track.beamSections = [];
      let levels = 0;
      for (let level = 1; level <= 4; level++) {
        let valid = true; for (let x = -level; x <= level && valid; x++) for (let z = -level; z <= level; z++) if (!BEACON_BASES.has(this.materials?.get(this.stateAt(track.x + x, track.y - level, track.z + z))?.name?.replace(/^minecraft:/, ''))) { valid = false; break; }
        if (!valid) break; levels = level;
      }
      if (levels) {
        let current = { color: [1, 1, 1], height: 1, y: 0 }; track.beamSections.push(current);
        for (let y = track.y + 1; y < Math.min(this.maxY, track.y + 16384); y++) {
          const material = this.materials?.get(this.stateAt(track.x, y, track.z)), name = material?.name?.replace(/^minecraft:/, '') || 'air', match = /^(.*)_stained_glass(?:_pane)?$/.exec(name), dye = match ? DYES[DYE_NAMES.indexOf(match[1])] : null;
          const color = dye && (this.beamProfile.modern ? dye : dye.map(Math.fround));
          if (color) {
            if (track.beamSections.length === 1 || color.some((v, a) => v !== current.color[a])) { const nextColor = track.beamSections.length === 1 ? color : nativeBeamColorMix(current.color, color, this.beamProfile.modern); current = { color: nextColor, height: 1, y: y - track.y }; track.beamSections.push(current); } else current.height++;
          } else if ((material?.opacity ?? 0) < 15 || name === 'bedrock') current.height++;
          else { track.beamSections = []; break; }
        }
      }
    }
    const age = this.getGameTime?.() ?? Math.floor(this.time * 20), animationTime = nativeBeamTime(age, this.partialTick(camera)), sections = track.beamSections;
    const profile = nativeBeamProfile(this.version, Math.hypot(track.x + .5 - this.eye[0], track.z + .5 - this.eye[2]), camera.scoping);
    for (let index = 0; index < sections.length; index++) {
      const section = sections[index], height = index === sections.length - 1 ? profile.finalHeight : section.height;
      this.beam(origin, track, tile, section.color, { bottom: section.y, height, animationTime, innerRadius: Math.fround(Math.fround(.2) * profile.radiusScale), outerRadius: Math.fround(.25 * profile.radiusScale), outerAlpha: profile.outerAlpha });
      this.stats.beaconSegments++;
    }
  }
  nearestPlayer(track, range) {
    let nearest = null, distance = range * range;
    for (const player of this.playerPositions || []) {
      const d = player.reduce((sum, value, axis) => sum + (value - [track.x + .5, track.y + .5, track.z + .5][axis]) ** 2, 0);
      if (d < distance) { distance = d; nearest = player; }
    }
    return nearest;
  }
  animateBook(track, elapsed) {
    // EnchantmentTableBlockEntity.bookAnimationTick runs at the native 20 Hz.
    const book = track.book; book.remainder += Math.min(elapsed, 1) * 20;
    const ticks = Math.floor(book.remainder + 1e-9); book.remainder = Math.max(0, book.remainder - ticks);
    for (let tick = 0; tick < ticks; tick++) {
      book.oOpen = book.open; book.oRot = book.rot; book.oFlip = book.flip;
      const player = this.nearestPlayer(track, 3);
      if (player) {
        book.tRot = Math.atan2(player[2] - track.z - .5, player[0] - track.x - .5); book.open += .1;
        if (book.open < .5 || Math.floor(this.random() * 40) === 0) {
          const prior = book.flipT;
          for (let attempt = 0; attempt < 16 && book.flipT === prior; attempt++) book.flipT += Math.floor(this.random() * 4) - Math.floor(this.random() * 4);
          if (book.flipT === prior) book.flipT += 1;
        }
      } else { book.tRot += .02; book.open -= .1; }
      book.rot = wrapAngle(book.rot); book.tRot = wrapAngle(book.tRot);
      book.rot += wrapAngle(book.tRot - book.rot) * .4; book.open = clamp(book.open, 0, 1); book.time++;
      const velocity = clamp((book.flipT - book.flip) * .4, -.2, .2);
      book.flipA += (velocity - book.flipA) * .9; book.flip += book.flipA;
    }
  }
  enchanting(track, origin) {
    const tile = this.atlas?.entityTiles?.get('minecraft:entity/enchanting_table_book'); if (tile === undefined) { this.stats.unavailable++; return; }
    const book = track.book, partial = book.remainder, age = book.time + partial;
    const open = book.oOpen + (book.open - book.oOpen) * partial, rotation = book.oRot + wrapAngle(book.rot - book.oRot) * partial;
    const flip = book.oFlip + (book.flip - book.oFlip) * partial, flip1 = clamp(fraction(flip + .25) * 1.6 - .3, 0, 1), flip2 = clamp(fraction(flip + .75) * 1.6 - .3, 0, 1);
    const angle = (Math.sin(age * .02) * .1 + 1.25) * open;
    const pose = new HandPose().translate(.5, .85 + Math.sin(age * .1) * .01, .5).rotate('y', degrees(-rotation)).rotate('z', 80);
    this.bookMesh(track, origin, pose, tile, angle, flip1, flip2);
    this.stats.enchantingBooks++;
  }
  bookMesh(track, origin, pose, tile, angle, flip1, flip2) {
    const context = { position: [track.x - origin[0], track.y - origin[1], track.z - origin[2]], rotation: [0, 0, 0], scale: 1 };
    for (const part of BOOK_PARTS) {
      const posed = new HandPose(); posed.matrix = [...pose.matrix]; posed.position = [...pose.position];
      const pages = part.name.includes('pages') || part.name.startsWith('flip');
      posed.translate((pages ? Math.sin(angle) : 0) / 16 + part.offset[0] / 16, part.offset[1] / 16, part.offset[2] / 16);
      const partAngle = part.name === 'left_lid' ? Math.PI + angle : part.name === 'right_lid' || part.name === 'right_pages' ? -angle : part.name === 'seam' ? Math.PI / 2 : part.name === 'flip_page1' ? angle - angle * 2 * flip1 : part.name === 'flip_page2' ? angle - angle * 2 * flip2 : angle;
      posed.rotate('y', degrees(partAngle)).scale(1, -1, 1);
      this.writer.triangles(part.vertices, context, { matrix: posed.matrix, normalMatrix: posed.normalMatrix(), position: posed.position, tile, flags: 1, reversed: true });
    }
  }
  lectern(track, material, origin) {
    // LecternRenderer uses the same seven-part BookModel with a fixed setupAnim.
    if (String(material.properties?.has_book) !== 'true') return;
    const tile = this.atlas?.entityTiles?.get('minecraft:entity/enchanting_table_book');
    if (tile === undefined) { this.stats.unavailable++; return; }
    const clockwiseYaw = { north: 270, east: 0, south: 90, west: 180 }[material.properties?.facing] ?? 270;
    const pose = new HandPose().translate(.5, 1.0625, .5).rotate('y', -clockwiseYaw).rotate('z', 67.5).translate(0, -.125, 0);
    this.bookMesh(track, origin, pose, tile, 1.25 * 1.2, .1, .9); this.stats.lecternBooks++;
  }
  itemFromNbt(entry) {
    const item = this.itemsByName.get(String(entry?.id ?? '').replace(/^minecraft:/, '')), count = Number(entry?.Count ?? entry?.count ?? 0);
    if (!item || count <= 0) return null;
    const components = Array.isArray(entry.components) ? entry.components : Object.entries(entry.components || {}).map(([type, data]) => ({ type, data }));
    return this.itemLibrary.get({ present: true, itemId: item.id, itemCount: count, nbtData: entry.tag, components });
  }
  fixedItem(track, origin, mesh, pose) {
    const display = mesh.display.fixed || {}, translation = display.translation || [0, 0, 0], rotation = display.rotation || [0, 0, 0], scale = display.scale || [1, 1, 1];
    pose.translate(...translation.map(value => value / 16)).rotate('x', rotation[0]).rotate('y', rotation[1]).rotate('z', rotation[2]).scale(...scale);
    const context = { position: [track.x - origin[0], track.y - origin[1], track.z - origin[2]], rotation: [0, 0, 0], scale: 1 };
    for (const part of mesh.parts) this.writer.triangles(part.vertices, context, { matrix: pose.matrix, normalMatrix: pose.normalMatrix(), position: pose.position, tile: part.tile, tint: part.tint, flags: part.flags });
  }
  brushable(track, material, origin) {
    // Native renderer is driven by the DUSTED state and hit_direction update NBT.
    const dusted = Number(material.properties?.dusted), direction = track.nbt.hit_direction, mesh = this.itemFromNbt(track.nbt.item);
    if (!(dusted > 0) || !Number.isInteger(direction) || direction < 0 || direction > 5 || !mesh) return;
    if (!mesh.parts.length) { this.stats.unavailable++; return; }
    const offset = clamp(dusted, 1, 3) / 10 * .75, position = [.5, .5, .5];
    if (direction === 5) position[0] = .73 + offset;
    else if (direction === 4) position[0] = .25 - offset;
    else if (direction === 1) position[1] += .25 + offset;
    else if (direction === 0) position[1] -= .23 + offset;
    else if (direction === 2) position[2] = .25 - offset;
    else position[2] = .73 + offset;
    const delta = DIRECTIONS[direction], light = this.getLight?.(track.x + delta[0], track.y + delta[1], track.z + delta[2]);
    if (light) this.writer.light = { sky: clamp(Math.floor(light.sky ?? light.skyLight ?? 15), 0, 15), block: clamp(Math.floor(light.block ?? light.blockLight ?? 0), 0, 15) };
    this.fixedItem(track, origin, mesh, new HandPose().translate(...position).rotate('y', 75).rotate('y', (direction >= 4 ? 90 : 0) + 11).scale(.5)); this.stats.brushingItems++;
  }
  campfire(track, material, origin) {
    // CampfireRenderer uses ItemDisplayContext.FIXED and four native horizontal slots.
    const facing = { south: 0, west: 1, north: 2, east: 3 }[material.properties?.facing] ?? 2;
    const slots = new Map(); for (const entry of (track.nbt.Items || []).slice(0, 64)) if (Number.isInteger(entry.Slot) && entry.Slot >= 0 && entry.Slot < 4) slots.set(entry.Slot, entry);
    const context = { position: [track.x - origin[0], track.y - origin[1], track.z - origin[2]], rotation: [0, 0, 0], scale: 1 };
    for (const [slot, entry] of slots) {
      const item = this.itemsByName.get(String(entry.id || '').replace(/^minecraft:/, ''));
      if (!item || (Number(entry.Count ?? entry.count) || 0) <= 0) continue;
      const mesh = this.itemLibrary.get({ present: true, itemId: item.id, itemCount: Number(entry.Count ?? entry.count), nbtData: entry.tag });
      if (!mesh.parts.length) { this.stats.unavailable++; continue; }
      const direction = (slot + facing) % 4, pose = new HandPose().translate(.5, .44921875, .5).rotate('y', -direction * 90).rotate('x', 90).translate(-.3125, -.3125, 0).scale(.375);
      const display = mesh.display.fixed || {}, translation = display.translation || [0, 0, 0], rotation = display.rotation || [0, 0, 0], scale = display.scale || [1, 1, 1];
      pose.translate(...translation.map(value => value / 16)).rotate('x', rotation[0]).rotate('y', rotation[1]).rotate('z', rotation[2]).scale(...scale);
      for (const part of mesh.parts) this.writer.triangles(part.vertices, context, { matrix: pose.matrix, normalMatrix: pose.normalMatrix(), position: pose.position, tile: part.tile, tint: part.tint, flags: part.flags });
      this.stats.cookingItems++;
    }
  }
  spawner(track, origin) {
    const data = track.nbt.SpawnData?.entity ?? track.nbt.SpawnData?.Entity ?? track.nbt.SpawnData;
    const name = String(data?.id || '').replace(/^minecraft:/, ''), definition = this.entityDefinitions.get(name);
    if (!definition || name === 'player') { this.stats.unavailable++; return; }
    const values = { baby: Number(data.Age) < 0 || Boolean(data.IsBaby), type: data.RabbitType ?? data.Type ?? 0, type_variant: data.Variant ?? 0, size: Number(data.Size ?? 0) + 1, puff_state: data.PuffState ?? 0, wool: (Number(data.Color) || 0) | (data.Sheared ? 16 : 0), variant: data.Variant ?? 0 };
    const entity = { metadata: Object.entries(values).map(([key, value]) => ({ key: definition.metadataKeys?.indexOf(key) ?? -1, value })).filter(entry => entry.key >= 0) };
    track.preview ||= buildEntityPreview({ name, position: [0, 0, 0], metadata: entity.metadata, nbt: data }, { registry: this.nativeRegistry, atlas: this.atlas, materials: this.materials });
    if (!track.preview?.vertices.length) { this.stats.unavailable++; return; }
    const baby = values.baby, dimensions = Math.max(Number(definition.width) || .6, Number(definition.height) || 1) * (baby ? .5 : 1), scale = .53125 / Math.max(1, dimensions);
    // Spin is stored in degrees; its native render rotation multiplies it by ten.
    const interpolatedSpin = track.oSpin + (track.spin - track.oSpin) * track.remainder;
    const pose = new HandPose().translate(.5, .4, .5).rotate('y', interpolatedSpin * 10).translate(0, -.2, 0).rotate('x', -30).scale(scale);
    const normals = pose.normalMatrix(), transform = (point, matrix) => [0, 1, 2].map(axis => matrix[axis * 3] * point[0] + matrix[axis * 3 + 1] * point[1] + matrix[axis * 3 + 2] * point[2]);
    this.writer.template(track.preview.vertices, [track.x, track.y, track.z], origin, (point, normal) => {
      const rotated = transform(normal, normals), length = Math.hypot(...rotated);
      return { position: transform(point, pose.matrix).map((value, axis) => value + pose.position[axis]), normal: rotated.map(value => value / length) };
    }); this.stats.spawnerPreviews++;
  }
  head(track, material, origin) {
    const profile = track.nbt.SkullOwner ?? track.nbt.skull_owner ?? track.nbt.profile;
    const properties = profile?.properties ?? profile?.Properties;
    const player = { properties: Array.isArray(properties) ? properties.map(property => ({ name: property.name ?? property.Name, value: property.value ?? property.Value })) : (properties?.textures || []).map(property => ({ name: 'textures', value: property.Value ?? property.value })) };
    const skin = this.skinCache.request(player);
    if (skin?.state !== 'ready' || !material.templateVertices?.length || !this.override(track, true)) { this.override(track, false); return; }
    this.writer.template(material.templateVertices, [track.x, track.y, track.z], origin, (position, normal) => ({ position, normal }));
    for (let i = this.writer.length - material.templateVertices.length + 12; i < this.writer.length; i += STRIDE) this.writer.data[i] = skin.tile;
    this.stats.customHeads++;
  }
  nativePart(track, origin, pose, geometry, tile, { tint = [1, 1, 1], flags = 32, inflation = 0, noCull = false } = {}) {
    const posed = clonePose(pose).scale(1, -1, 1), context = { position: [track.x - origin[0], track.y - origin[1], track.z - origin[2]], rotation: [0, 0, 0], scale: 1 };
    this.writer.triangles(geometry, context, { matrix: posed.matrix, normalMatrix: posed.normalMatrix(), position: posed.position, tile, tint, flags, inflation, reversed: true });
    if (noCull) this.writer.triangles(geometry, context, { matrix: posed.matrix, normalMatrix: posed.normalMatrix(), position: posed.position, tile, tint, flags, inflation, reversed: false });
  }
  bell(track, origin) {
    const tile = this.atlas?.entityTiles?.get('minecraft:entity/bell/bell_body'); if (tile === undefined) { this.stats.unavailable++; return; }
    const ticks = Math.max(0, (this.time - (track.ringAt ?? -Infinity)) * 20), shaking = ticks < 50, angle = shaking ? Math.sin(ticks / Math.PI) / (4 + ticks / 3) : 0;
    const x = track.ringDirection === 2 ? -angle : track.ringDirection === 3 ? angle : 0, z = track.ringDirection === 5 ? -angle : track.ringDirection === 4 ? angle : 0;
    const pose = new HandPose().translate(.5, .75, .5).rotate('z', degrees(z)).rotate('x', degrees(x));
    for (const geometry of BELL_GEOMETRY) this.nativePart(track, origin, pose, geometry, tile, { flags: 1 }); this.stats.bells++;
  }
  animatedHead(track, material, origin) {
    const name = material.name.replace(/^minecraft:/, ''), dragon = name.startsWith('dragon'), tile = this.atlas?.entityTiles?.get(dragon ? 'minecraft:entity/enderdragon/dragon' : 'minecraft:entity/piglin/piglin');
    if (tile === undefined || !this.override(track, true)) { this.stats.unavailable++; return; }
    const wall = name.includes('_wall_'), direction = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }[material.properties?.facing] || [0, 0, -1];
    const rotation = wall ? (({ south: 0, west: 90, north: 180, east: 270 }[material.properties?.facing] ?? 180) + 180) % 360 : Number(material.properties?.rotation || 0) * 22.5;
    const pose = new HandPose().translate(.5 - (wall ? direction[0] * .25 : 0), wall ? .25 : 0, .5 - (wall ? direction[2] * .25 : 0)).scale(-1, -1, 1);
    if (dragon) pose.translate(0, -.374375, 0).scale(.75);
    pose.rotate('y', rotation);
    const age = track.skull.ticks + (material.properties?.powered === 'true' ? track.skull.remainder : 0);
    if (dragon) {
      for (const geometry of DRAGON_GEOMETRY) this.nativePart(track, origin, pose, geometry, tile);
      const jaw = clonePose(pose).translate(0, 4 / 16, -8 / 16).rotate('x', degrees((Math.sin(age * Math.PI * .2) + 1) * .2));
      this.nativePart(track, origin, jaw, DRAGON_JAW, tile);
    } else {
      for (const geometry of PIGLIN_GEOMETRY) this.nativePart(track, origin, pose, geometry, tile);
      const left = -(Math.cos(age * Math.PI * .2 * 1.2) + 2.5) * .2, right = (Math.cos(age * Math.PI * .2) + 2.5) * .2;
      this.nativePart(track, origin, clonePose(pose).translate(4.5 / 16, -6 / 16, 0).rotate('z', degrees(left)), PIGLIN_EARS[0], tile);
      this.nativePart(track, origin, clonePose(pose).translate(-4.5 / 16, -6 / 16, 0).rotate('z', degrees(right)), PIGLIN_EARS[1], tile);
    }
    this.stats.animatedHeads++;
  }
  refreshConduit(track) {
    const state = track.conduit, previous = `${state.active},${state.hunting}`; let water = true, bases = 0;
    for (let x = -1; x <= 1 && water; x++) for (let y = -1; y <= 1 && water; y++) for (let z = -1; z <= 1; z++) {
      const material = this.materials?.get(this.stateAt(track.x + x, track.y + y, track.z + z)), name = material?.name?.replace(/^minecraft:/, '');
      if (material?.properties?.waterlogged !== 'true' && !['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'].includes(name)) { water = false; break; }
    }
    if (water) for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) for (let z = -2; z <= 2; z++) {
      const X = Math.abs(x), Y = Math.abs(y), Z = Math.abs(z);
      if (X <= 1 && Y <= 1 && Z <= 1 || (x !== 0 || Y !== 2 && Z !== 2) && (y !== 0 || X !== 2 && Z !== 2) && (z !== 0 || X !== 2 && Y !== 2)) continue;
      if (CONDUIT_BASES.has(this.materials?.get(this.stateAt(track.x + x, track.y + y, track.z + z))?.name?.replace(/^minecraft:/, ''))) bases++;
    }
    state.active = water && bases >= 16; state.hunting = bases >= 42; state.bases = bases; state.shapeAt = this.time;
    if (`${state.active},${state.hunting}` !== previous) this.dirty = true;
  }
  tickConduit(track, elapsed) {
    const state = track.conduit;
    state.remainder += Math.min(elapsed, 1) * 20; const ticks = Math.floor(state.remainder + 1e-9); state.remainder = Math.max(0, state.remainder - ticks);
    const gameTime = this.getGameTime?.() ?? Math.floor(this.time * 20);
    for (let step = 0; step < ticks; step++) {
      state.ticks = (state.ticks + 1) | 0; const age = typeof gameTime === 'bigint' ? gameTime - BigInt(ticks - step - 1) : Math.floor(Number(gameTime)) - ticks + step + 1;
      if (typeof age === 'bigint' ? age % 40n === 0n : age % 40 === 0) this.refreshConduit(track);
      if (state.active) state.activeRotation = Math.fround(state.activeRotation + 1);
    }
    return state.active;
  }
  conduit(track, origin, camera) {
    const state = track.conduit, getTile = name => this.atlas?.entityTiles?.get(`minecraft:entity/conduit/${name}`);
    if (!this.override(track, true) || getTile(state.active ? 'cage' : 'base') === undefined) { this.stats.unavailable++; return; }
    if (!state.active) this.nativePart(track, origin, new HandPose().translate(.5, .5, .5).rotate('y', Math.fround(state.activeRotation * Math.fround(-.0375))), CONDUIT_GEOMETRY.shell, getTile('base'), { flags: 1 });
    else {
      const age = Math.fround(Math.fround(state.ticks) + Math.fround(state.remainder)), wave = Math.fround(nativeSin(Math.fround(age * Math.fround(.1)), this.beamProfile.modern) / 2 + .5), bob = Math.fround(Math.fround(.3) + Math.fround(Math.fround(Math.fround(wave * wave) + wave) * Math.fround(.2)));
      const cage = new HandPose().translate(.5, bob, .5), activeRotation = Math.fround(Math.fround(state.activeRotation + Math.fround(state.remainder)) * Math.fround(-.0375)), angle = Math.fround(Math.fround(activeRotation * Math.fround(57.295776)) * Math.fround(Math.PI / 180)), c = Math.cos(angle), s = Math.sin(angle), t = 1 - c, [x, y, z] = [.5, 1, .5].map(value => Math.fround(value / Math.sqrt(1.5)));
      cage.matrix = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
      this.nativePart(track, origin, cage, CONDUIT_GEOMETRY.cage, getTile('cage'), { noCull: true });
      const phase = Math.trunc(state.ticks / 66) % 3, windTile = getTile(phase === 1 ? 'wind_vertical' : 'wind');
      if (windTile !== undefined) {
        const wind = new HandPose().translate(.5, .5, .5); if (phase === 1) wind.rotate('x', 90); else if (phase === 2) wind.rotate('z', 90);
        this.nativePart(track, origin, wind, CONDUIT_GEOMETRY.wind, windTile, { noCull: true });
        this.nativePart(track, origin, new HandPose().translate(.5, .5, .5).scale(.875).rotate('x', 180).rotate('z', 180), CONDUIT_GEOMETRY.wind, windTile, { noCull: true });
      } else this.stats.unavailable++;
      const eyeTile = getTile(state.hunting ? 'open_eye' : 'closed_eye');
      if (eyeTile !== undefined) {
        const direction = camera.direction || [0, 0, -1], yaw = Math.atan2(direction[0], -direction[2]), pitch = Math.asin(clamp(direction[1], -1, 1));
        const eye = new HandPose().translate(.5, bob, .5).scale(.5).rotate('y', -degrees(yaw) - 180).rotate('x', -degrees(pitch)).rotate('z', 180).scale(1.3333334);
        this.nativePart(track, origin, eye, CONDUIT_GEOMETRY.eye, eyeTile, { noCull: true });
      } else this.stats.unavailable++;
      this.stats.activeConduits++;
    }
    this.stats.conduits++;
  }
  gateway(track, origin) {
    if (!this.materials?.get(track.state)?.name?.endsWith('end_gateway')) return;
    const spawning = track.gatewayAge < 200n, cooling = track.gatewayCooldown > 0;
    if (!spawning && !cooling) return;
    const tile = this.atlas?.entityTiles?.get(nativeBeamTexture(this.version, true)); if (tile === undefined) { this.stats.unavailable++; return; }
    const partial = track.gatewayRemainder, extent = nativeGatewayExtent({ age: track.gatewayAge, cooldown: track.gatewayCooldown, partial, maxY: this.maxY, modern: this.beamProfile.modern });
    if (this.beamProfile.modern ? extent.extent <= 0 : extent.extent === 0) return;
    const age = this.getGameTime?.() ?? Math.floor(this.time * 20), color = DYES[spawning ? 2 : 10];
    this.beam(origin, track, tile, color, { bottom: extent.bottom, height: extent.height, intensity: extent.intensity, animationTime: nativeBeamTime(age, partial), innerRadius: Math.fround(.15), outerRadius: Math.fround(.175), outerAlpha: this.beamProfile.outerAlpha });
    this.stats.gatewayBeams++;
  }
  updateColliders() {
    this.colliders.length = 0; this.colliderOwners.length = 0;
    for (const track of this.entities.values()) {
      if (track.kind === 'piston') {
        const { material, body, position } = this.pistonPose(track);
        const direction = (DIRECTIONS[Number(track.nbt.facing)] || DIRECTIONS[0]).map(value => value * (track.nbt.extending ? 1 : -1));
        for (const box of material?.collisionBoxes || []) { this.colliders.push(box.map((v, a) => v + position[a % 3])); this.colliderOwners.push({ key: track.key, kind: track.kind, moving: true, direction }); }
        for (const box of body?.collisionBoxes || []) { this.colliders.push(box.map((v, a) => v + [track.x, track.y, track.z][a % 3])); this.colliderOwners.push({ key: track.key, kind: track.kind, moving: false, direction }); }
      } else if (track.kind === 'shulker' && track.openness > 0) {
        const direction = orient([0, 1, 0], this.materials?.get(track.state)?.model?.rotation, true), box = [track.x, track.y, track.z, track.x + 1, track.y + 1, track.z + 1];
        for (let a = 0; a < 3; a++) { if (direction[a] < -.5) box[a] -= .5 * track.openness; if (direction[a] > .5) box[a + 3] += .5 * track.openness; }
        this.colliders.push(box); this.colliderOwners.push({ key: track.key, kind: track.kind, moving: true, direction: direction.map(value => Math.round(value)) });
      }
    }
  }
  banner(track, material, origin) {
    const tile = this.atlas?.entityTiles?.get('minecraft:entity/banner_base'); if (tile === undefined || !this.override(track, true)) { this.stats.unavailable++; return; }
    const name = material.name.replace(/^minecraft:/, ''), wall = name.includes('_wall_'), color = DYES[DYE_NAMES.indexOf(name.replace(/_(?:wall_)?banner$/, ''))] || DYES[0];
    const pose = new HandPose().translate(.5, wall ? -1 / 6 : .5, .5).rotate('y', wall ? -({ south: 0, west: 90, north: 180, east: 270 }[material.properties?.facing] ?? 180) : -Number(material.properties?.rotation || 0) * 22.5);
    if (wall) pose.translate(0, -.3125, -.4375); pose.scale(2 / 3, -2 / 3, -2 / 3);
    if (!wall) this.nativePart(track, origin, pose, BANNER_GEOMETRY.pole, tile, { flags: 1 }); this.nativePart(track, origin, pose, BANNER_GEOMETRY.bar, tile, { flags: 1 });
    const age = this.getGameTime?.() ?? this.time * 20, positionPhase = BigInt((Math.imul(track.x, 7) + Math.imul(track.y, 9) + Math.imul(track.z, 13)) | 0), phase = typeof age === 'bigint' ? Number(((age + positionPhase) % 100n + 100n) % 100n) / 100 : (((Number(age) + Number(positionPhase)) % 100 + 100) % 100) / 100;
    const angle = (-.0125 + .01 * Math.cos(Math.PI * 2 * phase)) * Math.PI, cloth = clonePose(pose).translate(0, -2, 0).rotate('x', degrees(angle)), base = this.atlas.entityTiles.get('minecraft:entity/banner/base');
    this.nativePart(track, origin, cloth, BANNER_GEOMETRY.cloth, tile, { tint: base === undefined ? color : [1, 1, 1], flags: 1 });
    if (base !== undefined) this.nativePart(track, origin, cloth, BANNER_GEOMETRY.cloth, base, { tint: color, inflation: .00005 });
    const patterns = track.nbt.Patterns ?? track.nbt.patterns ?? [];
    for (const [layer, pattern] of patterns.slice(0, 16).entries()) {
      const name = PATTERNS[pattern.Pattern] ?? String(pattern.pattern ?? pattern.Pattern ?? '').replace(/^minecraft:/, ''), tile = this.atlas?.entityTiles?.get(`minecraft:entity/banner/${name}`);
      if (tile === undefined) { this.stats.unavailable++; continue; }
      const color = Number.isInteger(pattern.Color) ? DYES[clamp(pattern.Color, 0, 15)] : DYES[DYE_NAMES.indexOf(pattern.color)] || DYES[0];
      this.nativePart(track, origin, cloth, BANNER_GEOMETRY.cloth, tile, { tint: color, inflation: .00005 * (layer + 2) });
      this.stats.patterns++;
    }
  }
  potProgress(track) {
    if (track.wobbleAt === undefined) return -1;
    const age = this.getGameTime?.(), elapsed = typeof age === 'bigint' && typeof track.wobbleGameTick === 'bigint' ? Number(age - track.wobbleGameTick) : Number.isFinite(age) && Number.isFinite(track.wobbleGameTick) ? age - track.wobbleGameTick : (this.time - track.wobbleAt) * 20;
    const progress = elapsed / (track.wobbleStyle === 0 ? 7 : 10); return progress >= 0 && progress <= 1 ? progress : -1;
  }
  pot(track, material, origin) {
    const progress = this.potProgress(track), wobbling = progress >= 0 && progress < 1;
    // Template geometry already includes native facing; wobble acts in its local axes.
    const wobble = (point, normal) => {
      if (!wobbling) return { position: point, normal };
      point = orient(point, material.model?.rotation, false, true); normal = orient(normal, material.model?.rotation, true, true);
      const pivot = [.5, 0, .5];
      if (track.wobbleStyle === 0) {
        const phase = progress * TAU, x = -1.5 * (Math.cos(phase) + .5) * Math.sin(phase / 2) / 64, z = Math.sin(phase) / 64;
        point = rotate(rotate(point, 2, z, pivot), 0, x, pivot); normal = rotate(rotate(normal, 2, z), 0, x);
      } else {
        const y = Math.sin(-progress * 3 * Math.PI) * .125 * (1 - progress); point = rotate(point, 1, y, pivot); normal = rotate(normal, 1, y);
      }
      return { position: orient(point, material.model?.rotation), normal: orient(normal, material.model?.rotation, true) };
    };
    if (wobbling && material.templateVertices?.length && this.override(track, true)) { this.writer.template(material.templateVertices, [track.x, track.y, track.z], origin, wobble); this.stats.potWobbles++; }
    else this.override(track, false);
    const sherds = track.nbt.sherds || [], sides = ['north', 'west', 'east', 'south'];
    for (let index = 0; index < Math.min(4, sherds.length); index++) {
      const pattern = String(sherds[index]).replace(/^minecraft:/, '').replace(/_pottery_sherd$/, '_pottery_pattern'), tile = this.atlas?.entityTiles?.get(`minecraft:entity/decorated_pot/${pattern}`);
      if (tile === undefined || pattern === 'brick') continue;
      const direction = { north: [0, 0, -1], west: [-1, 0, 0], east: [1, 0, 0], south: [0, 0, 1] }[sides[index]], normal = orient(direction, material.model?.rotation, true);
      const quad = material.model?.quads?.find(q => q.normal.every((v, a) => Math.abs(v - normal[a]) < .01) && q.positions.some(p => p[1] < .01) && q.positions.every(p => p[1] <= 1.01));
      if (quad) { const posed = quad.positions.map(p => wobble(p.map((v, a) => v + normal[a] * .0008), normal)); this.writer.quad(posed.map(row => row.position), posed[0].normal, quad.uvs, tile, [1, 1, 1], 32, [track.x, track.y, track.z], origin); this.stats.decoratedSides++; }
    }
  }
  signWhiteGlyph() {
    if (this.whiteGlyph !== undefined) return this.whiteGlyph;
    // Font's underline/strike effects use an opaque white glyph, never stretched ink.
    if (this.renderer.appendAtlasTile) {
      try { const tile = this.renderer.appendAtlasTile({ width: 1, height: 1, pixelsRGBA: new Uint8Array([255, 255, 255, 255]) }, { name: 'minecraft:font/sign_effect' }); return this.whiteGlyph = { tile: tile.id, uv: [.5, .5] }; } catch {}
    }
    const atlas = this.atlas;
    for (const glyph of atlas?.fontGlyphs?.values() || []) {
      const tile = atlas.tiles?.[glyph.tile]; if (!tile) continue;
      for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x++) {
        const at = ((tile.y + y) * atlas.width + tile.x + x) * 4;
        if (atlas.pixelsRGBA[at] === 255 && atlas.pixelsRGBA[at + 1] === 255 && atlas.pixelsRGBA[at + 2] === 255 && atlas.pixelsRGBA[at + 3] === 255) return this.whiteGlyph = { tile: glyph.tile, uv: [(x + .5) / tile.width, (y + .5) / tile.height] };
      }
    }
    return this.whiteGlyph = null;
  }
  sign(track, material, origin) {
    const name = material.name.replace(/^minecraft:/, ''), hanging = name.includes('hanging'), wall = name.includes('_wall_'), font = this.atlas?.fontGlyphs;
    if (!font?.size) { this.stats.unavailable++; return; }
    // SignRenderer/HangingSignRenderer offsets and Font.StringRenderOutput metrics.
    const centerY = hanging ? .625 - .32 : wall ? .5 - .3125 + 1 / 3 : 5 / 6;
    const frontZ = hanging ? .5 + .073 : wall ? .5 - .4375 + .046666667 : .5 + .046666667;
    const backZ = hanging ? .5 - .073 : wall ? .5 - .4375 - .046666667 : .5 - .046666667;
    const legacy = [track.nbt.Text1, track.nbt.Text2, track.nbt.Text3, track.nbt.Text4];
    for (const [side, data] of [[1, track.nbt.front_text ?? { messages: legacy, color: track.nbt.Color, has_glowing_text: track.nbt.GlowingText }], [-1, track.nbt.back_text]]) {
      if (!data) continue;
      const colorIndex = DYE_NAMES.indexOf(data.color ?? 'black'), textColor = SIGN_COLORS[colorIndex >= 0 ? colorIndex : 15], glowing = Boolean(data.has_glowing_text), darkColor = glowing && textColor === 0 ? rgb(0xf0ebcc) : rgb(textColor).map(value => Math.floor(value * 255 * .4) / 255);
      const baseColor = glowing ? rgb(textColor) : darkColor, flags = 32 | (glowing ? SIGN_FULLBRIGHT : 0), scale = hanging ? .9 / 64 : 1 / 96;
      const outline = glowing && (textColor === 0 || this.eye.reduce((sum, value, axis) => sum + (value - [track.x + .5, track.y + .5, track.z + .5][axis]) ** 2, 0) < 256);
      const normal = orient([0, 0, side], material.model?.rotation, true), position = [track.x, track.y, track.z];
      for (const [line, message] of (data.messages || []).slice(0, 4).entries()) {
        const fitted = [], maximum = hanging ? 60 : 90; let width = 0, count = 0, lastSpace = -1, hadWidth = false;
        for (const segment of textSegments(parseTextComponent(message))) {
          for (const character of segment.text) {
            if (++count > 384 || character === '\n') break;
            const glyph = font.get(character) ?? font.get('\ufffd') ?? font.get('?'); if (!glyph) continue;
            const advance = glyph.advance + (segment.style.bold ? 1 : 0); if (character === ' ') lastSpace = fitted.length;
            if (hadWidth && width + advance > maximum) { if (lastSpace >= 0) { fitted.length = lastSpace; width = fitted.reduce((sum, row) => sum + row.advance, 0); } count = 385; break; }
            width += advance; hadWidth ||= advance !== 0; fitted.push({ glyph, style: segment.style, advance });
          }
          if (count > 384 || segment.text.includes('\n')) break;
        }
        let cursor = -width / 2;
        for (const { glyph, style, advance } of fitted) {
          const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? rgb(parseInt(style.color.slice(1), 16)) : baseColor;
          const baseline = line * 10 - 20, up = 7 - (glyph.ascent ?? 7), z = (side > 0 ? frontZ : backZ) + side * .001;
          const emitGlyph = (dx, dy, tint, outlined = false, boldOffset = 0) => {
            if (!glyph.width || glyph.tile < 0) return;
            const top = baseline + up + dy, bottom = top + glyph.height;
            const italicTop = style.italic ? 1 - .25 * up : 0, italicBottom = style.italic ? 1 - .25 * (up + glyph.height) : 0;
            const x = cursor + dx + boldOffset, points = [[x + italicBottom, bottom], [x + glyph.width + italicBottom, bottom], [x + glyph.width + italicTop, top], [x + italicTop, top]].map(([X, Y]) => orient([.5 + side * X * scale, centerY - Y * scale, z + (outlined ? -side * .0001 : 0)], material.model?.rotation));
            const [u, v, U, V] = glyph.uv; this.writer.quad(points, normal, [[u, V], [U, V], [U, v], [u, v]], glyph.tile, tint, flags, position, origin);
            if (outlined) this.stats.signOutlines++;
          };
          if (outline) for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) if (dx || dy) { emitGlyph(dx, dy, darkColor, true); if (style.bold) emitGlyph(dx, dy, darkColor, true, 1); }
          emitGlyph(0, 0, color); if (style.bold) emitGlyph(0, 0, color, false, 1);
          if (glyph.width && glyph.tile >= 0) this.stats.signGlyphs++;
          if (style.underlined || style.strikethrough) {
            const solid = this.signWhiteGlyph();
            if (solid) for (const effect of [style.underlined ? 9 : null, style.strikethrough ? 4.5 : null].filter(value => value !== null)) {
              const top = baseline + effect - 1, bottom = baseline + effect, points = [[cursor - 1, bottom], [cursor + advance, bottom], [cursor + advance, top], [cursor - 1, top]].map(([X, Y]) => orient([.5 + side * X * scale, centerY - Y * scale, z + side * .0001], material.model?.rotation));
              this.writer.quad(points, normal, Array(4).fill(solid.uv), solid.tile, color, flags, position, origin); this.stats.signDecorations++;
            }
          }
          cursor += advance;
        }
      }
    }
  }
  update(time, eye, camera = {}) {
    if (!Number.isFinite(time) || !eye?.every(Number.isFinite)) return this.stats;
    const elapsed = this.initialized ? Math.max(0, time - this.time) : 0;
    if (!this.initialized) { for (const track of this.entities.values()) { track.motionAt = time; if (track.ringAt !== undefined) track.ringAt = time; if (track.wobbleAt !== undefined) track.wobbleAt = time; } this.initialized = true; }
    this.time = time; this.eye = eye;
    this.playerPositions = (this.getNearbyPlayers?.() ?? [camera.playerPosition ?? [eye[0], eye[1] - 1.62, eye[2]]]).filter(position => Array.isArray(position) && position.length === 3 && position.every(Number.isFinite));
    let animated = false;
    for (const track of this.entities.values()) {
      if (track.kind === 'piston' || track.kind === 'shulker') this.tickMotions(track, elapsed);
      if (track.kind === 'chest' || track.kind === 'shulker') { const prior = track.openness; track.openness = clamp(prior + (track.opened ? 1 : -1) * elapsed * 2, 0, 1); if (prior !== track.openness) { this.dirty = true; animated = true; } }
      else if (track.kind === 'piston') {
        const progress = clamp(track.progress + Math.max(0, time - track.motionAt) * 10, 0, 1);
        if (track.lastProgress !== progress) { this.dirty = true; track.lastProgress = progress; }
        if (progress < 1) animated = true;
      }
      else if (track.kind === 'beacon') animated = true;
      else if (track.kind === 'banner') animated = true;
      else if (track.kind === 'pot') { const progress = this.potProgress(track); if (progress !== track.lastWobbleProgress) { this.dirty = true; track.lastWobbleProgress = progress; } if (progress >= 0 && progress < 1) animated = true; }
      else if (track.kind === 'conduit') { if (this.tickConduit(track, elapsed)) animated = true; }
      else if (track.kind === 'portal') {
        if (!this.materials?.get(track.state)?.name?.endsWith('end_gateway')) continue;
        track.gatewayRemainder += Math.min(elapsed, 1) * 20; const ticks = Math.floor(track.gatewayRemainder + 1e-9); track.gatewayRemainder = Math.max(0, track.gatewayRemainder - ticks);
        const wasVisible = track.gatewayAge < 200n || track.gatewayCooldown > 0; track.gatewayAge += BigInt(ticks); track.gatewayCooldown = Math.max(0, track.gatewayCooldown - ticks);
        if (track.gatewayAge < 200n || track.gatewayCooldown > 0) animated = true; else if (wasVisible) this.dirty = true;
      }
      else if (track.kind === 'bell') { const shaking = time - (track.ringAt ?? -Infinity) < 2.5; if (shaking || track.bellShaking !== shaking) this.dirty = true; track.bellShaking = shaking; if (shaking) animated = true; }
      else if (track.kind === 'animated-head') { if (this.materials?.get(track.state)?.properties?.powered === 'true') { track.skull.remainder += Math.min(elapsed, 1) * 20; const ticks = Math.floor(track.skull.remainder + 1e-9); track.skull.remainder = Math.max(0, track.skull.remainder - ticks); track.skull.ticks += ticks; animated = true; } }
      else if (track.kind === 'enchanting') { this.animateBook(track, elapsed); animated = true; }
      else if (track.kind === 'spawner') {
        track.remainder += Math.min(elapsed, 1) * 20; const ticks = Math.floor(track.remainder + 1e-9); track.remainder = Math.max(0, track.remainder - ticks);
        const range = Number.isFinite(Number(track.nbt.RequiredPlayerRange)) ? Number(track.nbt.RequiredPlayerRange) : 16;
        if (this.nearestPlayer(track, clamp(range, 0, 128))) {
          for (let tick = 0; tick < ticks; tick++) { if (track.spawnDelay > 0) track.spawnDelay--; track.oSpin = track.spin; track.spin = (track.spin + 1000 / (track.spawnDelay + 200)) % 360; }
          animated = true;
        } else track.oSpin = track.spin;
      }
    }
    for (const track of this.entities.values()) {
      track.renderOpenness = track.openness;
      const properties = this.materials?.get(track.state)?.properties;
      if (track.kind !== 'chest' || !properties || !['left', 'right'].includes(properties.type)) continue;
      const direction = { south: [-1, 0], north: [1, 0], west: [0, -1], east: [0, 1] }[properties.facing];
      if (!direction) continue;
      const sign = properties.type === 'left' ? 1 : -1, neighbor = this.entities.get(keyFor(track.x + direction[0] * sign, track.y, track.z + direction[1] * sign)), neighborProperties = this.materials?.get(neighbor?.state)?.properties;
      if (neighbor?.kind === 'chest' && neighborProperties?.facing === properties.facing && neighborProperties.type !== properties.type && ['left', 'right'].includes(neighborProperties.type)) track.renderOpenness = Math.max(track.openness, neighbor.openness);
    }
    this.updateColliders();
    if (time - this.lastUpload < this.interval) return this.stats;
    const cameraKey = [...eye, ...(camera.direction || [])].map(v => v.toFixed(2)).join(','); if (cameraKey !== this.cameraKey) this.dirty = true; this.cameraKey = cameraKey;
    if (!this.dirty && !animated) return this.stats;
    const isBeam = track => track.kind === 'beacon' || track.kind === 'portal' && this.materials?.get(track.state)?.name?.endsWith('end_gateway');
    const origin = [Math.floor(eye[0] / 256) * 256, Math.abs(eye[1]) < 4096 ? 0 : Math.floor(eye[1] / 256) * 256, Math.floor(eye[2] / 256) * 256], candidates = [...this.entities.values()].map(track => ({ track, distance: isBeam(track) ? Math.hypot(track.x + .5 - eye[0], track.z + .5 - eye[2]) : Math.hypot(track.x + .5 - eye[0], track.y + .5 - eye[1], track.z + .5 - eye[2]) })).filter(({ track, distance }) => distance < (isBeam(track) ? 256 : this.maxDistance)).sort((a, b) => a.distance - b.distance).slice(0, this.maxVisible);
    const selected = new Set(candidates.map(({ track }) => track.key)); for (const key of [...this.overrides]) if (!selected.has(key)) this.override(this.entities.get(key), false);
    this.writer.reset(); for (const name of ['pistons', 'containers', 'signGlyphs', 'patterns', 'decoratedSides', 'customHeads', 'beaconSegments', 'enchantingBooks', 'lecternBooks', 'brushingItems', 'potWobbles', 'signDecorations', 'signOutlines', 'cookingItems', 'spawnerPreviews', 'bells', 'animatedHeads', 'conduits', 'activeConduits', 'gatewayBeams', 'unavailable']) this.stats[name] = 0;
    for (const { track } of candidates) {
      const material = this.materials?.get(track.state); if (!material) continue;
      const light = this.getLight?.(track.x, track.y, track.z); this.writer.light = { sky: clamp(Math.floor(light?.sky ?? light?.skyLight ?? 15), 0, 15), block: clamp(Math.floor(light?.block ?? light?.blockLight ?? 0), 0, 15) };
      if (track.kind === 'piston') this.piston(track, origin);
      else if (track.kind === 'beacon') this.beacon(track, origin, camera);
      else if (track.kind === 'head') this.head(track, material, origin);
      else if (track.kind === 'animated-head') this.animatedHead(track, material, origin);
      else if (track.kind === 'bell') this.bell(track, origin);
      else if (track.kind === 'banner') this.banner(track, material, origin);
      else if (track.kind === 'conduit') this.conduit(track, origin, camera);
      else if (track.kind === 'portal') this.gateway(track, origin);
      else if (track.kind === 'enchanting') this.enchanting(track, origin);
      else if (track.kind === 'lectern') this.lectern(track, material, origin);
      else if (track.kind === 'brushable') this.brushable(track, material, origin);
      else if (track.kind === 'pot') this.pot(track, material, origin);
      else if (track.kind === 'campfire') this.campfire(track, material, origin);
      else if (track.kind === 'spawner') this.spawner(track, origin);
      else if ((track.kind === 'chest' || track.kind === 'shulker') && (track.opened || track.renderOpenness > 0)) this.container(track, material, origin);
      else { this.override(track, false); if (track.kind === 'sign') this.sign(track, material, origin); else if (track.kind === 'banner') this.banner(track, material, origin); else if (track.kind === 'pot') this.pot(track, material, origin); }
    }
    if (this.writer.length) { this.renderer.uploadDynamicMesh(this.key, this.writer.data.subarray(0, this.writer.length), EMPTY, { min: this.writer.min.map((v, a) => v + origin[a]), max: this.writer.max.map((v, a) => v + origin[a]) }, { stride: STRIDE, origin }); this.hasMesh = true; this.stats.uploads++; }
    else if (this.hasMesh) { this.renderer.removeMesh(this.key); this.hasMesh = false; }
    this.lastUpload = time; this.dirty = false; Object.assign(this.stats, { tracked: this.entities.size, visible: candidates.length, vertices: this.writer.length / STRIDE }); return this.stats;
  }
  clear() { for (const key of [...this.entities.keys()]) this.remove(key); this.columns.clear(); this.colliders.length = 0; this.colliderOwners.length = 0; this.blockMotions.length = 0; this.skinCache.clear(); if (this.hasMesh) this.renderer.removeMesh(this.key); this.hasMesh = false; this.writer.reset(); this.lastUpload = -Infinity; this.dirty = false; for (const name of Object.keys(this.stats)) this.stats[name] = 0; }
}
