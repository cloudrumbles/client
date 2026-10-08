import { HandPose, applyItemDisplay } from './item-pose.js';

export const droppedItemCopies = count => count > 48 ? 5 : count > 32 ? 4 : count > 16 ? 3 : count > 1 ? 2 : 1;
const tagValue = value => value?.type && Object.hasOwn(value, 'value') ? value.value : value;
function itemRandom(seed) {
  let value = (BigInt(Math.trunc(seed)) ^ 0x5deece66dn) & ((1n << 48n) - 1n);
  return () => { value = (value * 0x5deece66dn + 11n) & ((1n << 48n) - 1n); return Number(value >> 24n) / 16777216; };
}
function emit(writer, context, pose, mesh) {
  const normalMatrix = pose.normalMatrix();
  if (!normalMatrix.every(Number.isFinite)) return;
  for (const part of mesh.parts) writer.triangles(part.vertices, context, { matrix: pose.matrix, normalMatrix, position: pose.position, tile: part.tile, tint: part.tint, flags: part.flags });
}

// Original ItemEntityRenderer: native stack thresholds, Java Random layout,
// resource-pack ground display, age-based bob/spin and true sprite extrusion.
export function drawDroppedItem(writer, context, slot, mesh, { age = 0, bob = 0 } = {}) {
  if (!mesh.parts.length) return false;
  const copies = droppedItemCopies(Number(slot.itemCount) || 1), display = mesh.display.ground || {}, scale = display.scale || [1, 1, 1];
  const pose = new HandPose().translate(0, Math.sin(age * 2 + bob) * .1 + .1 + .25 * scale[1], 0).rotate('y', (age + bob) * 180 / Math.PI);
  // ItemEntity.getSpin(partial) is age-in-ticks / 20 + bobOffs, so age in
  // seconds is already the angle in radians.
  if (!mesh.gui3d) pose.translate(0, 0, -.09375 * (copies - 1) * .5 * scale[2]);
  const tag = tagValue(slot.nbtData ?? slot.nbt), random = itemRandom(slot.itemId + (Number(tagValue(tag?.Damage)) || 0));
  for (let copy = 0; copy < copies; copy++) {
    const itemPose = pose.clone();
    if (copy) { const spread = mesh.gui3d ? .15 : .075; itemPose.translate((random() * 2 - 1) * spread, (random() * 2 - 1) * spread, mesh.gui3d ? (random() * 2 - 1) * spread : 0); }
    emit(writer, context, applyItemDisplay(itemPose, display), mesh);
    if (!mesh.gui3d) pose.translate(0, 0, .09375 * scale[2]);
  }
  return true;
}

// ItemInHandLayer.translateToHand followed by its native arm-specific offset.
// Entity model cubes already use reflected X and inverted Y; return to native
// model coordinates before applying the held item transform.
export function drawEquippedItem(writer, context, mesh, arm, input, side) {
  if (!mesh.parts.length || !arm) return false;
  const pose = new HandPose(); pose.matrix = [...arm.matrix]; pose.position = [...arm.position];
  if (input.nativeYoungBody) { pose.matrix = pose.matrix.map(value => value * .5); pose.position = pose.position.map((value, axis) => value * .5 + (axis === 1 ? .0005 : 0)); }
  pose.scale(1, -1, 1);
  // CopperGolemModel.translateToHand adds its interaction-specific transform
  // after the body/arm hierarchy, before the common ItemInHandLayer offset.
  if (input.family === 'copper_golem') {
    if (input.copperGolemState === 'idle') pose.rotate('y', side > 0 ? -90 : 90).translate(0, 0, .125);
    else pose.scale(.55).translate(-.125, .3125, -.1875);
  }
  pose.rotate('x', -90).rotate('y', 180).translate(side / 16, .125, -.625);
  const display = mesh.display[side < 0 ? 'thirdperson_lefthand' : 'thirdperson_righthand'] || mesh.display.thirdperson_righthand || (mesh.block ? { rotation: [75, 45, 0], translation: [0, 2.5, 0], scale: [.375, .375, .375] } : { rotation: [0, -90, 55], translation: [0, 4, .5], scale: [.85, .85, .85] });
  emit(writer, context, applyItemDisplay(pose, display, side), mesh); return true;
}
