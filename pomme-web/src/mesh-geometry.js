const TRIANGLES = [0, 1, 2, 0, 2, 3];

export function quadGeometry(points, uv, normal) {
  const ab = points[1].map((value, axis) => value - points[0][axis]), ac = points[2].map((value, axis) => value - points[0][axis]);
  const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const reversed = cross.reduce((sum, value, axis) => sum + value * normal[axis], 0) < 0;
  const vertices = [];
  for (const corner of TRIANGLES) { const index = reversed ? 3 - corner : corner; vertices.push(...points[index], ...normal, ...uv[index]); }
  return vertices;
}
