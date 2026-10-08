export const EFFECT_NAMES = ['speed', 'slowness', 'haste', 'mining_fatigue', 'strength', 'instant_health', 'instant_damage', 'jump_boost', 'nausea', 'regeneration', 'resistance', 'fire_resistance', 'water_breathing', 'invisibility', 'blindness', 'night_vision', 'hunger', 'weakness', 'poison', 'wither', 'health_boost', 'absorption', 'saturation', 'glowing', 'levitation', 'luck', 'unluck', 'slow_falling', 'conduit_power', 'dolphins_grace', 'bad_omen', 'hero_of_the_village', 'darkness'];
export const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant']);
const HORIZONTAL = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export function blockName(material) { return material?.name?.replace(/^minecraft:/, '') ?? ''; }
export function blockFriction(material) {
  if (Number.isFinite(material?.friction)) return Math.max(0.01, material.friction);
  switch (blockName(material)) {
    case 'ice': case 'packed_ice': case 'frosted_ice': return 0.98;
    case 'blue_ice': return 0.989;
    case 'slime_block': return 0.8;
    default: return 0.6;
  }
}
export function blockSpeedFactor(material) {
  if (Number.isFinite(material?.speedFactor)) return Math.max(0, material.speedFactor);
  return ['soul_sand', 'honey_block'].includes(blockName(material)) ? 0.4 : 1;
}
export function blockJumpFactor(material) {
  if (Number.isFinite(material?.jumpFactor)) return Math.max(0, material.jumpFactor);
  return blockName(material) === 'honey_block' ? 0.5 : 1;
}
export function fluidState(material, flags = 0) {
  const name = blockName(material), properties = material?.properties ?? {};
  const contained = material?.fluid;
  const kind = contained ? (contained.kind === 2 ? 'lava' : contained.kind === 1 ? 'water' : null)
    : name === 'lava' ? 'lava' : name === 'water' || name === 'bubble_column'
      || ['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant'].includes(name)
      || properties.waterlogged === 'true' || (!material && (flags & 4)) ? 'water' : null;
  if (!kind) return { kind: null, height: 0, falling: false };
  const level = Number(contained?.level ?? (['water', 'lava'].includes(name) ? properties.level ?? 0 : 0)), falling = level >= 8;
  return { kind, height: (falling ? 8 : 8 - Math.max(0, Math.min(7, level))) / 9, falling };
}
function normalized(vector) {
  const length = Math.hypot(...vector);
  return length < 1e-5 ? [0, 0, 0] : vector.map(component => component / length);
}

/** FlowingFluid.getFlow, using imported state levels and exact full-face boxes. */
export function fluidFlowAt(sample, x, y, z, fluid) {
  let flowX = 0, flowZ = 0;
  for (const [dx, dz] of HORIZONTAL) {
    const neighbor = sample(x + dx, y, z + dz), other = neighbor.fluid;
    if (other.kind && other.kind !== fluid.kind) continue;
    let distance = 0;
    if (!other.height) {
      const below = sample(x + dx, y - 1, z + dz).fluid;
      if (!(neighbor.flags & 1) && below.kind === fluid.kind) distance = fluid.height - (below.height - 8 / 9);
    } else distance = fluid.height - other.height;
    flowX += dx * distance; flowZ += dz * distance;
  }
  let flow = [flowX, 0, flowZ];
  if (fluid.falling) {
    for (const [dx, dz] of HORIZONTAL) {
      const sturdy = by => {
        const neighbor = sample(x + dx, by, z + dz);
        if (neighbor.fluid.kind === fluid.kind || ['ice', 'frosted_ice'].includes(blockName(neighbor.material))) return false;
        const boxes = neighbor.material?.collisionBoxes;
        if (!boxes) return Boolean(neighbor.flags & 2);
        return boxes.some(([x0, y0, z0, x1, y1, z1]) => y0 <= 0 && y1 >= 1 &&
          (dx ? z0 <= 0 && z1 >= 1 && (dx > 0 ? x0 <= 0 : x1 >= 1) : x0 <= 0 && x1 >= 1 && (dz > 0 ? z0 <= 0 : z1 >= 1)));
      };
      if (sturdy(y) || sturdy(y + 1)) { flow = normalized(flow); flow[1] -= 6; break; }
    }
  }
  return normalized(flow);
}

export function fallingFluidVelocity(velocity, gravity, falling, sprinting) {
  if (!gravity || sprinting) return velocity;
  return falling && Math.abs(velocity - 0.005) >= 0.003 && Math.abs(velocity - gravity / 16) < 0.003 ? -0.003 : velocity - gravity / 16;
}

/** LivingEntity.travel's fall-flying branch. Velocity uses blocks per tick. */
export function elytraVelocity(velocity, direction, pitch, gravity = 0.08) {
  const [lx, ly, lz] = direction;
  const lookHorizontal = Math.hypot(lx, lz), speed = Math.hypot(velocity[0], velocity[2]);
  const lift = Math.cos(pitch) ** 2 * Math.min(1, Math.hypot(lx, ly, lz) / 0.4);
  const next = [velocity[0], velocity[1] + gravity * (-1 + lift * 0.75), velocity[2]];
  if (next[1] < 0 && lookHorizontal > 0) {
    const descentLift = next[1] * -0.1 * lift;
    next[0] += lx * descentLift / lookHorizontal; next[1] += descentLift; next[2] += lz * descentLift / lookHorizontal;
  }
  if (pitch > 0 && lookHorizontal > 0) {
    const climbLift = speed * Math.sin(pitch) * 0.04;
    next[0] -= lx * climbLift / lookHorizontal; next[1] += climbLift * 3.2; next[2] -= lz * climbLift / lookHorizontal;
  }
  if (lookHorizontal > 0) {
    next[0] += (lx / lookHorizontal * speed - next[0]) * 0.1;
    next[2] += (lz / lookHorizontal * speed - next[2]) * 0.1;
  }
  return next.map((value, axis) => value * Math.fround(axis === 1 ? 0.98 : 0.99));
}
