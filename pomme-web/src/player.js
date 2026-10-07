export class Player {
  constructor(core) {
    this.core = core;
    this.position = [64.5, core.terrain_height(64, 88) + 2, 88.5];
    this.yaw = 0; this.pitch = -0.12; this.verticalSpeed = 0; this.grounded = false;
    while (this.collides() && this.position[1] < core.world_height() + 1) this.position[1]++;
  }
  get eye() { return [this.position[0], this.position[1] + 1.62, this.position[2]]; }
  get direction() { const c = Math.cos(this.pitch); return [Math.sin(this.yaw) * c, Math.sin(this.pitch), -Math.cos(this.yaw) * c]; }
  look(dx, dy) { this.yaw += dx * 0.002; this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch - dy * 0.002)); }
  collides(p = this.position) { return Boolean(this.core.collides_aabb(p[0] - 0.3, p[1], p[2] - 0.3, p[0] + 0.3, p[1] + 1.8, p[2] + 0.3)); }
  intersectsBlock(x, y, z) {
    const [px, py, pz] = this.position;
    return x < px + 0.3 && x + 1 > px - 0.3 && y < py + 1.8 && y + 1 > py && z < pz + 0.3 && z + 1 > pz - 0.3;
  }
  step(dt, keys) {
    let forward = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
    let right = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
    const length = Math.hypot(forward, right) || 1;
    forward /= length; right /= length;
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 7 : 4.3;
    const dx = (Math.sin(this.yaw) * forward + Math.cos(this.yaw) * right) * speed * dt;
    const dz = (-Math.cos(this.yaw) * forward + Math.sin(this.yaw) * right) * speed * dt;
    if (keys.has('Space') && this.grounded) { this.verticalSpeed = 8; this.grounded = false; }
    const submerged = this.core.block_get(Math.floor(this.position[0]), Math.floor(this.position[1] + 0.7), Math.floor(this.position[2])) === 7;
    this.verticalSpeed = Math.max(submerged ? -3 : -35, this.verticalSpeed - (submerged ? 8 : 24) * dt);
    if (submerged && keys.has('Space')) this.verticalSpeed = 3.5;
    for (const [axis, displacement] of [[0, dx], [2, dz], [1, this.verticalSpeed * dt]]) {
      const before = this.position[axis];
      this.position[axis] += displacement;
      if (this.collides()) {
        this.position[axis] = before;
        if (axis === 1) { if (displacement < 0) this.grounded = true; this.verticalSpeed = 0; }
      } else if (axis === 1 && displacement < 0) this.grounded = false;
    }
    this.position[0] = Math.max(0.31, Math.min(this.core.world_width() - 0.31, this.position[0]));
    this.position[2] = Math.max(0.31, Math.min(this.core.world_depth() - 0.31, this.position[2]));
    if (this.position[1] < -16) { this.position[1] = this.core.terrain_height(Math.floor(this.position[0]), Math.floor(this.position[2])) + 2; this.verticalSpeed = 0; }
  }
  target() {
    if (!this.core.ray_cast(...this.eye, ...this.direction, 7)) return null;
    return Array.from(new Int32Array(this.core.memory.buffer, this.core.ray_hit_ptr(), 7));
  }
}
