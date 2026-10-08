const STRIDE = 14;
const EMPTY = new Float32Array(0);
const PARTICLE = 4194304, REACTIVE = 2097152, BLEND = 64, EMISSIVE = 8, LIGHT = 512;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const normalize = vector => { const length = Math.hypot(...vector) || 1; return vector.map(value => value / length); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const qualify = name => name.includes(':') ? name : `minecraft:${name}`;
const coordinateHash = (x, z) => { let value = Math.imul(x | 0, 3129871) ^ Math.imul(z | 0, 116129781); value = Math.imul(value, value) * 42317861 + value * 11; return (value % 1000000 + 1000000) % 1000000 / 1000000; };

export function precipitationFor(biome, y) {
  if (!biome || biome.has_precipitation === false || biome.hasPrecipitation === false || biome.downfall === 0 || biome.dimension && biome.dimension !== 'overworld') return 'none';
  const temperature = (biome.temperature ?? 0.8) - Math.max(0, y - 80) * 0.05 / 40;
  return temperature < 0.15 ? 'snow' : 'rain';
}

/** Native 20 Hz particle parameters in blocks per tick, never frames. */
export function particleProfile(name, data = {}, random = Math.random) {
  name = name.replace(/^minecraft:/, '');
  const profile = { lifetime: 20 + Math.floor(random() * 20), gravity: 0, friction: 0.96, size: 0.1 + random() * 0.06, color: [1, 1, 1], alpha: 1, collision: false, emissive: false, upward: 0, fade: true };
  if (['block', 'block_marker', 'falling_dust', 'dust_pillar', 'block_crumble', 'item', 'item_slime', 'item_snowball'].includes(name)) {
    Object.assign(profile, { lifetime: Math.floor(4 / (random() * 0.9 + 0.1)), gravity: name === 'block_marker' ? 0 : 1, friction: 0.98, collision: name !== 'block_marker', size: 0.05 + random() * 0.05, fade: false });
    if (name === 'block_marker') Object.assign(profile, { lifetime: 80, size: 0.5 });
  } else if (/smoke|cloud|poof|sneeze|spit|squid_ink|ash|spore|gust/.test(name)) {
    const shade = /white|cloud|poof|snow/.test(name) ? 0.9 : /ink/.test(name) ? 0.025 : 0.3 + random() * 0.3;
    Object.assign(profile, { color: [shade, shade, shade], size: /large|campfire|signal|cloud|gust/.test(name) ? 0.3 : 0.12, upward: /ink|ash/.test(name) ? 0 : 0.004, lifetime: /campfire/.test(name) ? 80 + Math.floor(random() * 80) : 8 + Math.floor(random() * 32), friction: 0.96, growth: 0.6 });
  } else if (/flame|lava|soul|firework|end_rod|glow|electric|wax|sculk/.test(name)) {
    Object.assign(profile, { emissive: true, lifetime: /end_rod/.test(name) ? 60 + Math.floor(random() * 12) : 12 + Math.floor(random() * 24), color: /soul|sculk/.test(name) ? [0.2, 0.85, 1] : /flame|lava/.test(name) ? [1, 0.8, 0.35] : [1, 1, 1], gravity: /lava/.test(name) ? 0.5 : 0, upward: /flame|soul/.test(name) ? 0.003 : 0, size: name === 'small_flame' ? 0.06 : 0.1 });
  } else if (/water|rain|splash|drip|honey|nectar|tear/.test(name)) {
    Object.assign(profile, { color: /lava/.test(name) ? [1, 0.45, 0.08] : /honey|nectar/.test(name) ? [1, 0.67, 0.1] : /tear/.test(name) ? [0.6, 0.15, 0.9] : [0.4, 0.65, 1], gravity: /landing/.test(name) ? 0 : /dripping/.test(name) ? 0.06 : 1, collision: true, lifetime: /dripping/.test(name) ? 40 : 12 + Math.floor(random() * 20), size: 0.05, friction: 0.98 });
  } else if (/bubble|underwater|fishing|dolphin|nautilus/.test(name)) {
    Object.assign(profile, { color: [0.7, 0.85, 1], upward: 0.004, lifetime: 8 + Math.floor(random() * 32), size: 0.06, friction: 0.85 });
  } else if (name === 'dust' || name === 'dust_color_transition') {
    const transition = name === 'dust_color_transition';
    Object.assign(profile, { lifetime: Math.floor((8 / (random() * 0.8 + 0.2)) * clamp(data.scale ?? 1, 0.01, 4)), size: 0.1 * clamp(data.scale ?? 1, 0.01, 4), color: transition ? [data.fromRed, data.fromGreen, data.fromBlue] : [data.red, data.green, data.blue], colorTo: transition ? [data.toRed, data.toGreen, data.toBlue] : null, friction: 0.96 });
  } else if (/crit|damage|sweep/.test(name)) {
    Object.assign(profile, { lifetime: 6 + Math.floor(random() * 6), color: name === 'enchanted_hit' ? [0.4, 0.95, 0.6] : [0.7, 0.55, 0.35], gravity: 0.5, friction: 0.7, size: name === 'sweep_attack' ? 0.65 : 0.08 });
  } else if (/portal|dragon|witch|effect|enchant/.test(name)) {
    Object.assign(profile, { lifetime: 20 + Math.floor(random() * 40), color: /witch|portal|dragon/.test(name) ? [0.7, 0.2, 0.9] : [0.85, 0.8, 1], emissive: /portal|enchant/.test(name), upward: /effect/.test(name) ? 0.004 : 0 });
  } else if (/explosion|flash|sonic|elder_guardian/.test(name)) {
    Object.assign(profile, { lifetime: name === 'flash' ? 4 : 6 + Math.floor(random() * 4), color: [1, 1, 1], emissive: name === 'flash', size: /sonic/.test(name) ? 1.5 : 0.8, friction: 0, growth: 1 });
  } else if (name === 'heart' || name === 'angry_villager') {
    Object.assign(profile, { lifetime: 16, size: 0.15, color: name === 'heart' ? [1, 0.15, 0.25] : [1, 1, 1], upward: 0.006, fade: false });
  } else if (/happy_villager|composter|totem/.test(name)) profile.color = [0.4, 0.85, 0.2];
  else if (name === 'note') { const phase = data.note ?? 0; profile.color = [Math.sin(phase * Math.PI * 2) * 0.65 + 0.35, Math.sin((phase + 1 / 3) * Math.PI * 2) * 0.65 + 0.35, Math.sin((phase + 2 / 3) * Math.PI * 2) * 0.65 + 0.35]; profile.lifetime = 6; profile.upward = 0.01; }
  else if (name === 'snowflake') Object.assign(profile, { gravity: 0.04, lifetime: 80 + Math.floor(random() * 40), friction: 0.98, size: 0.06 });
  if (name === 'end_rod') Object.assign(profile, { gravity: 0.0125, friction: 0.91, size: 0.1 * (random() * 0.5 + 0.5) * 2 * 0.75, upward: 0, fade: false });
  profile.color = profile.color.map(value => clamp(Number.isFinite(value) ? value : 1, 0, 1));
  if (profile.colorTo) profile.colorTo = profile.colorTo.map(value => clamp(Number.isFinite(value) ? value : 1, 0, 1));
  return profile;
}

class QuadWriter {
  constructor(maxQuads) { this.vertices = new Float32Array(maxQuads * 6 * STRIDE); this.reset([0, 0, 0]); }
  reset(origin) { this.length = 0; this.origin = origin; this.min = [Infinity, Infinity, Infinity]; this.max = [-Infinity, -Infinity, -Infinity]; }
  quad(points, normal, color, alpha, tile, uv, flags) {
    if (this.length + 6 * STRIDE > this.vertices.length) return;
    const corners = [0, 1, 2, 0, 2, 3];
    for (const corner of corners) {
      const vertex = this.length, point = points[corner];
      for (let axis = 0; axis < 3; axis++) {
        this.vertices[vertex + axis] = point[axis] - this.origin[axis]; this.vertices[vertex + 3 + axis] = normal[axis]; this.vertices[vertex + 6 + axis] = color[axis];
        this.min[axis] = Math.min(this.min[axis], point[axis]); this.max[axis] = Math.max(this.max[axis], point[axis]);
      }
      this.vertices[vertex + 9] = alpha; this.vertices[vertex + 10] = uv[corner][0]; this.vertices[vertex + 11] = uv[corner][1]; this.vertices[vertex + 12] = tile; this.vertices[vertex + 13] = flags;
      this.length += STRIDE;
    }
  }
  upload(renderer, name) {
    if (!this.length) { renderer.removeMesh(name); return false; }
    renderer.uploadDynamicMesh(name, this.vertices.subarray(0, this.length), EMPTY, { min: this.min, max: this.max }, { stride: STRIDE, origin: this.origin }); return true;
  }
}

/** Server-driven particles and world/biome-driven precipitation, with fixed caps. */
export class MinecraftEffects {
  constructor({ renderer, registry = {}, materials, atlas, collides = () => false, isAir, getHeight = () => -Infinity, getBiome = () => null, getLight = () => ({ sky: 15, block: 0 }), random = Math.random, maxParticles = 2048, maxPacketParticles = 512, weatherRadius = 10 } = {}) {
    this.renderer = renderer; this.registry = registry; this.materials = materials; this.atlas = atlas; this.collides = collides; this.getHeight = getHeight; this.getBiome = getBiome; this.getLight = getLight; this.random = random;
    this.maxParticles = clamp(Math.floor(maxParticles), 1, 8192); this.maxPacketParticles = clamp(Math.floor(maxPacketParticles), 1, this.maxParticles); this.weatherRadius = clamp(Math.floor(weatherRadius), 1, 10);
    this.particles = []; this.accumulator = 0; this.time = 0; this.uploadAt = -Infinity; this.eye = [0, 0, 0];
    this.explosions = []; this.isAir = isAir || ((x, y, z) => !collides([x, y, z], [x + 1, y + 1, z + 1]));
    this.isRaining = false; this.rainLevel = 0; this.thunderLevel = 0; this.lightningTicks = 0;
    this.writer = new QuadWriter(this.maxParticles); this.weatherWriter = new QuadWriter((this.weatherRadius * 2 + 1) ** 2);
    this.counts = { spawned: 0, expired: 0, dropped: 0, packets: 0, unknownParticles: 0, uploads: 0, rendered: 0, rainColumns: 0, snowColumns: 0 }; this.closed = false;
    this.names = new Map((registry.particles ?? registry.particlesArray ?? []).map(particle => [particle.id, particle.name]));
  }
  setAssets({ materials = this.materials, atlas = this.atlas } = {}) { this.materials = materials; this.atlas = atlas; }
  gaussian() { return Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, this.random()))) * Math.cos(2 * Math.PI * this.random()); }
  event(event) {
    if (this.closed) return;
    if (event.type === 'particles') return this.spawnPacket(event.data ?? event);
    if (event.type === 'explosion-block-effects') {
      const entries = (event.blockParticles || []).filter(entry => Number.isInteger(entry.weight) && entry.weight > 0);
      if (entries.length && Number.isInteger(event.blockCount) && event.blockCount > 0 && Number.isFinite(event.radius) && event.radius > 0 && Object.values(event.center || {}).every(Number.isFinite)) this.explosions.push({ ...event, blockParticles: entries });
      return;
    }
    if (event.type === 'weather') {
      const reason = typeof event.reason === 'number' ? { 1: 'start_raining', 2: 'stop_raining', 7: 'rain_level_change', 8: 'thunder_level_change' }[event.reason] : event.reason;
      if (reason === 'start_raining') { this.isRaining = true; this.rainLevel = 0; }
      else if (reason === 'stop_raining') { this.isRaining = false; this.rainLevel = 1; }
      else if (reason === 'rain_level_change' && Number.isFinite(event.value)) { this.rainLevel = clamp(event.value, 0, 1); this.isRaining = this.rainLevel > 0; }
      else if (reason === 'thunder_level_change' && Number.isFinite(event.value)) this.thunderLevel = clamp(event.value, 0, 1);
    } else if (event.type === 'lightning') this.lightningTicks = 2;
    else if (event.type === 'world-event') {
      const packet = event.data ?? event;
      if (packet.effectId === 2001) {
        const location = packet.location, material = this.materials?.get?.(packet.data);
        if (!location || material?.flags & 128) return;
        let boxes = material?.outlineBoxes ?? material?.collisionBoxes;
        if (!boxes?.length && material?.templateVertices?.length) {
          const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
          for (let vertex = 0; vertex < material.templateVertices.length; vertex += 14) for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], material.templateVertices[vertex + axis]); max[axis] = Math.max(max[axis], material.templateVertices[vertex + axis]); }
          boxes = [[...min, ...max]];
        }
        if (!boxes) boxes = [[0, 0, 0, 1, 1, 1]];
        for (const box of boxes) {
          const widths = [0, 1, 2].map(axis => Math.min(1, Math.max(0, box[axis + 3] - box[axis]))), counts = widths.map(width => Math.max(2, Math.ceil(width / 0.25)));
          if (widths.some(width => width <= 0)) continue;
          for (let x = 0; x < counts[0]; x++) for (let y = 0; y < counts[1]; y++) for (let z = 0; z < counts[2]; z++) {
            const relative = [(x + 0.5) / counts[0], (y + 0.5) / counts[1], (z + 0.5) / counts[2]];
            this.spawn('block', relative.map((value, axis) => [location.x, location.y, location.z][axis] + box[axis] + value * widths[axis]), relative.map(value => value - 0.5), { blockState: packet.data });
          }
        }
      } else if (packet.effectId === 2002 || packet.effectId === 2007) {
        const position = [packet.location.x + 0.5, packet.location.y + 0.5, packet.location.z + 0.5];
        const color = [packet.data >> 16 & 255, packet.data >> 8 & 255, packet.data & 255].map(value => value / 255);
        for (let index = 0; index < 100; index++) this.spawn('effect', position.map(value => value + this.gaussian() * 0.3), [this.gaussian() * 0.03, this.random() * 0.2, this.gaussian() * 0.03], { color });
      }
    }
  }
  spawnPacket(packet) {
    this.counts.packets++;
    const name = typeof packet.particleName === 'string' ? packet.particleName.replace(/^minecraft:/, '') : this.names.get(packet.particleId);
    if (!name) { this.counts.unknownParticles++; return 0; }
    const position = [packet.x, packet.y, packet.z], offsets = [packet.offsetX, packet.offsetY, packet.offsetZ];
    if (![...position, ...offsets, packet.particleData, packet.particles].every(Number.isFinite) || packet.particles < 0) return 0;
    if (Math.hypot(...position.map((coordinate, axis) => coordinate - this.eye[axis])) > (packet.longDistance ? 512 : 32)) { this.counts.dropped += Math.max(1, packet.particles); return 0; }
    const requested = packet.particles === 0 ? 1 : Math.floor(packet.particles), count = Math.min(requested, this.maxPacketParticles, this.maxParticles - this.particles.length);
    this.counts.dropped += requested - count;
    const data = { ...packet.data };
    if (name === 'note' && packet.particles === 0) data.note = offsets[0];
    for (let index = 0; index < count; index++) {
      const velocity = packet.particles === 0 ? offsets.map(value => value * packet.particleData) : offsets.map(() => this.gaussian() * packet.particleData);
      const at = packet.particles === 0 ? position : position.map((value, axis) => value + this.gaussian() * offsets[axis]);
      this.spawn(name, at, velocity, data);
    }
    return count;
  }
  spawn(name, position, velocity = [0, 0, 0], data = {}) {
    if (this.particles.length >= this.maxParticles || ![...position, ...velocity].every(Number.isFinite)) { this.counts.dropped++; return false; }
    const profile = particleProfile(name, data, this.random), material = this.materials?.get?.(data.blockState), frames = this.atlas?.particleFrames?.get?.(qualify(name));
    let tile = frames?.[0] ?? -1, uv = [0, 0, 1, 1];
    if (['block', 'block_marker', 'falling_dust', 'dust_pillar', 'block_crumble'].includes(name)) {
      tile = material?.particleTile ?? material?.faces?.up?.tile ?? material?.faces?.north?.tile ?? -1;
      if (material?.color) profile.color = [...material.color];
      if (name !== 'block_marker') { const u = this.random() * 0.75, v = this.random() * 0.75; uv = [u, v, u + 0.25, v + 0.25]; }
    } else if (name === 'item') {
      const item = this.registry.items?.find(value => value.id === data.item?.itemId);
      tile = item ? this.atlas?.itemTiles?.get?.(`minecraft:item/${item.name}`) ?? -1 : -1;
    } else if (name === 'item_slime' || name === 'item_snowball') tile = this.atlas?.itemTiles?.get?.(`minecraft:item/${name === 'item_slime' ? 'slime_ball' : 'snowball'}`) ?? -1;
    if (Array.isArray(data.color)) profile.color = [...data.color];
    if (Number.isFinite(data.alpha)) profile.alpha = clamp(data.alpha, 0, 1);
    const light = this.getLight(...position);
    const particle = { ...profile, name, position: [...position], previous: [...position], velocity: [...velocity], frames, tile, uv, age: 0, light: light ?? { sky: 15, block: 0 }, delay: Math.max(0, data.delayInTicksBeforeShown ?? 0), vibration: name === 'vibration' && data.positionType === 'minecraft:block' ? data.destination : null, vibrationTicks: data.ticks ?? 0 };
    if ((name === 'entity_effect' || name === 'ambient_entity_effect') && !Array.isArray(data.color)) { particle.color = velocity.map(value => clamp(value, 0, 1)); particle.velocity = [0, 0, 0]; if (name === 'ambient_entity_effect') particle.alpha = 0.15; }
    if (name === 'note') particle.velocity = [0, 0.2, 0];
    if (name === 'explosion_emitter') { particle.size = 0; particle.lifetime = 8; }
    this.particles.push(particle); this.counts.spawned++; return true;
  }
  step() {
    this.explosionTick();
    this.rainLevel = clamp(this.rainLevel + (this.isRaining ? 0.01 : -0.01), 0, 1);
    this.lightningTicks = Math.max(0, this.lightningTicks - 1);
    const alive = [];
    const spawned = [];
    for (const particle of this.particles) {
      if (particle.delay > 0) { particle.delay--; alive.push(particle); continue; }
      if (particle.age++ >= particle.lifetime) { this.counts.expired++; continue; }
      particle.previous = [...particle.position];
      if (particle.name === 'explosion_emitter') {
        for (let index = 0; index < 6; index++) spawned.push({ position: particle.position.map(value => value + (this.random() - this.random()) * 4), velocity: [0, 0, 0] });
        alive.push(particle); continue;
      }
      if (particle.vibration && particle.vibrationTicks > 0) {
        particle.position = particle.position.map((value, axis) => value + (([particle.vibration.x, particle.vibration.y, particle.vibration.z][axis] + 0.5) - value) / particle.vibrationTicks);
        particle.vibrationTicks--; alive.push(particle); continue;
      }
      particle.velocity[1] -= 0.04 * particle.gravity; particle.velocity[1] += particle.upward;
      for (const axis of [1, 0, 2]) {
        const trial = [...particle.position]; trial[axis] += particle.velocity[axis];
        const half = 0.1;
        if (particle.collision && this.collides([trial[0] - half, trial[1], trial[2] - half], [trial[0] + half, trial[1] + half * 2, trial[2] + half])) {
          if (axis === 1 && particle.velocity[axis] < 0) { particle.onGround = true; if (/water|rain|splash|falling_lava/.test(particle.name)) particle.age = particle.lifetime; }
          particle.velocity[axis] = 0;
        } else particle.position = trial;
      }
      particle.velocity = particle.velocity.map((value, axis) => value * particle.friction * (particle.onGround && axis !== 1 ? 0.7 : 1));
      if (particle.name === 'end_rod' && particle.age > particle.lifetime / 2) {
        particle.alpha = 1 - (particle.age - Math.floor(particle.lifetime / 2)) / particle.lifetime;
        particle.color = particle.color.map((value, axis) => value + ([242 / 255, 222 / 255, 201 / 255][axis] - value) * 0.2);
      }
      alive.push(particle);
    }
    this.particles = alive;
    for (const spawn of spawned) this.spawn('explosion', spawn.position, spawn.velocity);
  }
  // ClientExplosionTracker (1.21.11): the entire queued batch contributes
  // at most 512 weighted attempts, and is discarded after this native tick.
  explosionTick() {
    const batch = this.explosions; this.explosions = [];
    const total = batch.reduce((sum, explosion) => sum + explosion.blockCount, 0);
    const choose = (entries, sum, weight) => {
      let cursor = Math.floor(this.random() * sum);
      for (const entry of entries) { cursor -= weight(entry); if (cursor < 0) return entry; }
      return entries.at(-1);
    };
    for (let index = 0; index < Math.min(total, 512); index++) {
      const explosion = choose(batch, total, entry => entry.blockCount);
      const direction = normalize([this.random() * 2 - 1, this.random() * 2 - 1, this.random() * 2 - 1]);
      const radius = Math.cbrt(this.random()) * explosion.radius;
      const offset = direction.map(value => value * radius), center = [explosion.center.x, explosion.center.y, explosion.center.z];
      const sample = center.map((value, axis) => Math.floor(value + offset[axis]));
      if (!this.isAir(...sample)) continue;
      const speed = 0.5 / (radius / explosion.radius + 0.1) * this.random() * this.random() + 0.3;
      const entry = choose(explosion.blockParticles, explosion.blockParticles.reduce((sum, item) => sum + item.weight, 0), item => item.weight).data;
      const name = entry.particle?.type?.replace('minecraft:', '');
      if (name && Number.isFinite(entry.scaling) && Number.isFinite(entry.speed)) this.spawn(name, center.map((value, axis) => value + offset[axis] * entry.scaling), direction.map(value => value * speed * entry.speed), entry.particle.data || {});
    }
  }
  tick(dt, { eye = this.eye, direction = [0, 0, -1], up = [0, 1, 0], timeSeconds, hasSkylight = true } = {}) {
    if (this.closed || !Number.isFinite(dt) || dt < 0 || ![...eye, ...direction, ...up].every(Number.isFinite)) return;
    this.eye = [...eye]; this.time = Number.isFinite(timeSeconds) ? timeSeconds : this.time + dt;
    this.accumulator += Math.min(dt, 0.25);
    for (let steps = 0; this.accumulator >= 0.05 && steps < 5; steps++) { this.step(); this.accumulator -= 0.05; }
    if (this.time - this.uploadAt < 1 / 30) return;
    this.uploadAt = this.time;
    const origin = eye.map(value => Math.floor(value / 256) * 256), right = normalize(cross(direction, up)), billboardUp = normalize(cross(right, direction)), normal = normalize(direction).map(value => -value);
    this.writer.reset(origin);
    const visible = this.particles.filter(particle => !particle.delay && particle.size > 0 && Math.hypot(...particle.position.map((value, axis) => value - eye[axis])) < 128).sort((a, b) => {
      const distance = particle => particle.position.reduce((sum, value, axis) => sum + (value - eye[axis]) ** 2, 0);
      return distance(b) - distance(a);
    });
    for (const particle of visible) {
      const fraction = clamp(particle.age / particle.lifetime, 0, 1), size = particle.size * (1 + (particle.growth ?? 0) * fraction);
      const position = particle.position.map((value, axis) => particle.previous[axis] + (value - particle.previous[axis]) * clamp(this.accumulator / 0.05, 0, 1));
      const points = [[-1, -1], [-1, 1], [1, 1], [1, -1]].map(([x, y]) => position.map((value, axis) => value + right[axis] * x * size + billboardUp[axis] * y * size));
      const color = particle.colorTo ? particle.color.map((value, axis) => value + (particle.colorTo[axis] - value) * fraction) : particle.color;
      const alpha = particle.alpha * (particle.fade ? clamp((1 - fraction) * 2, 0, 1) : 1);
      const tile = particle.frames?.[Math.min(particle.frames.length - 1, Math.floor(fraction * (particle.name === 'end_rod' ? particle.frames.length - 1 : particle.frames.length)))] ?? particle.tile;
      const [u0, v0, u1, v1] = particle.uv;
      const light = LIGHT | (clamp(particle.light.sky ?? 15, 0, 15) << 10) | (clamp(particle.light.block ?? 0, 0, 15) << 14);
      this.writer.quad(points, normal, color, alpha, tile, [[u0, v1], [u0, v0], [u1, v0], [u1, v1]], BLEND | PARTICLE | REACTIVE | light | (particle.emissive ? EMISSIVE : 0));
    }
    if (this.renderer && this.writer.upload(this.renderer, 'minecraft-particles')) this.counts.uploads++;
    this.counts.rendered = this.writer.length / (6 * STRIDE);
    this.buildWeather(eye, origin, hasSkylight);
  }
  buildWeather(eye, origin, hasSkylight) {
    this.weatherWriter.reset(origin); this.counts.rainColumns = 0; this.counts.snowColumns = 0;
    if (hasSkylight && this.rainLevel > 0.001) {
      const radius = this.weatherRadius, centerX = Math.floor(eye[0]), centerZ = Math.floor(eye[2]);
      for (let z = centerZ - radius; z <= centerZ + radius; z++) for (let x = centerX - radius; x <= centerX + radius; x++) {
        const biome = this.getBiome(x, Math.floor(eye[1]), z), precipitation = precipitationFor(biome, Math.floor(eye[1]));
        if (precipitation === 'none') continue;
        const terrain = this.getHeight(x, z); if (!Number.isFinite(terrain)) continue;
        const bottom = Math.max(eye[1] - radius, terrain + 1), top = Math.max(eye[1] + radius, terrain + 1); if (top <= bottom) continue;
        const dx = x + 0.5 - eye[0], dz = z + 0.5 - eye[2], distance = Math.hypot(dx, dz), hash = coordinateHash(x, z);
        const alpha = this.rainLevel * clamp(1 - (distance / radius) ** 2, 0, 1) * (precipitation === 'rain' ? 0.6 : 0.9); if (alpha < 0.001) continue;
        const side = distance > 0.01 ? [-dz / distance * 0.5, 0, dx / distance * 0.5] : [0.5, 0, 0], normal = normalize([-dx, 0, -dz]);
        const points = [[x + 0.5 - side[0], bottom, z + 0.5 - side[2]], [x + 0.5 - side[0], top, z + 0.5 - side[2]], [x + 0.5 + side[0], top, z + 0.5 + side[2]], [x + 0.5 + side[0], bottom, z + 0.5 + side[2]]];
        const tile = this.atlas?.weatherTiles?.get?.(`minecraft:environment/${precipitation}`) ?? -1, speed = precipitation === 'rain' ? 4.8 : 0.3, scroll = this.time * speed + hash;
        const uv = [[hash, bottom / 4 + scroll], [hash, top / 4 + scroll], [hash + 1, top / 4 + scroll], [hash + 1, bottom / 4 + scroll]];
        const light = this.getLight(x, Math.max(eye[1], terrain + 1), z) ?? { sky: 15, block: 0 };
        const flags = PARTICLE | REACTIVE | BLEND | LIGHT | (clamp(light.sky ?? 15, 0, 15) << 10) | (clamp(light.block ?? 0, 0, 15) << 14);
        this.weatherWriter.quad(points, normal, precipitation === 'snow' ? [1, 1, 1] : [0.72, 0.82, 1], alpha, tile, uv, flags);
        this.counts[precipitation === 'rain' ? 'rainColumns' : 'snowColumns']++;
      }
    }
    if (this.renderer) this.weatherWriter.upload(this.renderer, 'minecraft-weather');
  }
  weather() { return { rainLevel: this.rainLevel, thunderLevel: this.thunderLevel, lightningFlash: this.lightningTicks > 0 ? 1 : 0, fogMultiplier: 1 + this.rainLevel * 2.5 + this.thunderLevel * 2, sunMultiplier: (1 - this.rainLevel * 0.5) * (1 - this.thunderLevel * 0.5) }; }
  stats() { return { ...this.counts, active: this.particles.length, maxParticles: this.maxParticles, maxPacketParticles: this.maxPacketParticles, weather: this.weather(), uploadRateLimitHz: 30 }; }
  clear() { this.particles.length = 0; this.explosions.length = 0; this.accumulator = 0; this.uploadAt = -Infinity; this.isRaining = false; this.rainLevel = 0; this.thunderLevel = 0; this.lightningTicks = 0; this.counts.rendered = 0; this.counts.rainColumns = 0; this.counts.snowColumns = 0; this.renderer?.removeMesh('minecraft-particles'); this.renderer?.removeMesh('minecraft-weather'); }
  destroy() { this.clear(); this.closed = true; }
}
