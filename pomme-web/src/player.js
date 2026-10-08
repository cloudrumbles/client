import { EFFECT_NAMES, CLIMBABLE, blockName, blockFriction, blockSpeedFactor, blockJumpFactor, fluidState, fluidFlowAt, fallingFluidVelocity, elytraVelocity } from './movement.js';
import { VehicleController } from './vehicle.js';
import { aabbAt, expandAabb, intersectsAabb, clipShapeAxis, clipShapeMovement, restrictPistonMovement, blockMotionDisplacement, pistonBaseCorrection } from './dynamic-collision.js';

const TICK = 1 / 20;
const HALF_WIDTH = 0.3;
const STANDING_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.5;
const SWIMMING_HEIGHT = 0.6;
const STEP_HEIGHT = 0.6;
const EPSILON = 0.0003;
const EMPTY_KEYS = new Set();

/** Fixed 20 Hz Minecraft-style locomotion. Velocity is expressed in metres/second. */
export class Player {
  constructor(core, { materials = null, onFallFlyingChange = null } = {}) {
    this.core = core;
    this.setMaterials(materials);
    this.effects = new Map();
    this.equipment = { depthStrider: 0, soulSpeed: 0, elytra: false, leatherBoots: false };
    this.onFallFlyingChange = onFallFlyingChange;
    this.fallFlying = false;
    this.wasJumpHeld = false;
    this.fallFlyTicks = 0;
    this.collisionProvider = null;
    this.collisionEntryProvider = null;
    this.mainSupportingBlockPos = null;
    this.onGroundNoBlocks = false;
    this.pistonDeltas = [0, 0, 0];
    this.pistonDeltasTick = null;
    this.collisionOptions = null;
    this.vehicle = null;
    this.onVehicleMove = null;
    this.onVehicleJump = null;
    this.stuckSpeedMultiplier = null;
    this.inPowderSnow = false;
    this.fireworkBoosting = false;
    this.sleeping = false;
    this.wakeRequested = false;
    this.onWakeRequest = null;
    this.onFlyingChange = null;
    const x = (core.world_origin_x?.() ?? 0) + Math.floor(core.world_width() / 2);
    const z = (core.world_origin_z?.() ?? 0) + Math.floor(core.world_depth() * 0.6875);
    this.position = [x + 0.5, core.terrain_height(x, z) + 2, z + 0.5];
    this.velocity = [0, 0, 0];
    this.yaw = 0;
    this.pitch = -0.12;
    this.grounded = false;
    this.sneaking = false;
    this.sprinting = false;
    this.canSprint = true;
    this.movementMultiplier = 1;
    this.flyingSpeed = 0.05;
    this.submerged = false;
    this.fluid = null;
    this.fluidHeight = 0;
    this.eyesInWater = false;
    this.swimming = false;
    this.climbing = false;
    this.horizontalCollision = false;
    this.fallDistance = 0;
    this.pose = 'standing';
    this.inputMultiplier = 1;
    this.fly = false;
    this.noclip = false;
    this.waitingForTerrain = false;
    this.height = STANDING_HEIGHT;
    this.accumulator = 0;
    this.previousPosition = [...this.position];
    this.simulatedPosition = null;
    this.interpolate = true;
    this.jumpDelay = 0;
    const top = (core.world_min_y?.() ?? 0) + core.world_height();
    while (this.collides() && this.position[1] < top + 1) this.position[1]++;
  }

  get verticalSpeed() { return this.velocity[1]; }
  set verticalSpeed(value) { this.velocity[1] = Number.isFinite(value) ? value : 0; }
  get renderPosition() {
    if (!this.interpolate || this.simulatedPosition !== this.position) return [...this.position];
    const fraction = Math.min(1, this.accumulator / TICK);
    return this.position.map((value, axis) => this.previousPosition[axis] + (value - this.previousPosition[axis]) * fraction);
  }
  get eyeHeight() { return this.sleeping ? 0.2 : this.height <= SWIMMING_HEIGHT ? 0.4 : this.height < STANDING_HEIGHT ? 1.27 : 1.62; }
  get eye() { const p = this.renderPosition; return [p[0], p[1] + this.eyeHeight, p[2]]; }
  get direction() { const c = Math.cos(this.pitch); return [Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c]; }

  setMaterials(materials) {
    this.materials = materials?.materials ?? materials;
    this.collisionPadding = 1;
    const entries = this.materials instanceof Map ? this.materials.values() : Object.values(this.materials ?? {});
    for (const material of entries) for (const box of material?.collisionBoxes ?? []) {
      for (let axis = 0; axis < 3; axis++) this.collisionPadding = Math.max(this.collisionPadding, Math.ceil(Math.max(-box[axis], box[axis + 3] - 1)));
    }
  }

  setCollisionProvider(provider, entryProvider = null) {
    this.collisionProvider = typeof provider === 'function' ? provider : null;
    this.collisionEntryProvider = typeof entryProvider === 'function' ? entryProvider : null;
  }

  /** Native block-entity displacement, distinct from voluntary sneak movement. */
  applyBlockMotions(events = []) {
    if (this.noclip || this.vehicle) return 0;
    let moved = 0;
    // A slow display frame can contain several native ticks from several block
    // entities. Process tick order before sharing Entity's piston-delta cap.
    const ordered = [...events].sort((left, right) => {
      const valid = value => typeof value === 'bigint' || Number.isFinite(value);
      return valid(left?.tick) && valid(right?.tick) ? left.tick < right.tick ? -1 : left.tick > right.tick ? 1 : 0 : 0;
    });
    for (const event of ordered) {
      if (!event || typeof event !== 'object') continue;
      if (!Array.isArray(event.position) || event.position.length !== 3 || !event.position.every(Number.isFinite) || !Array.isArray(event.direction) || event.direction.length !== 3 || event.direction.filter(value => value === 1 || value === -1).length !== 1 || event.direction.some(value => ![-1, 0, 1].includes(value))) continue;
      const supportedBy = this.mainSupportingBlockPos?.every((value, axis) => value === event.position[axis]) ?? false;
      const push = blockMotionDisplacement(event, aabbAt(this.position, HALF_WIDTH, this.height), { grounded: this.grounded, position: this.position, supportedBy });
      if (!push) continue;
      if (push.slime) this.velocity[push.axis] = push.direction[push.axis] / TICK;
      const shift = (direction, distance) => {
        const axis = direction.findIndex(value => value !== 0);
        let displacement = direction[axis] * distance;
        if (event.kind === 'piston') {
          const tick = String(event.tick ?? Math.floor(this.motionTime ?? 0));
          if (tick !== this.pistonDeltasTick) { this.pistonDeltas.fill(0); this.pistonDeltasTick = tick; }
          const cap = restrictPistonMovement(this.pistonDeltas[axis], displacement);
          this.pistonDeltas[axis] = cap.cumulative; displacement = cap.allowed;
        }
        if (!displacement) return;
        const before = [...this.position], previousOptions = this.collisionOptions;
        this.collisionOptions = { excludeMotion: event.key ?? event.position.join(','), direction: event.direction };
        // MoverType.PISTON bypasses Player.maybeBackOffFromEdge. The source
        // moving shape is excluded through the provider, fixed terrain remains.
        const delta = [0, 0, 0]; delta[axis] = displacement;
        try { this.move(...delta, { external: true }); }
        finally { this.collisionOptions = previousOptions; }
        const movedAxis = this.position[axis] - before[axis];
        if (Math.abs(movedAxis) > 1e-7) {
          moved++;
          this.previousPosition = this.previousPosition.map((value, index) => value + this.position[index] - before[index]);
          this.simulatedPosition = this.position;
          this.grounded = !this.fly && this.supportedAt();
          if (this.grounded) this.fallDistance = 0;
        }
      };
      shift(push.direction, push.distance);
      if (push.distance > 0) {
        const correction = pistonBaseCorrection(event, aabbAt(this.position, HALF_WIDTH, this.height));
        if (correction) shift(correction.direction, correction.distance);
      }
    }
    return moved;
  }

  setVehicle(state) {
    if (!state || !Number.isInteger(state.id)) { this.vehicle = null; return; }
    if (this.vehicle?.id === state.id) {
      this.vehicle.update(state);
      if (this.vehicle.controlled && !state.teleport) return;
    }
    else { this.vehicle = new VehicleController(this, state); this.velocity.fill(0); this.setFallFlying(false); this.swimming = false; }
    this.position = this.vehicle.seatPosition;
    this.previousPosition = [...this.position]; this.simulatedPosition = null;
  }

  setSleeping(active, { position = null } = {}) {
    const next = Boolean(active);
    if (next && !this.sleeping) {
      if (Array.isArray(position) && position.length === 3 && position.every(Number.isFinite)) this.setPosition([position[0] + 0.5, position[1] + 0.6875, position[2] + 0.5]);
      this.velocity.fill(0); this.height = 0.2; this.pose = 'sleeping'; this.wakeRequested = false;
      this.setFallFlying(false);
    } else if (!next && this.sleeping) { this.height = STANDING_HEIGHT; this.pose = 'standing'; this.wakeRequested = false; }
    this.sleeping = next;
  }

  requestWake() {
    if (!this.sleeping || this.wakeRequested) return false;
    this.wakeRequested = true; this.onWakeRequest?.(); return true;
  }

  setFallFlying(active, { notify = false } = {}) {
    const next = Boolean(active), changed = next !== this.fallFlying;
    this.fallFlying = next;
    if (!next) this.fallFlyTicks = 0;
    if (changed && notify) this.onFallFlyingChange?.(next);
    return changed;
  }

  startFallFlying() {
    if (this.vehicle || this.grounded || this.supportedAt() || this.fallFlying || this.fly || this.noclip || this.fluid === 'water' || this.effectLevel('levitation') || !this.equipment.elytra || this.climbableAt()) return false;
    this.setFallFlying(true, { notify: true });
    return true;
  }

  setEffects(effects = []) {
    const next = new Map();
    const entries = effects instanceof Map ? effects.entries() : Array.isArray(effects) ? effects.map(effect => [effect.name ?? effect.id, effect]) : Object.entries(effects);
    for (const [key, value] of entries) {
      const name = (typeof key === 'number' || /^\d+$/.test(String(key))) ? EFFECT_NAMES[Number(key)] : String(key).replace(/^minecraft:/, '');
      const amplifier = typeof value === 'number' ? value : value?.amplifier;
      if (!name || !Number.isInteger(amplifier) || amplifier < 0 || amplifier > 255) continue;
      const duration = typeof value === 'object' && Number.isInteger(value.duration) ? value.duration : -1;
      if (duration === 0) continue;
      const previous = this.effects.get(name);
      next.set(name, previous?.amplifier === amplifier && previous?.sourceDuration === duration ? previous : { amplifier, duration, sourceDuration: duration });
    }
    this.effects = next;
  }

  setEquipment(equipment = {}) {
    for (const key of ['depthStrider', 'soulSpeed']) if (Number.isInteger(equipment[key])) this.equipment[key] = Math.max(0, Math.min(255, equipment[key]));
    for (const key of ['elytra', 'leatherBoots']) if (key in equipment) this.equipment[key] = Boolean(equipment[key]);
  }

  setFireworkBoost(active) { this.fireworkBoosting = Boolean(active); }
  applyFireworkBoost() {
    if (!this.fallFlying) return false;
    const direction = this.direction;
    for (let axis = 0; axis < 3; axis++) this.velocity[axis] += direction[axis] * 0.1 / TICK + (direction[axis] * 1.5 / TICK - this.velocity[axis]) * 0.5;
    return true;
  }

  effectLevel(name) { const effect = this.effects.get(name); return effect && effect.duration !== 0 ? effect.amplifier + 1 : 0; }

  sample(x, y, z) {
    const key = this.sampleCache ? `${x},${y},${z}` : null;
    const cached = this.sampleCache?.get(key);
    if (cached) return cached;
    const id = this.core.block_get?.(x, y, z) ?? 0;
    const material = this.materials instanceof Map ? this.materials.get(id) : this.materials?.[id];
    const flags = this.core.block_flags?.(id) ?? material?.flags ?? 0;
    const result = { id, material, flags, fluid: fluidState(material, flags) };
    this.sampleCache?.set(key, result);
    return result;
  }

  materialAt(p = this.position, yOffset = 0) { return this.sample(Math.floor(p[0]), Math.floor(p[1] - yOffset), Math.floor(p[2])).material; }

  climbableAt() {
    if (this.fly || this.noclip || this.fallFlying) return null;
    const here = this.materialAt(), name = blockName(here);
    if (CLIMBABLE.has(name)) return here;
    const below = this.materialAt(this.position, 1);
    return name.endsWith('_trapdoor') && here.properties?.open === 'true' && blockName(below) === 'ladder' && here.properties.facing === below.properties?.facing ? here : null;
  }

  setPosition(position, { yaw, pitch, resetVelocity = true } = {}) {
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return false;
    this.position = [...position];
    this.previousPosition = [...position];
    this.simulatedPosition = null;
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (Number.isFinite(pitch)) this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
    if (resetVelocity) { this.velocity.fill(0); this.accumulator = 0; this.jumpDelay = 0; this.fallDistance = 0; }
    if (resetVelocity) { this.pistonDeltas.fill(0); this.pistonDeltasTick = null; }
    this.mainSupportingBlockPos = null; this.onGroundNoBlocks = false;
    this.grounded = false;
    this.waitingForTerrain = !this.loadedAt();
    return true;
  }

  look(dx, dy) { this.yaw += dx * 0.002; this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch - dy * 0.002)); }

  loadedAt(p = this.position) {
    if (!this.core.world_column_loaded) return true;
    const size = this.core.world_chunk_size?.() ?? 16;
    // A neighbouring unloaded column must not become an invisible hole under a foot.
    for (const x of [p[0] - HALF_WIDTH + EPSILON, p[0] + HALF_WIDTH - EPSILON]) {
      for (const z of [p[2] - HALF_WIDTH + EPSILON, p[2] + HALF_WIDTH - EPSILON]) {
        if (!this.core.world_column_loaded(Math.floor(x / size), Math.floor(z / size))) return false;
      }
    }
    return true;
  }

  collides(p = this.position, height = this.height) {
    if (!p.every(Number.isFinite)) return true;
    const bounds = [p[0] - HALF_WIDTH, p[1], p[2] - HALF_WIDTH, p[0] + HALF_WIDTH, p[1] + height, p[2] + HALF_WIDTH];
    const extra = this.collisionProvider?.(bounds, this.collisionOptions);
    if (extra?.some(([x0, y0, z0, x1, y1, z1]) => bounds[0] < x1 - EPSILON && bounds[3] > x0 + EPSILON &&
      bounds[1] < y1 - EPSILON && bounds[4] > y0 + EPSILON && bounds[2] < z1 - EPSILON && bounds[5] > z0 + EPSILON)) return true;
    const hit = Boolean(this.core.collides_aabb(...bounds));
    if (!this.materials) return hit;
    let contextual = false;
    for (let x = Math.floor(p[0] - HALF_WIDTH); x <= Math.floor(p[0] + HALF_WIDTH); x++) {
      for (let z = Math.floor(p[2] - HALF_WIDTH); z <= Math.floor(p[2] + HALF_WIDTH); z++) {
        for (let y = Math.floor(p[1]) - 1; y <= Math.floor(p[1] + height); y++) {
          if (['scaffolding', 'powder_snow'].includes(blockName(this.sample(x, y, z).material))) contextual = true;
        }
      }
    }
    if (!contextual) return hit;
    for (let x = Math.floor(bounds[0]); x <= Math.floor(bounds[3]); x++) {
      for (let z = Math.floor(bounds[2]); z <= Math.floor(bounds[5]); z++) {
        for (let y = Math.floor(bounds[1]) - 1; y <= Math.floor(bounds[4]); y++) {
          const { material, flags } = this.sample(x, y, z);
          const boxes = this.collisionBoxesFor(material, flags, y);
          if (boxes.some(([x0, y0, z0, x1, y1, z1]) => bounds[0] < x + x1 - EPSILON && bounds[3] > x + x0 + EPSILON &&
            bounds[1] < y + y1 - EPSILON && bounds[4] > y + y0 + EPSILON && bounds[2] < z + z1 - EPSILON && bounds[5] > z + z0 + EPSILON)) return true;
        }
      }
    }
    return false;
  }

  collisionBoxesFor(material, flags, y) {
    const name = blockName(material);
    if (name === 'scaffolding') {
      const feet = this.position[1];
      return !this.scaffoldDescending && feet >= y + 1 - EPSILON ? material.collisionBoxes ?? [] :
        material.properties?.bottom === 'true' && material.properties?.distance !== '0' && feet >= y - EPSILON ? [[0, 0, 0, 1, 0.125, 1]] : [];
    }
    if (name === 'powder_snow') return this.fallDistance > 2.5 ? [[0, 0, 0, 1, Math.fround(0.9), 1]] :
      this.equipment.leatherBoots && !this.scaffoldDescending && this.position[1] >= y + 1 - EPSILON ? [[0, 0, 0, 1, 1, 1]] : [];
    return material?.collisionBoxes ?? (flags & 1 ? [[0, 0, 0, 1, 1, 1]] : []);
  }

  /** Discover authoritative material shapes and loaded-world barriers once. */
  collisionShapes(bounds) {
    if (!this.materials || !this.core.block_get) return null;
    const padding = this.collisionPadding, shapes = [], lo = bounds.slice(0, 3).map(value => Math.floor(value) - padding), hi = bounds.slice(3).map(value => Math.floor(value - 1e-7) + padding);
    if (lo.reduce((count, value, axis) => count * (hi[axis] - value + 1), 1) > 16384) return null;
    const originX = this.core.world_origin_x?.() ?? 0, originZ = this.core.world_origin_z?.() ?? 0;
    const maxX = originX + this.core.world_width(), maxZ = originZ + this.core.world_depth();
    const minY = this.core.world_min_y?.() ?? 0, maxY = minY + this.core.world_height();
    for (let x = Math.max(lo[0], originX); x <= Math.min(hi[0], maxX - 1); x++) {
      for (let z = Math.max(lo[2], originZ); z <= Math.min(hi[2], maxZ - 1); z++) {
        for (let y = Math.max(lo[1], minY); y <= Math.min(hi[1], maxY - 1); y++) {
          const { id, material, flags } = this.sample(x, y, z);
          if (id && !material && flags & 1) return null;
          for (const box of this.collisionBoxesFor(material, flags, y)) {
            const worldBox = box.map((value, index) => value + [x, y, z][index % 3]);
            if (intersectsAabb(bounds, worldBox, -1e-7)) shapes.push(worldBox);
          }
        }
      }
    }
    // Window and unloaded-column barriers are browser streaming constraints.
    // Representing them as shapes avoids probing/sweeping through missing data.
    const lower = bounds.slice(0, 3).map(value => value - 1), upper = bounds.slice(3).map(value => value + 1);
    if (bounds[0] <= originX) shapes.push([lower[0], lower[1], lower[2], originX, upper[1], upper[2]]);
    if (bounds[3] >= maxX) shapes.push([maxX, lower[1], lower[2], upper[0], upper[1], upper[2]]);
    if (bounds[2] <= originZ) shapes.push([lower[0], lower[1], lower[2], upper[0], upper[1], originZ]);
    if (bounds[5] >= maxZ) shapes.push([lower[0], lower[1], maxZ, upper[0], upper[1], upper[2]]);
    if (bounds[1] <= minY && this.core.collides_aabb(originX + .4, minY - .01, originZ + .4, originX + .6, minY - .001, originZ + .6)) shapes.push([lower[0], lower[1], lower[2], upper[0], minY, upper[2]]);
    if (this.core.world_column_loaded) {
      const size = this.core.world_chunk_size?.() ?? 16;
      for (let x = Math.floor(bounds[0] / size); x <= Math.floor(bounds[3] / size); x++) {
        for (let z = Math.floor(bounds[2] / size); z <= Math.floor(bounds[5] / size); z++) {
          if (!this.core.world_column_loaded(x, z)) shapes.push([x * size, lower[1], z * size, (x + 1) * size, upper[1], (z + 1) * size]);
        }
      }
    }
    for (const box of this.collisionProvider?.(bounds, this.collisionOptions) ?? []) if (intersectsAabb(bounds, box, -1e-7)) shapes.push(box);
    return shapes;
  }

  intersectsBlock(x, y, z) {
    const [px, py, pz] = this.position;
    return x < px + HALF_WIDTH && x + 1 > px - HALF_WIDTH && y < py + this.height && y + 1 > py && z < pz + HALF_WIDTH && z + 1 > pz - HALF_WIDTH;
  }

  supportedAt(p = this.position, distance = 0.003) {
    return this.collides([p[0], p[1] - distance, p[2]], distance);
  }

  findSupportingBlock(bounds) {
    let selected = null, selectedDistance = Infinity;
    const consider = position => {
      const distance = position.reduce((sum, value, axis) => sum + (value + .5 - this.position[axis]) ** 2, 0);
      const compare = other => position[1] - other[1] || position[2] - other[2] || position[0] - other[0];
      if (distance < selectedDistance || distance === selectedDistance && (!selected || compare(selected) > 0)) { selected = position; selectedDistance = distance; }
    };
    const padding = this.collisionPadding;
    for (let x = Math.floor(bounds[0]) - padding; x <= Math.floor(bounds[3]) + padding; x++) {
      for (let z = Math.floor(bounds[2]) - padding; z <= Math.floor(bounds[5]) + padding; z++) {
        for (let y = Math.floor(bounds[1]) - padding; y <= Math.floor(bounds[4]) + padding; y++) {
          const { material, flags } = this.sample(x, y, z);
          if (this.collisionBoxesFor(material, flags, y).some(box => intersectsAabb(bounds, box.map((value, index) => value + [x, y, z][index % 3]), 1e-7))) consider([x, y, z]);
        }
      }
    }
    for (const entry of this.collisionEntryProvider?.(bounds) ?? []) if (entry.position?.length === 3 && entry.box?.length === 6 && intersectsAabb(bounds, entry.box, 1e-7)) consider(entry.position);
    return selected;
  }

  // Native Entity.checkSupportingBlock and CollisionGetter.findSupportingBlock:
  // query the 1e-6 foot slab, retain fallback support at the previous horizontal
  // position, and choose nearest block center with BlockPos Y/Z/X tie order.
  updateSupportingBlock(grounded, movement = null) {
    if (!grounded) { this.mainSupportingBlockPos = null; this.onGroundNoBlocks = false; return; }
    const box = aabbAt(this.position, HALF_WIDTH, this.height), feet = [box[0], box[1] - 1e-6, box[2], box[3], box[1], box[5]];
    let found = this.findSupportingBlock(feet);
    if (!found && !this.onGroundNoBlocks && movement) found = this.findSupportingBlock(feet.map((value, index) => value - (index % 3 === 1 ? 0 : movement[index % 3])));
    this.mainSupportingBlockPos = found; this.onGroundNoBlocks = !found;
  }

  fluidAt() { return this.fluidContact().kind !== null; }

  fluidContact(p = this.position, height = this.height, push = false) {
    const [x, y, z] = p, depths = { water: 0, lava: 0 }, flows = { water: [0, 0, 0], lava: [0, 0, 0] }, counts = { water: 0, lava: 0 };
    for (let bx = Math.floor(x - HALF_WIDTH + 0.001); bx <= Math.floor(x + HALF_WIDTH - 0.001); bx++) {
      for (let bz = Math.floor(z - HALF_WIDTH + 0.001); bz <= Math.floor(z + HALF_WIDTH - 0.001); bz++) {
        for (let by = Math.floor(y + 0.001); by <= Math.floor(y + height - 0.001); by++) {
          const fluid = this.sample(bx, by, bz).fluid;
          if (!fluid.kind) continue;
          const top = by + (this.sample(bx, by + 1, bz).fluid.kind === fluid.kind ? 1 : fluid.height);
          if (top < y + 0.001) continue;
          depths[fluid.kind] = Math.max(depths[fluid.kind], top - y);
          if (push) {
            const flow = fluidFlowAt((sx, sy, sz) => this.sample(sx, sy, sz), bx, by, bz, fluid);
            const factor = depths[fluid.kind] < 0.4 ? depths[fluid.kind] : 1;
            for (let axis = 0; axis < 3; axis++) flows[fluid.kind][axis] += flow[axis] * factor;
            counts[fluid.kind]++;
          }
        }
      }
    }
    const kind = depths.water > 0 ? 'water' : depths.lava > 0 ? 'lava' : null;
    if (kind && push && !this.fly && !this.noclip && counts[kind]) {
      const speed = kind === 'water' ? 0.014 : 0.0023333333333333335;
      const impulse = flows[kind].map(value => value / counts[kind] * speed);
      const length = Math.hypot(...impulse);
      if (length > 1e-5) {
        if (Math.abs(this.velocity[0] * TICK) < 0.003 && Math.abs(this.velocity[2] * TICK) < 0.003 && length < 0.0045) for (let axis = 0; axis < 3; axis++) impulse[axis] *= 0.0045 / length;
        for (let axis = 0; axis < 3; axis++) this.velocity[axis] += impulse[axis] / TICK;
      }
    }
    const ey = y + this.eyeHeight, bx = Math.floor(x), by = Math.floor(ey), bz = Math.floor(z);
    const eyeFluid = this.sample(bx, by, bz).fluid;
    const eyeTop = by + (this.sample(bx, by + 1, bz).fluid.kind === eyeFluid.kind ? 1 : eyeFluid.height);
    return { kind, depth: kind ? depths[kind] : 0, eyesInWater: eyeFluid.kind === 'water' && ey <= eyeTop };
  }

  sweepAxis(position, axis, displacement) {
    if (Math.abs(displacement) < 1e-10) return 0;
    const bounds = aabbAt(position, HALF_WIDTH, this.height), delta = [0, 0, 0]; delta[axis] = displacement;
    const shapes = this.collisionShapes(expandAabb(bounds, delta));
    if (shapes) {
      const result = clipShapeAxis(bounds, shapes, axis, displacement);
      const destination = [...position]; destination[axis] += result;
      // Custom ABI fixtures/legacy demo cores may expose additional collision
      // without a material shape. Retain their conservative fallback.
      if (!this.collides(destination) || shapes.some(shape => intersectsAabb(aabbAt(destination, HALF_WIDTH, this.height), shape, EPSILON))) { position[axis] += result; return result; }
    }
    return this.sweepAxisFallback(position, axis, displacement);
  }

  sweepAxisFallback(position, axis, displacement) {
    // Used only with cores/materials that cannot describe their occupied boxes.
    const start = position[axis];
    const count = Math.max(1, Math.ceil(Math.abs(displacement) / 0.2));
    const part = displacement / count;
    for (let step = 0; step < count; step++) {
      const before = position[axis];
      position[axis] = before + part;
      if (!this.collides(position) && this.loadedAt(position)) continue;
      let clear = 0, blocked = 1;
      for (let iteration = 0; iteration < 15; iteration++) {
        const middle = (clear + blocked) / 2;
        position[axis] = before + part * middle;
        if (this.collides(position) || !this.loadedAt(position)) blocked = middle;
        else clear = middle;
      }
      position[axis] = before + part * clear;
      // The legacy Boolean ABI deliberately deflates overlaps by 1e-4. Avoid
      // accumulating that tolerance into repeated ground/streaming-barrier drift.
      if (Math.abs(position[axis] - before) < 0.0001) position[axis] = before;
      break;
    }
    return position[axis] - start;
  }

  moveHorizontal(position, dx, dz) {
    // Match Minecraft's preference for resolving the larger horizontal axis first.
    if (Math.abs(dx) < Math.abs(dz)) {
      const z = this.sweepAxis(position, 2, dz), x = this.sweepAxis(position, 0, dx);
      return [x, z];
    }
    const x = this.sweepAxis(position, 0, dx), z = this.sweepAxis(position, 2, dz);
    return [x, z];
  }

  resolveMovement(position, dx, dy, dz) {
    const bounds = aabbAt(position, HALF_WIDTH, this.height), shapes = this.collisionShapes(expandAabb(bounds, [dx, dy, dz]));
    if (shapes) {
      const result = clipShapeMovement(bounds, shapes, [dx, dy, dz]);
      const destination = position.map((value, axis) => value + result[axis]);
      if (!this.collides(destination) || shapes.some(shape => intersectsAabb(aabbAt(destination, HALF_WIDTH, this.height), shape, EPSILON))) { position.splice(0, 3, ...destination); return result; }
    }
    const y = this.sweepAxis(position, 1, dy), [x, z] = this.moveHorizontal(position, dx, dz);
    return [x, y, z];
  }

  stayOnEdge(dx, dz) {
    const supported = (x, z) => this.supportedAt([this.position[0] + x, this.position[1], this.position[2] + z], STEP_HEIGHT);
    const smaller = value => Math.abs(value) <= 0.05 ? 0 : value - Math.sign(value) * 0.05;
    while (dx && !supported(dx, 0)) dx = smaller(dx);
    while (dz && !supported(0, dz)) dz = smaller(dz);
    while ((dx || dz) && !supported(dx, dz)) { dx = smaller(dx); dz = smaller(dz); }
    return [dx, dz];
  }

  move(dx, dy, dz, { external = false } = {}) {
    if (this.noclip) {
      this.position[0] += dx; this.position[1] += dy; this.position[2] += dz;
      this.grounded = false;
      return;
    }
    if (this.stuckSpeedMultiplier) {
      [dx, dy, dz] = [dx, dy, dz].map((value, axis) => value * this.stuckSpeedMultiplier[axis]);
      this.velocity.fill(0); this.stuckSpeedMultiplier = null;
    }
    if (!external && this.sneaking && this.grounded && !this.fly) [dx, dz] = this.stayOnEdge(dx, dz);
    const initial = [...this.position];
    const direct = [...initial];
    let [movedX, movedY, movedZ] = this.resolveMovement(direct, dx, dy, dz);
    const blockedHorizontally = Math.abs(dx - movedX) > EPSILON || Math.abs(dz - movedZ) > EPSILON;
    const hitFloor = dy < 0 && Math.abs(dy - movedY) > EPSILON;
    if (blockedHorizontally && (this.grounded || hitFloor) && !this.fly) {
      let stepped = [...initial];
      let [stepX, up, stepZ] = this.resolveMovement(stepped, dx, STEP_HEIGHT, dz);
      // Entity.collide compares a second step candidate whose vertical sweep
      // includes the requested horizontal area. This handles low ceilings over
      // a stair without the old sweep's avoidable corner snag.
      const wide = expandAabb(aabbAt(initial, HALF_WIDTH, this.height), [dx, 0, dz]);
      const wideShapes = this.collisionShapes(expandAabb(wide, [0, STEP_HEIGHT, 0]));
      if (wideShapes) {
        const wideUp = clipShapeAxis(wide, wideShapes, 1, STEP_HEIGHT);
        if (wideUp < STEP_HEIGHT) {
          const alternative = [initial[0], initial[1] + wideUp, initial[2]];
          const [alternativeX, , alternativeZ] = this.resolveMovement(alternative, dx, 0, dz);
          if (alternativeX * alternativeX + alternativeZ * alternativeZ > stepX * stepX + stepZ * stepZ) { stepped = alternative; stepX = alternativeX; stepZ = alternativeZ; up = wideUp; }
        }
      }
      if (stepX * stepX + stepZ * stepZ > movedX * movedX + movedZ * movedZ) {
        this.sweepAxis(stepped, 1, dy - up);
        movedY = stepped[1] - initial[1]; movedX = stepX; movedZ = stepZ;
        direct.splice(0, 3, ...stepped);
      }
    }
    this.position = direct;
    this.horizontalCollision = Math.abs(dx - movedX) > EPSILON || Math.abs(dz - movedZ) > EPSILON;
    if (Math.abs(dx - movedX) > EPSILON) this.velocity[0] = 0;
    if (Math.abs(dz - movedZ) > EPSILON) this.velocity[2] = 0;
    if (Math.abs(dy - movedY) > EPSILON) {
      const landing = blockName(this.materialAt(this.position, 0.200001));
      this.velocity[1] = dy < 0 && !this.sneaking && landing === 'slime_block' ? -this.velocity[1] :
        dy < 0 && !this.sneaking && landing.endsWith('_bed') ? -this.velocity[1] * 0.66 : 0;
    }
    this.grounded = !this.fly && this.supportedAt();
    this.updateSupportingBlock(this.grounded, [movedX, movedY, movedZ]);
    if (this.grounded) this.fallDistance = 0;
    else if (movedY < 0) this.fallDistance -= movedY;
    const landing = blockName(this.materialAt(this.position, 0.200001)), vertical = Math.abs(this.velocity[1] * TICK);
    if (this.grounded && landing === 'slime_block' && vertical < 0.1 && !this.sneaking) { const factor = 0.4 + vertical * 0.2; this.velocity[0] *= factor; this.velocity[2] *= factor; }
    this.applyInsideBlocks();
  }

  updatePose(crouch) {
    const preferred = this.swimming || this.fallFlying ? SWIMMING_HEIGHT : crouch && !this.fly ? CROUCH_HEIGHT : STANDING_HEIGHT;
    if (!this.collides(this.position, preferred)) this.height = preferred;
    else if (!this.collides(this.position, CROUCH_HEIGHT)) this.height = CROUCH_HEIGHT;
    else if (!this.collides(this.position, SWIMMING_HEIGHT)) this.height = SWIMMING_HEIGHT;
    this.pose = this.fallFlying ? 'fall_flying' : this.height === SWIMMING_HEIGHT ? this.swimming ? 'swimming' : 'crawling' : this.height === CROUCH_HEIGHT ? 'crouching' : 'standing';
    this.sneaking = !this.fly && !this.fallFlying && (crouch || this.height < STANDING_HEIGHT && !this.swimming);
  }

  applyHoneySlide(x, y, z) {
    if (this.fly || this.noclip || this.grounded || this.velocity[1] >= -1.6) return;
    const [px, py, pz] = this.position;
    if (py > y + 0.9375 - 1e-7 || Math.abs(x + 0.5 - px) + 1e-7 <= 0.4375 + HALF_WIDTH && Math.abs(z + 0.5 - pz) + 1e-7 <= 0.4375 + HALF_WIDTH) return;
    if (this.velocity[1] < -2.6) { const ratio = -1 / this.velocity[1]; this.velocity[0] *= ratio; this.velocity[2] *= ratio; }
    this.velocity[1] = -1; this.fallDistance = 0;
  }

  applyInsideBlocks() {
    const [px, py, pz] = this.position; this.inPowderSnow = false;
    for (let x = Math.floor(px - HALF_WIDTH + 1e-5); x <= Math.floor(px + HALF_WIDTH - 1e-5); x++) {
      for (let y = Math.floor(py + 1e-5); y <= Math.floor(py + this.height - 1e-5); y++) {
        for (let z = Math.floor(pz - HALF_WIDTH + 1e-5); z <= Math.floor(pz + HALF_WIDTH - 1e-5); z++) {
          const material = this.sample(x, y, z).material, name = blockName(material);
          if (name === 'cobweb') this.stuckSpeedMultiplier = [0.25, Math.fround(0.05), 0.25];
          else if (name === 'sweet_berry_bush') this.stuckSpeedMultiplier = [Math.fround(0.8), 0.75, Math.fround(0.8)];
          else if (name === 'powder_snow') {
            this.inPowderSnow = true;
            if (blockName(this.materialAt()) === 'powder_snow') this.stuckSpeedMultiplier = [Math.fround(0.9), 1.5, Math.fround(0.9)];
          } else if (name === 'honey_block') this.applyHoneySlide(x, y, z);
          else if (name === 'bubble_column') {
            const down = material.properties?.drag === 'true' || material.properties?.drag_down === 'true';
            const surface = blockName(this.sample(x, y + 1, z).material) === 'air';
            const v = this.velocity[1] * TICK;
            this.velocity[1] = (down ? Math.max(surface ? -0.9 : -0.3, v - 0.03) : Math.min(surface ? 1.8 : 0.7, v + (surface ? 0.1 : 0.06))) / TICK;
            if (!surface) this.fallDistance = 0;
          }
        }
      }
    }
  }

  travelFallFlying() {
    if (this.velocity[1] > -10) this.fallDistance = 1;
    const gravity = this.velocity[1] <= 0 && this.effectLevel('slow_falling') ? 0.01 : 0.08;
    if (this.fireworkBoosting) this.applyFireworkBoost();
    this.velocity = elytraVelocity(this.velocity.map(value => value * TICK), this.direction, this.pitch, gravity).map(value => value / TICK);
    this.move(...this.velocity.map(value => value * TICK));
    this.fallFlyTicks++;
    if (this.grounded) this.setFallFlying(false);
  }

  finishTick(keys) {
    this.wasJumpHeld = keys.has('Space');
    for (const effect of this.effects.values()) if (effect.duration > 0) effect.duration--;
    this.sampleCache = null;
  }

  tick(keys) {
    this.motionTime = (this.motionTime ?? 0) + 1;
    if (!this.position.every(Number.isFinite)) return;
    if (this.sleeping) {
      if (keys.has('Space') || keys.has('ShiftLeft') || keys.has('ShiftRight')) this.requestWake();
      this.velocity.fill(0); this.finishTick(keys); return;
    }
    if (this.vehicle) { this.sampleCache = new Map(); this.vehicle.tick(keys); this.finishTick(keys); return; }
    this.waitingForTerrain = !this.loadedAt();
    if (this.waitingForTerrain && !this.noclip) {
      this.velocity.fill(0); this.grounded = false;
      return;
    }
    this.sampleCache = new Map();
    const crouch = keys.has('ShiftLeft') || keys.has('ShiftRight');
    this.scaffoldDescending = crouch;
    const contact = this.fluidContact(this.position, this.height, true);
    this.fluid = !this.fly && !this.noclip ? contact.kind : null;
    this.fluidHeight = contact.depth;
    this.submerged = this.fluid !== null;
    this.eyesInWater = contact.eyesInWater;
    this.updatePose(crouch);
    this.grounded = !this.fly && !this.noclip && this.supportedAt();
    this.updateSupportingBlock(this.grounded);
    const climbable = this.climbableAt();
    this.climbing = Boolean(climbable);
    if (keys.has('Space') && !this.wasJumpHeld) this.startFallFlying();
    let forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    let strafe = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    this.sprinting = this.canSprint && !this.fallFlying && !this.effectLevel('blindness') && (!this.sneaking || this.eyesInWater) && forward > 0 &&
      (this.fluid !== 'water' || this.eyesInWater) && (keys.has('ControlLeft') || keys.has('ControlRight'));
    this.swimming = !this.fly && !this.noclip && this.fluid === 'water' && this.sprinting &&
      (this.swimming || this.eyesInWater && this.sample(...this.position.map(Math.floor)).fluid.kind === 'water');
    this.updatePose(crouch);
    const length = Math.max(1, Math.hypot(forward, strafe));
    const inputScale = 0.98 * (this.sneaking ? 0.3 : 1) * Math.max(0, Math.min(1, this.inputMultiplier));
    forward = forward / length * inputScale; strafe = strafe / length * inputScale;
    for (let axis = 0; axis < 3; axis++) if (Math.abs(this.velocity[axis]) < 0.06) this.velocity[axis] = 0;
    if (this.fallFlying && !this.submerged && !this.fly && !this.noclip) {
      this.travelFallFlying(); this.finishTick(keys); return;
    }
    if (this.jumpDelay > 0) this.jumpDelay--;
    const flyingSpeed = Number.isFinite(this.flyingSpeed) ? Math.max(0, Math.min(1, this.flyingSpeed)) : 0.05;
    if (this.fly || this.noclip) {
      const ascent = Number(keys.has('Space')) - Number(crouch);
      this.velocity[1] += ascent * flyingSpeed * 3 / TICK;
    } else if (this.submerged && (!this.grounded || this.fluidHeight > 0.4)) {
      if (keys.has('Space')) this.velocity[1] += 0.8;
      if (crouch) this.velocity[1] -= 0.8;
    } else if (keys.has('Space') && this.grounded && !this.jumpDelay) {
      const hereFactor = blockJumpFactor(this.materialAt()), jumpFactor = hereFactor === 1 ? blockJumpFactor(this.materialAt(this.position, 0.500001)) : hereFactor;
      this.velocity[1] = (0.42 * jumpFactor + this.effectLevel('jump_boost') * 0.1) / TICK;
      if (this.sprinting) { this.velocity[0] += Math.sin(this.yaw) * 4; this.velocity[2] -= Math.cos(this.yaw) * 4; }
      this.jumpDelay = 10;
    } else if (!keys.has('Space')) this.jumpDelay = 0;
    const groundedAtStart = this.grounded;
    const flyingAtStart = this.fly || this.noclip;
    const support = this.materialAt(this.position, 0.500001), friction = blockFriction(support);
    let acceleration = groundedAtStart ? 0.1 * (this.sprinting ? 1.3 : 1) : (this.sprinting ? 0.026 : 0.02);
    if (groundedAtStart) acceleration *= 0.216 / (friction ** 3);
    const movementMultiplier = Number.isFinite(this.movementMultiplier) ? Math.max(0, Math.min(16, this.movementMultiplier)) : 1;
    acceleration *= movementMultiplier;
    let waterDrag = this.sprinting ? 0.9 : 0.8;
    if (this.submerged) {
      acceleration = 0.02;
      if (this.fluid === 'water') {
        let depth = Math.min(3, this.equipment.depthStrider);
        if (!groundedAtStart) depth *= 0.5;
        if (depth) { waterDrag += (0.546 - waterDrag) * depth / 3; acceleration += (0.1 * movementMultiplier - acceleration) * depth / 3; }
        if (this.effectLevel('dolphins_grace')) waterDrag = 0.96;
        if (this.swimming) {
          const lookY = Math.sin(this.pitch), surface = this.sample(Math.floor(this.position[0]), Math.floor(this.position[1] + 0.9), Math.floor(this.position[2])).fluid;
          if (lookY <= 0 || keys.has('Space') || surface.kind) this.velocity[1] += (lookY / TICK - this.velocity[1]) * (lookY < -0.2 ? 0.085 : 0.06);
        }
      }
    }
    if (this.fly || this.noclip) acceleration = flyingSpeed * (this.sprinting ? 2 : 1);
    this.velocity[0] += (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * strafe) * acceleration / TICK;
    this.velocity[2] += (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * strafe) * acceleration / TICK;
    if (climbable && !this.submerged) {
      this.velocity[0] = Math.max(-3, Math.min(3, this.velocity[0])); this.velocity[2] = Math.max(-3, Math.min(3, this.velocity[2]));
      this.velocity[1] = Math.max(-3, this.velocity[1]);
      if (crouch && blockName(climbable) !== 'scaffolding' && this.velocity[1] < 0) this.velocity[1] = 0;
      this.fallDistance = 0;
    }
    const oldY = this.position[1], falling = this.velocity[1] <= 0;
    const gravity = falling && this.effectLevel('slow_falling') ? 0.01 : 0.08;
    this.move(this.velocity[0] * TICK, this.velocity[1] * TICK, this.velocity[2] * TICK);
    if ((this.climbableAt() || this.inPowderSnow && this.equipment.leatherBoots) && (this.horizontalCollision || !this.submerged && keys.has('Space'))) this.velocity[1] = 4;
    const here = this.materialAt(), hereSpeed = blockSpeedFactor(here);
    let speedFactor = this.fly || this.noclip ? 1 : this.fluid === 'water' || hereSpeed !== 1 ? hereSpeed : blockSpeedFactor(this.materialAt(this.position, 0.500001));
    if (blockName(support) === 'soul_sand' && this.equipment.soulSpeed) speedFactor = 1;
    this.velocity[0] *= speedFactor; this.velocity[2] *= speedFactor;
    if (flyingAtStart) {
      this.velocity[0] *= 0.91; this.velocity[2] *= 0.91; this.velocity[1] *= 0.6;
    } else if (this.submerged) {
      const drag = this.fluid === 'water' ? waterDrag : 0.5;
      this.velocity[0] *= drag; this.velocity[2] *= drag;
      if (this.fluid === 'water') this.velocity[1] = fallingFluidVelocity(this.velocity[1] * TICK * 0.8, gravity, falling, this.sprinting) / TICK;
      else {
        this.velocity[1] *= this.fluidHeight <= 0.4 ? 0.8 : 0.5;
        if (this.fluidHeight <= 0.4) this.velocity[1] = fallingFluidVelocity(this.velocity[1] * TICK, gravity, falling, this.sprinting) / TICK;
        this.velocity[1] -= gravity / (4 * TICK);
      }
      if (this.horizontalCollision) {
        const probe = [this.position[0] + this.velocity[0] * TICK, oldY + this.velocity[1] * TICK + STEP_HEIGHT, this.position[2] + this.velocity[2] * TICK];
        if (!this.collides(probe) && !this.fluidContact(probe).kind) this.velocity[1] = 6;
      }
      this.fallDistance = 0;
    } else {
      const levitation = this.effectLevel('levitation');
      if (levitation) { this.velocity[1] += (levitation - this.velocity[1]) * 0.2; this.fallDistance = 0; }
      else this.velocity[1] -= gravity / TICK;
      this.velocity[1] *= 0.98;
      const drag = groundedAtStart ? friction * 0.91 : 0.91;
      this.velocity[0] *= drag; this.velocity[2] *= drag;
    }
    if (this.fly && !this.noclip && this.supportedAt() && this.velocity[1] <= 0) {
      this.fly = false; this.grounded = true; this.onFlyingChange?.(false);
    }
    this.finishTick(keys);
  }

  step(dt, keys = EMPTY_KEYS) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // A suspended tab should not simulate minutes of stale input on resume.
    this.accumulator += Math.min(dt, 0.25);
    while (this.accumulator + 1e-9 >= TICK) {
      this.previousPosition = [...this.position];
      this.tick(keys);
      this.simulatedPosition = this.position;
      this.accumulator = Math.max(0, this.accumulator - TICK);
    }
  }

  update(dt, keys = EMPTY_KEYS) { this.step(dt, keys); }

  target() {
    if (!this.core.ray_cast(...this.eye, ...this.direction, 7)) return null;
    return Array.from(new Int32Array(this.core.memory.buffer, this.core.ray_hit_ptr(), 7));
  }
}
