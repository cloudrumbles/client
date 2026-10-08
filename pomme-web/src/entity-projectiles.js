const TRIANGLES = [0, 1, 2, 0, 2, 3];
let ARROW;

export function arrowGeometry() {
  if (ARROW) return ARROW;
  const vertices = [], scale = 0.05625;
  const emit = (points, rectangle, angle, reversed = false) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    const posed = points.map(([x, y, z]) => [(x - 4) * scale, (c * y - s * z) * scale, (s * y + c * z) * scale]);
    const ab = posed[1].map((value, axis) => value - posed[0][axis]), ac = posed[2].map((value, axis) => value - posed[0][axis]);
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]], length = Math.hypot(...cross);
    const normal = cross.map(value => value / length), [u0, v0, u1, v1] = rectangle;
    const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (const corner of TRIANGLES) { const index = reversed ? 3 - corner : corner; vertices.push(...posed[index], ...(reversed ? normal.map(value => -value) : normal), ...uv[index]); }
  };
  const cap = [[-7, -2, -2], [-7, -2, 2], [-7, 2, 2], [-7, 2, -2]];
  emit(cap, [0, 0.15625, 0.15625, 0.3125], Math.PI / 4);
  emit(cap, [0, 0.15625, 0.15625, 0.3125], Math.PI / 4, true);
  const shaft = [[-8, -2, 0], [8, -2, 0], [8, 2, 0], [-8, 2, 0]];
  for (let plane = 0; plane < 4; plane++) emit(shaft, [0, 0, 0.5, 0.15625], Math.PI / 4 + (plane + 1) * Math.PI / 2);
  ARROW = new Float32Array(vertices); return ARROW;
}
