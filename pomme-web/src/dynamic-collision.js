// Native 1.20.4 Entity.collideWithShapes, VoxelShape.collideX, PistonMath,
// PistonMovingBlockEntity and Shulker.getProgressDeltaAabb. Coordinates stay
// authoritative world doubles; these helpers never alter the voxel world.
export const SHAPE_EPSILON = 1e-7;
export const PISTON_LIMIT = 0.51;

export function aabbAt(position, halfWidth, height) {
  return [position[0] - halfWidth, position[1], position[2] - halfWidth, position[0] + halfWidth, position[1] + height, position[2] + halfWidth];
}

export function moveAabb(box, delta) { return box.map((value, index) => value + delta[index % 3]); }
export function expandAabb(box, delta) { return box.map((value, index) => value + (index < 3 ? Math.min(0, delta[index]) : Math.max(0, delta[index - 3]))); }
export function intersectsAabb(a, b, epsilon = 0) { return [0, 1, 2].every(axis => a[axis] < b[axis + 3] - epsilon && a[axis + 3] > b[axis] + epsilon); }
export function unionAabb(boxes) {
  if (!boxes.length) return null;
  return [0, 1, 2].map(axis => Math.min(...boxes.map(box => box[axis]))).concat([0, 1, 2].map(axis => Math.max(...boxes.map(box => box[axis + 3]))));
}

/** Clip against disjoint occupied AABBs, preserving native 1e-7 tolerances. */
export function clipShapeAxis(bounds, shapes, axis, displacement) {
  if (Math.abs(displacement) < SHAPE_EPSILON) return 0;
  for (const shape of shapes) {
    if (![0, 1, 2].every(other => other === axis || bounds[other + 3] > shape[other] + SHAPE_EPSILON && bounds[other] < shape[other + 3] - SHAPE_EPSILON)) continue;
    if (displacement > 0) {
      const gap = shape[axis] - bounds[axis + 3];
      if (gap >= -SHAPE_EPSILON) displacement = Math.min(displacement, gap);
    } else {
      const gap = shape[axis + 3] - bounds[axis];
      if (gap <= SHAPE_EPSILON) displacement = Math.max(displacement, gap);
    }
  }
  return displacement;
}

export function clipShapeMovement(bounds, shapes, [dx, dy, dz]) {
  let box = [...bounds];
  dy = clipShapeAxis(box, shapes, 1, dy);
  if (dy) box = moveAabb(box, [0, dy, 0]);
  const zFirst = Math.abs(dx) < Math.abs(dz);
  if (zFirst) { dz = clipShapeAxis(box, shapes, 2, dz); if (dz) box = moveAabb(box, [0, 0, dz]); }
  dx = clipShapeAxis(box, shapes, 0, dx);
  if (!zFirst) { if (dx) box = moveAabb(box, [dx, 0, 0]); dz = clipShapeAxis(box, shapes, 2, dz); }
  return [dx, dy, dz];
}

/** PistonMath sweeps only the advancing face, not the block's occupied body. */
export function pistonMovementArea(box, direction, distance) {
  const result = [...box], axis = direction.findIndex(value => value !== 0);
  if (axis < 0) return result;
  if (direction[axis] > 0) { result[axis] = box[axis + 3]; result[axis + 3] += distance; }
  else { result[axis + 3] = box[axis]; result[axis] -= distance; }
  return result;
}

export function movementPenetration(box, direction, entityBounds) {
  const axis = direction.findIndex(value => value !== 0);
  return axis < 0 ? 0 : direction[axis] > 0 ? box[axis + 3] - entityBounds[axis] : entityBounds[axis + 3] - box[axis];
}

export function shulkerMovementArea(position, direction, previousProgress, currentProgress) {
  const box = position.concat(position.map(value => value + 1));
  const axis = direction.findIndex(value => value !== 0);
  if (axis < 0) return box;
  if (direction[axis] > 0) { box[axis] += 1 + previousProgress; box[axis + 3] += currentProgress; }
  else { box[axis] -= currentProgress; box[axis + 3] -= 1 + previousProgress; }
  return box;
}

/** Signed cumulative cap, shared by all piston moves during one world tick. */
export function restrictPistonMovement(previous, displacement) {
  const cumulative = Math.max(-PISTON_LIMIT, Math.min(PISTON_LIMIT, previous + displacement));
  const allowed = cumulative - previous;
  return { cumulative, allowed: Math.abs(allowed) <= Math.fround(1e-5) ? 0 : allowed };
}

/** Return requested push/carry before world collision and piston cap. */
export function blockMotionDisplacement(event, bounds, { grounded = false, position = null, supportedBy = false } = {}) {
  const direction = event.direction, axis = direction?.findIndex(value => value !== 0);
  const distance = Number(event.currentProgress) - Number(event.previousProgress);
  if (axis === undefined || axis < 0 || !Number.isFinite(distance) || distance <= 0) return null;
  if (event.kind === 'shulker') {
    const area = shulkerMovementArea(event.position, direction, event.previousProgress, event.currentProgress);
    return intersectsAabb(area, bounds) ? { axis, direction, distance: area[axis + 3] - area[axis] + 0.01, slime: false, carry: false } : null;
  }
  if (event.kind !== 'piston' || !event.boxes?.length) return null;
  const shapeBounds = unionAabb(event.boxes), sweptBounds = expandAabb(shapeBounds, direction.map(value => value * distance));
  const name = String(event.materialName ?? '').replace(/^minecraft:/, ''), slime = name === 'slime_block' && intersectsAabb(sweptBounds, bounds);
  let penetration = 0;
  for (const shape of event.boxes) {
    const area = pistonMovementArea(shape, direction, distance);
    if (intersectsAabb(area, bounds)) penetration = Math.max(penetration, movementPenetration(area, direction, bounds));
    if (penetration >= distance) break;
  }
  if (penetration > 0) return { axis, direction, distance: Math.min(penetration, distance) + 0.01, slime, carry: false };
  if (name === 'honey_block' && axis !== 1 && grounded && position) {
    // Native sticky test uses the moved shape's maximum Y up to 1.500001,
    // intersects the entity bounds, then tests entity center X/Z inclusively.
    const facing = direction.map(value => event.extending ? value : -value);
    const offset = event.extending ? event.previousProgress - 1 : 1 - event.previousProgress;
    const origin = event.position.map((value, index) => value + facing[index] * offset);
    const area = [origin[0], shapeBounds[4], origin[2], origin[0] + 1, origin[1] + 1.500001, origin[2] + 1];
    if (intersectsAabb(area, bounds) && (supportedBy || position[0] >= area[0] && position[0] <= area[3] && position[2] >= area[2] && position[2] <= area[5])) return { axis, direction, distance, slime, carry: true };
  }
  return slime ? { axis, direction, distance: 0, slime, carry: false } : null;
}

export function pistonBaseCorrection(event, bounds) {
  if (event.kind !== 'piston' || event.extending || !event.source) return null;
  const base = event.position.concat(event.position.map(value => value + 1));
  if (!intersectsAabb(bounds, base)) return null;
  const opposite = event.direction.map(value => -value), inside = bounds.map((value, index) => index < 3 ? Math.max(value, base[index]) : Math.min(value, base[index]));
  const total = movementPenetration(base, opposite, bounds) + 0.01, clipped = movementPenetration(base, opposite, inside) + 0.01;
  return Math.abs(total - clipped) < 0.01 ? { direction: opposite, distance: Math.min(total, event.currentProgress - event.previousProgress) + 0.01 } : null;
}
