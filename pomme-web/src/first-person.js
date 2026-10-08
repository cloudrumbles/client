import { MeshWriter } from './entities.js';
import { HandPose, applyItemDisplay } from './item-pose.js';
export { HandPose } from './item-pose.js';
import { bakedEntityModel } from './entity-models.js';
import { defaultPlayerSkin, PlayerSkinCache } from './entity-skins.js';
import { ItemMeshLibrary, quadGeometry, crossbowProperties } from './item-geometry.js';

const EMPTY = new Float32Array(), DEG = Math.PI / 180;
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const transform = (point, m) => [m[0] * point[0] + m[1] * point[1] + m[2] * point[2], m[3] * point[0] + m[4] * point[1] + m[5] * point[2], m[6] * point[0] + m[7] * point[1] + m[8] * point[2]];
const multiply = (a, b) => Array.from({ length: 9 }, (_, index) => { const row = Math.floor(index / 3), column = index % 3; return a[row * 3] * b[column] + a[row * 3 + 1] * b[column + 3] + a[row * 3 + 2] * b[column + 6]; });


const armPosition = (pose, side, equip) => pose.translate(side * 0.56, -0.52 - equip * 0.6, -0.72);
function attackPose(pose, side, swing) {
  const first = Math.sin(swing * swing * Math.PI), second = Math.sin(Math.sqrt(swing) * Math.PI);
  return pose.rotate('y', side * (45 - first * 20)).rotate('z', side * second * -20).rotate('x', second * -80).rotate('y', side * -45);
}

export function heldItemPose({ side = 1, swing = 0, equip = 0, action = null, useTicks = 0, duration = 32, charged = false } = {}) {
  const pose = new HandPose(); swing = clamp(swing); equip = clamp(equip);
  if (action === 'eat' || action === 'drink') {
    const remaining = Math.max(0, duration - useTicks), fraction = remaining / duration;
    if (fraction < 0.8) pose.translate(0, Math.abs(Math.cos(remaining / 4 * Math.PI) * 0.1), 0);
    const amount = 1 - Math.pow(fraction, 27);
    pose.translate(amount * 0.6 * side, -amount * 0.5, 0).rotate('y', side * amount * 90).rotate('x', amount * 10).rotate('z', side * amount * 30);
    armPosition(pose, side, equip);
  } else if (action === 'bow' || action === 'crossbow' || action === 'spear') {
    armPosition(pose, side, equip);
    const crossbow = action === 'crossbow', spear = action === 'spear';
    pose.translate(side * (spear ? -0.5 : crossbow ? -0.4785682 : -0.2785682), spear ? 0.7 : crossbow ? -0.094387 : 0.18344387, spear ? 0.1 : crossbow ? 0.05731531 : 0.15731531);
    pose.rotate('x', spear ? -55 : crossbow ? -11.935 : -13.935).rotate('y', side * (crossbow ? 65.3 : 35.3)).rotate('z', side * -9.785);
    let amount = spear ? useTicks / 10 : crossbow ? useTicks / Math.max(1, duration) : useTicks / 20;
    if (action === 'bow') amount = (amount * amount + amount * 2) / 3;
    amount = clamp(amount);
    if (amount > 0.1) pose.translate(0, Math.sin((useTicks - 0.1) * 1.3) * (amount - 0.1) * 0.004, 0);
    pose.translate(0, 0, amount * (spear ? 0.2 : 0.04)).scale(1, 1, 1 + amount * 0.2).rotate('y', -side * 45);
  } else if (action === 'brush') {
    armPosition(pose, side, equip);
    const angle = -15 + 75 * Math.cos((useTicks % 10) / 10 * Math.PI * 2);
    if (side < 0) pose.translate(0.1, 0.83, 0.35).rotate('x', -80).rotate('y', -90).rotate('x', angle).translate(-0.3, 0.22, 0.35);
    else pose.translate(-0.25, 0.22, 0.35).rotate('x', -80).rotate('y', 90).rotate('x', angle);
  } else if (action) armPosition(pose, side, equip);
  else {
    const root = Math.sqrt(swing);
    pose.translate(side * -0.4 * Math.sin(root * Math.PI), 0.2 * Math.sin(root * Math.PI * 2), -0.2 * Math.sin(swing * Math.PI));
    armPosition(pose, side, equip); attackPose(pose, side, swing);
    if (charged && swing < 0.001) pose.translate(side * -0.641864, 0, 0).rotate('y', side * 10);
  }
  return pose;
}

export function emptyArmPose({ side = 1, swing = 0, equip = 0 } = {}) {
  const pose = new HandPose(), root = Math.sqrt(clamp(swing));
  pose.translate(side * (0.64000005 - 0.3 * Math.sin(root * Math.PI)), -0.6 - equip * 0.6 + 0.4 * Math.sin(root * Math.PI * 2), -0.71999997 - 0.4 * Math.sin(swing * Math.PI));
  return pose.rotate('y', side * 45).rotate('y', side * Math.sin(root * Math.PI) * 70).rotate('z', side * Math.sin(swing * swing * Math.PI) * -20)
    .translate(-side, 3.6, 3.5).rotate('z', side * 120).rotate('x', 200).rotate('y', side * -135).translate(side * 5.6, 0, 0);
}

export function mapHandPose({ side = 1, swing = 0, equip = 0, pitch = 0, twoHanded = false } = {}) {
  const pose = new HandPose(), root = Math.sqrt(clamp(swing)), wave = Math.sin(root * Math.PI);
  if (twoHanded) {
    const tilt = (1 - Math.cos(clamp(1 + pitch / DEG / 45 + 0.1) * Math.PI)) * 0.5;
    pose.translate(0, Math.sin(swing * Math.PI) * 0.1, -0.4 * wave).translate(0, 0.04 - equip * 1.2 - tilt * 0.5, -0.72).rotate('x', -tilt * 85);
    return { pose: pose.clone().rotate('x', wave * 20).scale(2), armPose: pose.clone().rotate('y', 90) };
  }
  pose.translate(side * 0.125, -0.125, 0);
  const armPose = pose.clone().rotate('z', side * 10).append(emptyArmPose({ side, swing, equip }));
  pose.translate(side * 0.51, -0.08 - equip * 1.2, -0.75).translate(side * -0.5 * wave, 0.4 * Math.sin(root * Math.PI * 2) - 0.3 * wave, -0.3 * Math.sin(swing * Math.PI)).rotate('x', wave * -45).rotate('y', side * wave * -30);
  return { pose, armPose };
}

export function itemUseAction(name, using) {
  if (!using) return null;
  if (name === 'bow') return 'bow'; if (name === 'crossbow') return 'crossbow'; if (name === 'trident') return 'spear'; if (name === 'brush') return 'brush'; if (name === 'shield') return 'block'; if (name === 'spyglass') return 'scope';
  if (name === 'potion' || name === 'milk_bucket' || name === 'honey_bottle') return 'drink';
  if (/^(?:apple|golden_apple|enchanted_golden_apple|bread|beef|porkchop|chicken|mutton|rabbit|cod|salmon|cooked_.*|carrot|potato|baked_potato|poisonous_potato|beetroot|beetroot_soup|mushroom_stew|rabbit_stew|suspicious_stew|melon_slice|sweet_berries|glow_berries|cookie|pumpkin_pie|dried_kelp|rotten_flesh|spider_eye|chorus_fruit|tropical_fish|pufferfish)$/u.test(name || '')) return 'eat';
  return null;
}

export class FirstPersonScene {
  constructor({ renderer, registry = {}, materials = null, atlas = null, maps = null, getPlayerSkin = null, fetchSkin } = {}) {
    if (!renderer?.uploadFirstPersonMesh) throw new Error('FirstPersonScene requires renderer.uploadFirstPersonMesh.');
    this.renderer = renderer; this.atlas = atlas; this.materials = materials; this.maps = maps; this.getPlayerSkin = getPlayerSkin;
    this.library = new ItemMeshLibrary({ registry, materials, atlas }); this.writer = new MeshWriter();
    this.skinCache = new PlayerSkinCache({ appendTile: renderer.appendAtlasTile?.bind(renderer), fetchSkin, onReady: () => { this.dirty = true; } });
    this.profile = null; this.hands = [{ item: null, pending: null, height: 1 }, { item: null, pending: null, height: 1 }];
    this.lastTime = null; this.accumulator = 0; this.swingAt = -Infinity; this.swingHand = 0; this.useAt = -Infinity; this.using = false; this.dirty = true; this.hasMesh = false; this.signature = '';
    this.stats = { vertices: 0, uploads: 0, arms: 0, items: 0, maps: 0, skin: 'default', unsupportedItems: [] };
  }
  setAtlas(atlas) { this.atlas = atlas; this.library.setAssets(atlas, this.materials); this.skinCache.clear(); this.dirty = true; }
  setMaterials(materials) { this.materials = materials; this.library.setAssets(this.atlas, materials); this.dirty = true; }
  setMaps(maps) { this.maps = maps; this.dirty = true; }
  setProfile(profile) { this.profile = profile; this.skinCache.request(profile); this.dirty = true; }
  swing(hand = 0, time = this.lastTime || 0) { this.swingAt = time; this.swingHand = hand; this.dirty = true; }
  consume(event) { if (event?.type === 'swing' || event?.type === 'attack' || event?.type === 'dig-start') this.swing(event.hand || 0); if (event?.type === 'item-used') this.hands[event.hand || 0].height = 0; }
  tick() {
    for (const hand of this.hands) {
      const previousHeight = hand.height, previousItem = hand.item;
      const same = (hand.item?.itemId ?? -1) === (hand.pending?.itemId ?? -1) && Boolean(hand.item?.present) === Boolean(hand.pending?.present);
      hand.height += clamp((same ? 1 : 0) - hand.height, -0.4, 0.4);
      if (hand.height < 0.1) hand.item = hand.pending;
      else if (same) hand.item = hand.pending;
      if (hand.height !== previousHeight || hand.item !== previousItem) this.dirty = true;
    }
  }
  skin(uuid) {
    const external = this.getPlayerSkin?.(uuid); if (external?.tile !== undefined) return external;
    const account = this.skinCache.request(this.profile); if (account?.state === 'ready') return { tile: account.tile, slim: account.slim };
    const fallback = defaultPlayerSkin(uuid || this.profile?.uuid);
    const tile = this.atlas?.entityTiles?.get(fallback.path) ?? this.atlas?.entityTiles?.get('minecraft:entity/player/wide/steve') ?? -1;
    return { tile, slim: fallback.slim && this.atlas?.entityTiles?.has(fallback.path) };
  }
  arm(context, pose, side, skin) {
    const model = bakedEntityModel(skin.slim ? 'player_slim' : 'player'), part = model.parts.find(part => part.name === (side > 0 ? 'right_arm' : 'left_arm'));
    const position = part.offset.map(value => value / 16), matrix = multiply(pose.matrix, [1, 0, 0, 0, -1, 0, 0, 0, 1]);
    const placed = transform(position, pose.matrix).map((value, axis) => value + pose.position[axis]);
    for (const geometry of part.geometry) this.writer.triangles(geometry, context, { matrix, position: placed, tile: skin.tile, reversed: true, tint: skin.tile < 0 ? [0.67, 0.46, 0.33] : [1, 1, 1], flags: 32 });
    this.stats.arms++;
  }
  map(context, slot, options, skin, invisible) {
    const map = this.maps?.tileForItem(slot); if (!map) return false;
    const { pose, armPose } = mapHandPose(options);
    if (!invisible) {
      if (options.twoHanded) for (const side of [1, -1]) this.arm(context, armPose.clone().rotate('y', 92).rotate('x', 45).rotate('z', side * -41).translate(side * 0.3, -1.1, 0.45), side, skin);
      else this.arm(context, armPose, options.side, skin);
    }
    pose.rotate('y', 180).rotate('z', 180).scale(0.38).translate(-0.5, -0.5, 0).scale(1 / 128);
    const background = map.backgroundTile ?? this.atlas?.tileByName?.get('minecraft:map/map_background_checkerboard');
    const emit = (lo, hi, z, tile) => this.writer.triangles(new Float32Array(quadGeometry([[lo, hi, z], [hi, hi, z], [hi, lo, z], [lo, lo, z]], [[0, 1], [1, 1], [1, 0], [0, 0]], [0, 0, -1])), context, { matrix: pose.matrix, normalMatrix: pose.normalMatrix(), position: pose.position, tile, flags: 32 });
    if (background !== undefined) emit(-7, 135, 0, background);
    emit(0, 128, -0.01, map.tile); this.stats.maps++; return true;
  }
  item(context, pose, slot, side, properties) {
    const mesh = this.library.get(slot, properties);
    if (!mesh.parts.length) { this.stats.unsupportedItems.push(mesh.name || this.library.definition(slot)?.name || 'unknown'); return; }
    const key = side > 0 ? 'firstperson_righthand' : 'firstperson_lefthand';
    const ownDisplay = mesh.display[key], rightDisplay = mesh.display.firstperson_righthand;
    const display = ownDisplay || rightDisplay || (mesh.block ? { rotation: [0, side > 0 ? 45 : 225, 0], scale: [0.4, 0.4, 0.4] } : { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] });
    // Native ItemTransform mirrors X translation and Y/Z angles for either
    // an inherited or an explicitly supplied left-hand display entry.
    applyItemDisplay(pose, display, side);
    for (const part of mesh.parts) this.writer.triangles(part.vertices, context, { matrix: pose.matrix, normalMatrix: pose.normalMatrix(), position: pose.position, tile: part.tile, tint: part.tint, flags: part.flags });
    this.stats.items++;
  }
  update(time, input = {}) {
    const { eye, direction, yaw = 0, pitch = 0, state = {} } = input;
    if (!Number.isFinite(time) || !eye || !Array.from(eye).every(Number.isFinite)) return this.stats;
    const dt = this.lastTime === null ? 0 : clamp(time - this.lastTime, 0, 0.25); this.lastTime = time;
    if (state.gameMode === 3 || state.gamemode === 3 || state.health <= 0 || input.visible === false) { this.clearMesh(); return this.stats; }
    if (input.attack && !this.attacking) this.swing(input.swingHand || 0, time); this.attacking = Boolean(input.attack);
    if (input.use && !this.using) this.useAt = time; this.using = Boolean(input.use);
    const desired = [input.mainHand || input.slots?.[36 + (state.selectedSlot || 0)], input.offHand || input.slots?.[45]];
    for (let hand = 0; hand < 2; hand++) { if (this.hands[hand].item === null) this.hands[hand].item = desired[hand] || { present: false }; this.hands[hand].pending = desired[hand] || { present: false }; }
    this.accumulator += dt; while (this.accumulator >= 0.05) { this.tick(); this.accumulator -= 0.05; }
    const swing = input.swingProgress ?? (time - this.swingAt < 0.3 ? clamp((time - this.swingAt) / 0.3) : 0), skin = this.skin(state.uuid || input.uuid);
    const useHand = input.useHand || 0, useDefinition = this.library.definition(this.hands[useHand].item), useAction = this.using ? input.useAction || itemUseAction(useDefinition?.name, true) : null;
    const chargedHands = this.hands.map(hand => this.library.definition(hand.item)?.name === 'crossbow' && Boolean(crossbowProperties(hand.item).charged));
    const useTicks = input.useTicks ?? Math.max(0, (time - this.useAt) * 20);
    const signature = [...eye, ...(direction || []), yaw, pitch, swing, this.swingHand, useAction, useHand, ['eat', 'drink', 'bow', 'crossbow', 'spear', 'brush'].includes(useAction) ? useTicks : 0, input.useDuration, input.charged, ...chargedHands, input.leftHanded, input.invisible, input.skyLight ?? 15, input.blockLight ?? 0, skin.tile, skin.slim, ...this.hands.flatMap(hand => [hand.height, hand.item?.itemId, hand.item?.present, this.maps?.tileForItem(hand.item)?.tile])].join(',');
    if (!this.dirty && this.hasMesh && signature === this.signature) return this.stats;
    this.signature = signature;
    const forward = direction || [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)], right = [Math.cos(yaw), 0, Math.sin(yaw)];
    const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
    const matrix = [right[0], up[0], -forward[0], right[1], up[1], -forward[1], right[2], up[2], -forward[2]];
    // Subtract a nearby double-precision origin before the Float32 writer on
    // every axis, including custom dimensions near signed-i32 Y limits.
    const origin = Array.from(eye, value => Math.floor(value / 256) * 256), context = { position: eye.map((value, axis) => value - origin[axis]), rotation: [0, 0, 0], rotationMatrix: matrix, scale: 1, hurt: false };
    this.writer.reset(); Object.assign(this.stats, { arms: 0, items: 0, maps: 0, unsupportedItems: [], skin: skin.tile >= 0 ? 'textured' : 'color' });
    const left = input.leftHanded ? -1 : 1;
    for (let hand = 0; hand < 2; hand++) {
      const slot = this.hands[hand].item, side = (hand === 0 ? 1 : -1) * left, handSwing = hand === this.swingHand ? swing : 0, equip = 1 - this.hands[hand].height;
      if (useAction === 'scope' || ['bow', 'crossbow'].includes(useAction) && hand !== useHand) continue;
      if (hand === 1 && (!this.using && chargedHands[0] || this.using && useHand === 0 && chargedHands[1] && !['bow', 'crossbow'].includes(useAction))) continue;
      const definition = this.library.definition(slot), using = this.using && (input.useHand || 0) === hand, action = input.useAction && using ? input.useAction : itemUseAction(definition?.name, using);
      if (action === 'scope') continue;
      if (!slot?.present) { if (hand === 0 && !input.invisible) this.arm(context, emptyArmPose({ side, swing: handSwing, equip }), side, skin); continue; }
      if (this.map(context, slot, { side, swing: handSwing, equip, pitch, twoHanded: hand === 0 && !this.hands[1].item?.present }, skin, input.invisible)) continue;
      const duration = input.useDuration ?? (action === 'crossbow' ? 25 : definition?.name === 'dried_kelp' ? 16 : 32);
      const charged = definition?.name === 'crossbow' && Boolean(input.charged ?? chargedHands[hand]), properties = { displayContext: 'firstperson', throwing: using && action === 'spear' ? 1 : 0, pulling: using ? 1 : 0, pull: clamp(useTicks / (action === 'crossbow' ? duration : 20)), charged: charged ? 1 : 0, blocking: using && action === 'block' ? 1 : 0 };
      this.item(context, heldItemPose({ side, swing: handSwing, equip, action, useTicks, duration, charged: charged && hand === 0 }), slot, side, properties);
    }
    if (!this.writer.length) { this.clearMesh(); return this.stats; }
    for (let index = 13; index < this.writer.length; index += 14) this.writer.vertices[index] = (this.writer.vertices[index] & 511) | 512 | ((input.skyLight ?? 15) << 10) | ((input.blockLight ?? 0) << 14);
    const bounds = { min: this.writer.min.map((value, axis) => value + origin[axis]), max: this.writer.max.map((value, axis) => value + origin[axis]) };
    this.renderer.uploadFirstPersonMesh(this.writer.vertices.subarray(0, this.writer.length), EMPTY, bounds, { stride: 14, origin });
    this.hasMesh = true; this.stats.vertices = this.writer.length / 14; this.stats.uploads++; this.dirty = false; return this.stats;
  }
  clearMesh() { if (this.hasMesh) this.renderer.clearFirstPersonMesh(); this.hasMesh = false; this.stats.vertices = 0; this.dirty = true; }
  clear() { this.clearMesh(); this.skinCache.clear(); this.profile = null; this.hands = [{ item: null, pending: null, height: 1 }, { item: null, pending: null, height: 1 }]; this.lastTime = null; this.accumulator = 0; this.swingAt = this.useAt = -Infinity; this.attacking = this.using = false; this.signature = ''; }
}
