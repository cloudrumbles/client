const TICK = 1 / 20;
const HALF_WIDTH = 0.3;
const STANDING_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.5;
const STEP_HEIGHT = 0.6;
const FLUID = 4;
const EPSILON = 0.0003;
const EMPTY_KEYS = new Set();

/** Fixed 20 Hz Minecraft-style locomotion. Velocity is expressed in metres/second. */
export class Player {
  constructor(core) {
    this.core = core;
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
  get eye() { const p = this.renderPosition; return [p[0], p[1] + (this.height < STANDING_HEIGHT ? 1.27 : 1.62), p[2]]; }
  get direction() { const c = Math.cos(this.pitch); return [Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c]; }

  setPosition(position, { yaw, pitch, resetVelocity = true } = {}) {
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return false;
    this.position = [...position];
    this.previousPosition = [...position];
    this.simulatedPosition = null;
    if (Number.isFinite(yaw)) this.yaw = yaw;
    if (Number.isFinite(pitch)) this.pitch = Math.max(-1.52, Math.min(1.52, pitch));
    if (resetVelocity) { this.velocity.fill(0); this.accumulator = 0; this.jumpDelay = 0; }
    this.grounded = false;
    this.waitingForTerrain = !this.loadedAt();
    return true;
  }

  look(dx, dy) { this.yaw += dx * 0.002; this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch - dy * 0.002)); }

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
    return Boolean(this.core.collides_aabb(p[0] - HALF_WIDTH, p[1], p[2] - HALF_WIDTH,
      p[0] + HALF_WIDTH, p[1] + height, p[2] + HALF_WIDTH));
  }

  intersectsBlock(x, y, z) {
    const [px, py, pz] = this.position;
    return x < px + HALF_WIDTH && x + 1 > px - HALF_WIDTH && y < py + this.height && y + 1 > py && z < pz + HALF_WIDTH && z + 1 > pz - HALF_WIDTH;
  }

  supportedAt(p = this.position, distance = 0.003) {
    return Boolean(this.core.collides_aabb(p[0] - HALF_WIDTH, p[1] - distance, p[2] - HALF_WIDTH,
      p[0] + HALF_WIDTH, p[1], p[2] + HALF_WIDTH));
  }

  fluidAt() {
    if (!this.core.block_flags) return false;
    const [x, y, z] = this.position;
    for (const sx of [x - HALF_WIDTH + EPSILON, x + HALF_WIDTH - EPSILON]) {
      for (const sz of [z - HALF_WIDTH + EPSILON, z + HALF_WIDTH - EPSILON]) {
        for (const sy of [y + 0.05, y + Math.min(0.7, this.height)]) {
          const state = this.core.block_get(Math.floor(sx), Math.floor(sy), Math.floor(sz));
          if (this.core.block_flags(state) & FLUID) return true;
        }
      }
    }
    return false;
  }

  // Small conservative sweeps prevent tunnelling through thin imported collision
  // shapes; a binary search then resolves their exact surface, including slabs.
  sweepAxis(position, axis, displacement) {
    if (Math.abs(displacement) < 1e-10) return 0;
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

  stayOnEdge(dx, dz) {
    const supported = (x, z) => this.supportedAt([this.position[0] + x, this.position[1], this.position[2] + z], STEP_HEIGHT);
    const smaller = value => Math.abs(value) <= 0.05 ? 0 : value - Math.sign(value) * 0.05;
    while (dx && !supported(dx, 0)) dx = smaller(dx);
    while (dz && !supported(0, dz)) dz = smaller(dz);
    while ((dx || dz) && !supported(dx, dz)) { dx = smaller(dx); dz = smaller(dz); }
    return [dx, dz];
  }

  move(dx, dy, dz) {
    if (this.noclip) {
      this.position[0] += dx; this.position[1] += dy; this.position[2] += dz;
      this.grounded = false;
      return;
    }
    if (this.sneaking && this.grounded && !this.fly) [dx, dz] = this.stayOnEdge(dx, dz);
    const initial = [...this.position];
    const direct = [...initial];
    let movedY = this.sweepAxis(direct, 1, dy);
    let [movedX, movedZ] = this.moveHorizontal(direct, dx, dz);
    const blockedHorizontally = Math.abs(dx - movedX) > EPSILON || Math.abs(dz - movedZ) > EPSILON;
    const hitFloor = dy < 0 && Math.abs(dy - movedY) > EPSILON;
    if (blockedHorizontally && (this.grounded || hitFloor) && !this.fly) {
      const stepped = [...initial];
      const up = this.sweepAxis(stepped, 1, STEP_HEIGHT);
      const [stepX, stepZ] = this.moveHorizontal(stepped, dx, dz);
      if (up > EPSILON && stepX * stepX + stepZ * stepZ > movedX * movedX + movedZ * movedZ + EPSILON * EPSILON) {
        this.sweepAxis(stepped, 1, dy - up);
        movedY = stepped[1] - initial[1]; movedX = stepX; movedZ = stepZ;
        direct.splice(0, 3, ...stepped);
      }
    }
    this.position = direct;
    if (Math.abs(dx - movedX) > EPSILON) this.velocity[0] = 0;
    if (Math.abs(dz - movedZ) > EPSILON) this.velocity[2] = 0;
    if (Math.abs(dy - movedY) > EPSILON) this.velocity[1] = 0;
    this.grounded = !this.fly && this.supportedAt();
  }

  tick(keys) {
    if (!this.position.every(Number.isFinite)) return;
    this.waitingForTerrain = !this.loadedAt();
    if (this.waitingForTerrain && !this.noclip) {
      this.velocity.fill(0); this.grounded = false;
      return;
    }
    const crouch = keys.has('ShiftLeft') || keys.has('ShiftRight');
    this.sneaking = crouch && !this.fly;
    if (this.sneaking) this.height = CROUCH_HEIGHT;
    else if (!this.collides(this.position, STANDING_HEIGHT)) this.height = STANDING_HEIGHT;
    else { this.height = CROUCH_HEIGHT; this.sneaking = true; }
    this.grounded = !this.fly && !this.noclip && this.supportedAt();
    this.submerged = !this.fly && !this.noclip && this.fluidAt();
    let forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    let strafe = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    this.sprinting = this.canSprint && !this.sneaking && forward > 0 && (keys.has('ControlLeft') || keys.has('ControlRight'));
    const length = Math.max(1, Math.hypot(forward, strafe));
    const inputScale = 0.98 * (this.sneaking ? 0.3 : 1);
    forward = forward / length * inputScale; strafe = strafe / length * inputScale;
    for (let axis = 0; axis < 3; axis++) if (Math.abs(this.velocity[axis]) < 0.06) this.velocity[axis] = 0;
    if (this.jumpDelay > 0) this.jumpDelay--;
    const flyingSpeed = Number.isFinite(this.flyingSpeed) ? Math.max(0, Math.min(1, this.flyingSpeed)) : 0.05;
    if (this.fly || this.noclip) {
      const ascent = Number(keys.has('Space')) - Number(crouch);
      this.velocity[1] += ascent * flyingSpeed * 3 / TICK;
    } else if (this.submerged) {
      if (keys.has('Space')) this.velocity[1] += 0.8;
      if (crouch) this.velocity[1] -= 0.8;
    } else if (keys.has('Space') && this.grounded && !this.jumpDelay) {
      this.velocity[1] = 8.4;
      if (this.sprinting) { this.velocity[0] += Math.sin(this.yaw) * 4; this.velocity[2] -= Math.cos(this.yaw) * 4; }
      this.jumpDelay = 10;
    } else if (!keys.has('Space')) this.jumpDelay = 0;
    const groundedAtStart = this.grounded;
    let acceleration = groundedAtStart ? 0.1 * (this.sprinting ? 1.3 : 1) : (this.sprinting ? 0.026 : 0.02);
    const movementMultiplier = Number.isFinite(this.movementMultiplier) ? Math.max(0, Math.min(16, this.movementMultiplier)) : 1;
    acceleration *= movementMultiplier;
    if (this.submerged) acceleration = 0.02;
    if (this.fly || this.noclip) acceleration = flyingSpeed * (this.sprinting ? 2 : 1);
    this.velocity[0] += (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * strafe) * acceleration / TICK;
    this.velocity[2] += (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * strafe) * acceleration / TICK;
    this.move(this.velocity[0] * TICK, this.velocity[1] * TICK, this.velocity[2] * TICK);
    if (this.fly || this.noclip) {
      this.velocity[0] *= 0.91; this.velocity[2] *= 0.91; this.velocity[1] *= 0.6;
    } else if (this.submerged) {
      const drag = this.sprinting ? 0.9 : 0.8;
      this.velocity[0] *= drag; this.velocity[2] *= drag;
      this.velocity[1] = this.velocity[1] * 0.8 - 0.1;
    } else {
      this.velocity[1] = (this.velocity[1] - 1.6) * 0.98;
      const drag = groundedAtStart ? 0.546 : 0.91;
      this.velocity[0] *= drag; this.velocity[2] *= drag;
    }
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
