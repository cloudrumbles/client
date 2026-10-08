import { blockFriction, blockJumpFactor, blockSpeedFactor, blockName, fallingFluidVelocity } from './movement.js';

const TICK = 0.05;
const EPSILON = 0.0003;
const BOATS = /(?:^|_)boat$|(?:^|_)raft$/;
const HORSES = new Set(['horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'camel']);
const STEERED = new Set(['pig', 'strider']);
const wrapAngle = value => Math.atan2(Math.sin(value), Math.cos(value));
function vector(value) {
  const result = Array.isArray(value) ? value : [value?.x, value?.y, value?.z];
  return result.length === 3 && result.every(Number.isFinite) ? [...result] : null;
}

function attributeValue(attribute) {
  let base = attribute.value ?? attribute.base ?? 0;
  for (const modifier of attribute.modifiers ?? []) if (modifier.operation === 0) base += modifier.amount;
  let value = base;
  for (const modifier of attribute.modifiers ?? []) if (modifier.operation === 1) value += base * modifier.amount;
  for (const modifier of attribute.modifiers ?? []) if (modifier.operation === 2) value *= 1 + modifier.amount;
  return value;
}

/** Registry names select metadata indexes; rotations become Player's north-zero radians. */
export function vehicleStateFromEntity(entity, registry, playerId, { heldItems = [], worldAge = null } = {}) {
  if (!entity || !Number.isInteger(entity.id)) return null;
  const definition = registry.entities?.find(item => item.id === entity.entityType || item.name === entity.type || item.name === entity.name);
  if (!definition) return null;
  const metadata = new Map((entity.metadata ?? []).map(item => [item.key, item.value]));
  const read = (name, fallback) => metadata.get(definition.metadataKeys?.indexOf(name)) ?? fallback;
  const flags = read('flags', 0), passengers = entity.passengers ?? [], index = passengers.indexOf(playerId);
  const horse = HORSES.has(definition.name), boat = BOATS.test(definition.name), baby = Boolean(read('baby', false)), camel = definition.name === 'camel';
  const scale = baby ? camel ? 0.45 : 0.5 : 1;
  const holding = name => heldItems.some(item => String(item).replace(/^minecraft:/, '') === name);
  const steeringItem = definition.name === 'pig' ? holding('carrot_on_a_stick') : definition.name === 'strider' ? holding('warped_fungus_on_a_stick') : false;
  let poseTick = read('last_pose_change_tick', 0n);
  if (Array.isArray(poseTick)) poseTick = BigInt(poseTick[0]) << 32n | BigInt(poseTick[1] >>> 0);
  else if (typeof poseTick !== 'bigint') poseTick = BigInt(poseTick);
  const camelSitting = camel && poseTick < 0n;
  const poseTime = worldAge == null ? Infinity : Number(BigInt(worldAge) - (poseTick < 0n ? -poseTick : poseTick));
  const attributes = new Map((entity.attributes ?? []).map(attribute => [attribute.name.replace(/^minecraft:/, ''), attributeValue(attribute)]));
  return {
    id: entity.id, type: definition.name, position: [entity.x, entity.y, entity.z], yaw: (entity.yaw ?? 0) - Math.PI, pitch: -(entity.pitch ?? 0),
    velocity: entity.velocity ? [entity.velocity.x, entity.velocity.y, entity.velocity.z].map(value => value / 8000 * 20) : undefined,
    controlled: index === 0 && (boat || horse && Boolean(flags & 4) || steeringItem && Boolean(read('saddle', false))), index: Math.max(0, index), count: Math.max(1, passengers.length),
    width: definition.width * scale, height: (definition.height - (camelSitting ? 1.43 : 0)) * scale, baby, scale,
    saddled: horse ? Boolean(flags & 4) : Boolean(read('saddle', false)), standing: horse && Boolean(flags & 32),
    variant: boat ? read('type', 0) : null, noGravity: Boolean(read('no_gravity', false)),
    movementSpeed: attributes.get('generic.movement_speed') ?? (camel ? Math.fround(0.09) : definition.name === 'pig' ? 0.25 : definition.name === 'strider' ? Math.fround(0.175) : 0.225),
    jumpStrength: attributes.get('horse.jump_strength') ?? (camel ? Math.fround(0.42) : 0.7),
    camelSitting, poseTime, dashing: camel && Boolean(read('dash', false)), cold: Boolean(read('suffocating', false)), boostTime: read('boost_time', 0),
  };
}

/** Client-owned boat and horse travel; other passengers follow server movement. */
export class VehicleController {
  constructor(player, state) {
    this.player = player;
    this.id = state.id;
    this.type = String(state.type ?? state.name ?? '').replace(/^minecraft:/, '');
    this.boat = BOATS.test(this.type);
    this.horse = HORSES.has(this.type);
    this.camel = this.type === 'camel';
    this.steered = STEERED.has(this.type);
    this.position = vector(state.position) ?? [...player.position];
    this.velocity = vector(state.velocity) ?? [0, 0, 0];
    this.yaw = Number.isFinite(state.yaw) ? state.yaw : player.yaw;
    this.pitch = Number.isFinite(state.pitch) ? state.pitch : 0;
    this.deltaRotation = 0;
    this.status = null;
    this.lastYd = 0;
    this.jumpChargeTicks = 0;
    this.jumpScale = 0;
    this.pendingJumpScale = 0;
    this.wasJumpHeld = false;
    this.dashCooldown = 0;
    this.boostTicks = 0;
    this.boostTime = 0;
    this.paddles = [false, false];
    this.input = { sideways: 0, forward: 0, jump: false, unmount: false };
    this.grounded = false;
    this.update(state);
  }

  update(state) {
    if ('controlled' in state) this.controlled = Boolean(state.controlled) && (this.boat || this.horse || this.steered);
    this.index = Number.isInteger(state.index) ? state.index : this.index ?? 0;
    this.count = Number.isInteger(state.count) ? state.count : this.count ?? 1;
    this.variant = state.variant ?? this.variant;
    if ('baby' in state) this.baby = Boolean(state.baby);
    if ('standing' in state) this.standing = Boolean(state.standing);
    if ('noGravity' in state) this.noGravity = Boolean(state.noGravity);
    if ('camelSitting' in state) this.camelSitting = Boolean(state.camelSitting);
    if ('cold' in state) this.cold = Boolean(state.cold);
    if (Number.isFinite(state.scale)) this.scale = state.scale;
    if ('poseTime' in state && state.poseTime !== this.poseSourceTime) { this.poseTime = state.poseTime; this.poseSourceTime = state.poseTime; }
    if ('dashing' in state && state.dashing && !this.dashing) this.dashCooldown = 55;
    if ('dashing' in state) this.dashing = Boolean(state.dashing);
    if (Number.isInteger(state.boostTime) && state.boostTime > 0 && state.boostTime !== this.boostTime) { this.boostTime = state.boostTime; this.boostTicks = 0; }
    this.width = Number.isFinite(state.width) && state.width > 0 ? state.width : this.width ?? (this.boat ? 1.375 : this.horse ? 1.3964844 : 0.98);
    this.height = Number.isFinite(state.height) && state.height > 0 ? state.height : this.height ?? (this.boat ? 0.5625 : this.horse ? 1.6 : 0.7);
    this.movementSpeed = Number.isFinite(state.movementSpeed) ? Math.max(0, state.movementSpeed) : this.movementSpeed ?? 0.225;
    this.jumpStrength = Number.isFinite(state.jumpStrength) ? Math.max(0, state.jumpStrength) : this.jumpStrength ?? 0.7;
    if (!this.controlled || state.teleport) {
      const position = vector(state.position);
      if (position) this.position = position;
      if (Number.isFinite(state.yaw)) this.yaw = state.yaw;
      if (Number.isFinite(state.pitch)) this.pitch = state.pitch;
      const velocity = vector(state.velocity);
      if (velocity) this.velocity = velocity;
    }
  }

  get bounds() { return this.boundsAt(this.position); }
  boundsAt(p, height = this.height) { const half = this.width / 2; return [p[0] - half, p[1], p[2] - half, p[0] + half, p[1] + height, p[2] + half]; }
  loadedAt(p) {
    const core = this.player.core;
    if (!core.world_column_loaded) return true;
    const half = this.width / 2 - EPSILON, size = core.world_chunk_size?.() ?? 16;
    return [p[0] - half, p[0] + half].every(x => [p[2] - half, p[2] + half].every(z => core.world_column_loaded(Math.floor(x / size), Math.floor(z / size))));
  }
  collides(p, height = this.height) {
    const bounds = this.boundsAt(p, height);
    if (this.player.core.collides_aabb(...bounds)) return true;
    if (this.type === 'strider') {
      for (let x = Math.floor(bounds[0]); x < Math.ceil(bounds[3]); x++) for (let z = Math.floor(bounds[2]); z < Math.ceil(bounds[5]); z++) {
        for (let y = Math.floor(bounds[1]); y < Math.ceil(bounds[4]); y++) {
          const sample = this.player.sample(x, y, z);
          if (sample.fluid.kind === 'lava' && Number(sample.material?.properties?.level ?? 0) === 0 && this.player.sample(x, y + 1, z).fluid.kind !== 'lava' && this.position[1] >= y + 0.5 - EPSILON && bounds[1] < y + 0.5 - EPSILON) return true;
        }
      }
    }
    return Boolean(this.player.collisionProvider?.(bounds)?.some(([x0, y0, z0, x1, y1, z1]) => bounds[0] < x1 - EPSILON && bounds[3] > x0 + EPSILON && bounds[1] < y1 - EPSILON && bounds[4] > y0 + EPSILON && bounds[2] < z1 - EPSILON && bounds[5] > z0 + EPSILON));
  }
  supportedAt() { const p = [...this.position]; p[1] -= 0.003; return this.collides(p, 0.003); }
  sweepAxis(p, axis, amount) {
    const origin = p[axis], count = Math.max(1, Math.ceil(Math.abs(amount) / 0.2)), part = amount / count;
    for (let index = 0; index < count; index++) {
      const before = p[axis]; p[axis] += part;
      if (!this.collides(p) && this.loadedAt(p)) continue;
      let clear = 0, blocked = 1;
      for (let iteration = 0; iteration < 15; iteration++) {
        const fraction = (clear + blocked) / 2; p[axis] = before + part * fraction;
        if (this.collides(p) || !this.loadedAt(p)) blocked = fraction; else clear = fraction;
      }
      p[axis] = before + part * clear; break;
    }
    return p[axis] - origin;
  }
  horizontal(p, dx, dz) {
    if (Math.abs(dx) < Math.abs(dz)) { const z = this.sweepAxis(p, 2, dz); return [this.sweepAxis(p, 0, dx), z]; }
    const x = this.sweepAxis(p, 0, dx); return [x, this.sweepAxis(p, 2, dz)];
  }
  move() {
    const desired = this.velocity.map(value => value * TICK), start = [...this.position], direct = [...start];
    let y = this.sweepAxis(direct, 1, desired[1]);
    let [x, z] = this.horizontal(direct, desired[0], desired[2]);
    const blocked = Math.abs(desired[0] - x) > EPSILON || Math.abs(desired[2] - z) > EPSILON;
    if ((this.horse || this.steered) && blocked && (this.grounded || desired[1] < 0 && Math.abs(desired[1] - y) > EPSILON)) {
      const stepped = [...start], up = this.sweepAxis(stepped, 1, 1);
      const [sx, sz] = this.horizontal(stepped, desired[0], desired[2]);
      if (sx * sx + sz * sz > x * x + z * z + EPSILON ** 2) {
        this.sweepAxis(stepped, 1, desired[1] - up); y = stepped[1] - start[1]; x = sx; z = sz; direct.splice(0, 3, ...stepped);
      }
    }
    this.position = direct;
    for (const [axis, actual] of [[0, x], [1, y], [2, z]]) if (Math.abs(desired[axis] - actual) > EPSILON) this.velocity[axis] = 0;
    this.lastYd = y; this.grounded = this.supportedAt();
  }

  boatStatus() {
    const [x0, y0, z0, x1, y1, z1] = this.bounds;
    let waterLevel = -Infinity, underwater = null, totalFriction = 0, supports = 0;
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) for (let z = Math.floor(z0); z < Math.ceil(z1); z++) {
      for (const y of new Set([Math.floor(y0), Math.floor(y0 + 0.001), Math.floor(y1), Math.floor(y1 + 0.001)])) {
        const sample = this.player.sample(x, y, z), fluid = sample.fluid;
        if (fluid.kind !== 'water') continue;
        const top = y + (this.player.sample(x, y + 1, z).fluid.kind === 'water' ? 1 : fluid.height);
        if (y <= Math.ceil(y0 + 0.001) - 1) waterLevel = Math.max(waterLevel, top);
        if (top > y1 + 0.001) underwater = Number(sample.material?.properties?.level ?? 0) > 0 ? 'under_flowing_water' : underwater ?? 'under_water';
      }
      const y = Math.floor(y0 - 0.0005), material = this.player.sample(x, y, z).material;
      if (blockName(material) === 'lily_pad') continue;
      if (material?.collisionBoxes?.some(([bx0, by0, bz0, bx1, by1, bz1]) => x0 < x + bx1 && x1 > x + bx0 && z0 < z + bz1 && z1 > z + bz0 && y0 - 0.001 < y + by1 && y0 > y + by0)) { totalFriction += blockFriction(material); supports++; }
    }
    this.waterLevel = underwater ? y1 : waterLevel;
    this.landFriction = supports ? totalFriction / supports : this.supportedAt() ? 0.6 : 0;
    return underwater ?? (waterLevel > y0 ? 'in_water' : this.landFriction > 0 ? 'on_land' : 'in_air');
  }

  floatBoat() {
    const oldStatus = this.status; this.status = this.boatStatus();
    if (oldStatus === 'in_air' && this.status !== 'in_air' && this.status !== 'on_land') {
      this.position[1] = this.waterLevel - this.height + 0.101; this.velocity[1] = 0; this.lastYd = 0; this.status = 'in_water'; return;
    }
    let gravity = this.noGravity ? 0 : -Math.fround(0.04), buoyancy = 0, friction = 0.9;
    if (this.status === 'in_water') buoyancy = (this.waterLevel - this.position[1]) / this.height;
    else if (this.status === 'under_flowing_water') gravity = -0.0007;
    else if (this.status === 'under_water') { buoyancy = Math.fround(0.01); friction = 0.45; }
    else if (this.status === 'on_land') friction = this.landFriction;
    this.velocity[0] *= Math.fround(friction); this.velocity[2] *= Math.fround(friction); this.velocity[1] += gravity / TICK;
    this.deltaRotation *= Math.fround(friction);
    if (buoyancy > 0) this.velocity[1] = (this.velocity[1] + buoyancy * 0.06153846016296973 / TICK) * 0.75;
  }

  tickBoat(keys) {
    this.floatBoat();
    const left = keys.has('KeyA'), right = keys.has('KeyD'), forward = keys.has('KeyW'), back = keys.has('KeyS');
    if (left) this.deltaRotation--; if (right) this.deltaRotation++;
    let acceleration = right !== left && !forward && !back ? Math.fround(0.005) : 0;
    this.yaw += this.deltaRotation * Math.PI / 180;
    if (forward) acceleration += Math.fround(0.04);
    if (back) acceleration -= Math.fround(0.005);
    this.velocity[0] += Math.sin(this.yaw) * acceleration / TICK; this.velocity[2] -= Math.cos(this.yaw) * acceleration / TICK;
    this.paddles = [right && !left || forward, left && !right || forward];
    const turn = this.deltaRotation * Math.PI / 180;
    this.player.yaw += turn;
    this.player.yaw = this.yaw + Math.max(-105 * Math.PI / 180, Math.min(105 * Math.PI / 180, wrapAngle(this.player.yaw - this.yaw)));
    this.move();
  }

  updateHorseJump(keys) {
    const held = keys.has('Space');
    if (this.camel && (this.dashCooldown > 0 || this.camelSitting || this.poseTime < 52)) { this.jumpScale = 0; this.wasJumpHeld = held; return; }
    if (held && !this.wasJumpHeld) { this.jumpChargeTicks = 0; this.jumpScale = 0; }
    else if (held) { this.jumpChargeTicks++; this.jumpScale = this.jumpChargeTicks < 10 ? this.jumpChargeTicks * 0.1 : 0.8 + 0.2 / (this.jumpChargeTicks - 9); }
    else if (this.wasJumpHeld) {
      const power = Math.floor(this.jumpScale * 100);
      this.pendingJumpScale = power >= 90 ? 1 : 0.4 + 0.4 * power / 90;
      this.allowStandSliding = true;
      this.player.onVehicleJump?.({ id: this.id, power });
      this.jumpChargeTicks = -10;
    } else if (this.jumpChargeTicks < 0 && ++this.jumpChargeTicks === 0) this.jumpScale = 0;
    this.wasJumpHeld = held;
  }

  tickHorse(keys) {
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (Number.isFinite(this.poseTime)) this.poseTime++;
    if (this.camel && this.camelSitting && this.poseTime >= 40 && this.input.forward > 0) { this.camelSitting = false; this.poseTime = 0; this.height += 1.43 * (this.scale ?? 1); }
    const refuseMove = this.camel && (this.camelSitting || this.poseTime < 52);
    if (!refuseMove) { this.yaw = this.player.yaw; this.pitch = this.player.pitch * 0.5; }
    const grounded = this.supportedAt(); this.grounded = grounded;
    const support = this.player.materialAt(this.position, 0.500001), friction = blockFriction(support);
    let forward = this.input.forward * 0.98, sideways = -this.input.sideways * 0.49;
    if (forward <= 0) forward *= 0.25;
    if (this.steered) { forward = 1; sideways = 0; }
    else this.updateHorseJump(keys);
    if (refuseMove) { forward = 0; sideways = 0; }
    if (grounded && this.standing && !this.allowStandSliding && !this.pendingJumpScale) { forward = 0; sideways = 0; }
    if (grounded && this.pendingJumpScale > 0) {
      const scale = this.pendingJumpScale;
      if (this.camel) {
        const dash = Math.fround(22.2222) * scale * this.movementSpeed * blockSpeedFactor(support) / TICK;
        this.velocity[0] += Math.sin(this.yaw) * dash; this.velocity[2] -= Math.cos(this.yaw) * dash;
        this.velocity[1] += Math.fround(1.4285) * scale * this.jumpStrength * blockJumpFactor(support) / TICK;
        this.dashCooldown = 55; this.dashing = true;
      } else {
        this.velocity[1] = this.jumpStrength * scale * blockJumpFactor(support) / TICK;
        if (forward > 0) { this.velocity[0] += Math.sin(this.yaw) * 0.4 * scale / TICK; this.velocity[2] -= Math.cos(this.yaw) * 0.4 * scale / TICK; }
      }
      this.pendingJumpScale = 0;
    }
    const fluid = this.fluidContact();
    if (this.type === 'strider' && fluid.kind === 'lava') fluid.kind = null;
    let speed = this.movementSpeed;
    if (this.steered) {
      const boost = this.boostTime > 0 && this.boostTicks <= this.boostTime ? 1 + 1.15 * Math.sin(++this.boostTicks / this.boostTime * Math.PI) : 1;
      speed *= (this.type === 'pig' ? 0.225 : this.cold ? 0.35 : 0.55) * boost;
    } else if (this.camel && this.player.canSprint && !this.dashCooldown && (keys.has('ControlLeft') || keys.has('ControlRight'))) speed += Math.fround(0.1);
    const acceleration = fluid.kind ? 0.02 : grounded ? speed * 0.216 / friction ** 3 : speed * 0.1;
    const length = Math.max(1, Math.hypot(forward, sideways)); forward /= length; sideways /= length;
    this.velocity[0] += (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * sideways) * acceleration / TICK;
    this.velocity[2] += (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * sideways) * acceleration / TICK;
    const falling = this.velocity[1] <= 0;
    if (refuseMove && grounded) { this.velocity[0] = 0; this.velocity[2] = 0; }
    this.move();
    if (fluid.kind) {
      const water = fluid.kind === 'water', drag = water ? 0.8 : 0.5;
      this.velocity[0] *= drag; this.velocity[2] *= drag;
      this.velocity[1] *= water || fluid.depth <= 0.4 ? 0.8 : 0.5;
      if (water || fluid.depth <= 0.4) this.velocity[1] = fallingFluidVelocity(this.velocity[1] * TICK, 0.08, falling, false) / TICK;
      if (!water) this.velocity[1] -= 0.4;
    } else {
      this.velocity[1] = (this.velocity[1] - (this.noGravity ? 0 : 1.6)) * 0.98;
      const drag = grounded ? friction * 0.91 : 0.91; this.velocity[0] *= drag; this.velocity[2] *= drag;
    }
    if (this.type === 'strider' && this.fluidContact().kind === 'lava') {
      const below = Math.floor(this.position[1]), above = this.player.sample(Math.floor(this.position[0]), below + 1, Math.floor(this.position[2])).fluid;
      if (this.position[1] < below + 0.5 - EPSILON || above.kind === 'lava') { this.velocity = this.velocity.map(value => value * 0.5); this.velocity[1] += 1; }
      else this.grounded = true;
    }
  }

  fluidContact() {
    const bounds = this.bounds; let kind = null, depth = 0;
    for (let x = Math.floor(bounds[0] + 0.001); x < Math.ceil(bounds[3] - 0.001); x++) for (let z = Math.floor(bounds[2] + 0.001); z < Math.ceil(bounds[5] - 0.001); z++) {
      for (let y = Math.floor(bounds[1] + 0.001); y < Math.ceil(bounds[4] - 0.001); y++) {
        const fluid = this.player.sample(x, y, z).fluid;
        if (!fluid.kind) continue;
        const top = y + (this.player.sample(x, y + 1, z).fluid.kind === fluid.kind ? 1 : fluid.height);
        if (top > bounds[1] + 0.001) { kind = fluid.kind; depth = Math.max(depth, top - bounds[1]); }
      }
    }
    return { kind, depth };
  }

  get seatPosition() {
    let offsetY = this.height - 0.6, forward = 0;
    if (this.boat) { offsetY = (this.variant === 'bamboo' || this.variant === 8 || this.type.includes('raft') ? this.height * Math.fround(0.8888889) : this.height / 3) - Math.fround(0.6); if (this.count > 1) forward = this.index === 0 ? 0.2 : -0.6; }
    else if (this.type.includes('minecart')) offsetY = 0.1875 - Math.fround(0.6);
    else if (this.camel) {
      const scale = this.scale ?? 1, front = this.index === 0, sitting = Boolean(this.camelSitting), duration = sitting ? 40 : 52, transition = this.poseTime < duration;
      let anchor = this.height - 0.375 * scale;
      const high = 1.43 * scale, low = 0.2 * scale;
      if (transition) {
        const split = sitting ? 28 : front ? 24 : 32, ratio = sitting ? front ? 0.5 : 0.1 : front ? 0.6 : 0.35;
        const time = Math.max(0, this.poseTime), first = time < split, phase = first ? time / split : (time - split) / (duration - split), middle = high - ratio * (high - low);
        const start = sitting ? first ? high : middle : first ? low - high : low - middle, end = sitting ? first ? middle : low : first ? low - middle : 0;
        anchor += start + (end - start) * phase;
      } else if (sitting) anchor += low;
      offsetY = anchor - Math.fround(0.6); forward = (this.count > 1 && !front ? -0.7 : 0.5) * scale;
    } else if (this.horse) offsetY = this.height + (this.baby ? 0.125 : -0.15625) - Math.fround(0.6);
    else if (this.type === 'pig') offsetY = this.height - 0.03125 - Math.fround(0.6);
    return [this.position[0] + Math.sin(this.yaw) * forward, this.position[1] + offsetY, this.position[2] - Math.cos(this.yaw) * forward];
  }
  get state() { return { id: this.id, type: this.type, position: [...this.position], velocity: [...this.velocity], yaw: this.yaw, pitch: this.pitch, grounded: this.grounded, controlled: this.controlled, paddles: [...this.paddles], input: { ...this.input }, jumpScale: this.jumpScale, status: this.status, dashCooldown: this.dashCooldown, sitting: this.camelSitting, poseTime: this.poseTime }; }
  tick(keys) {
    this.input = { sideways: Number(keys.has('KeyA')) - Number(keys.has('KeyD')), forward: Number(keys.has('KeyW')) - Number(keys.has('KeyS')), jump: keys.has('Space'), unmount: keys.has('ShiftLeft') || keys.has('ShiftRight') };
    this.player.waitingForTerrain = this.controlled && !this.loadedAt(this.position);
    if (this.controlled && !this.player.waitingForTerrain) { if (this.boat) this.tickBoat(keys); else if (this.horse || this.steered) this.tickHorse(keys); }
    this.player.position = this.seatPosition; this.player.velocity.fill(0); this.player.grounded = false; this.player.fly = false;
    this.player.setFallFlying(false); this.player.swimming = false; this.player.height = 1.8; this.player.pose = 'sitting';
    this.player.onVehicleMove?.(this.state);
  }
}
