const DEG = Math.PI / 180;
const transform = (point, m) => [m[0] * point[0] + m[1] * point[1] + m[2] * point[2], m[3] * point[0] + m[4] * point[1] + m[5] * point[2], m[6] * point[0] + m[7] * point[1] + m[8] * point[2]];
const multiply = (a, b) => Array.from({ length: 9 }, (_, index) => { const row = Math.floor(index / 3), column = index % 3; return a[row * 3] * b[column] + a[row * 3 + 1] * b[column + 3] + a[row * 3 + 2] * b[column + 6]; });

export class HandPose {
  constructor() { this.matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]; this.position = [0, 0, 0]; }
  clone() { const pose = new HandPose(); pose.matrix = [...this.matrix]; pose.position = [...this.position]; return pose; }
  append(pose) { this.translate(...pose.position); this.matrix = multiply(this.matrix, pose.matrix); return this; }
  translate(x, y, z) { const offset = transform([x, y, z], this.matrix); this.position = this.position.map((value, axis) => value + offset[axis]); return this; }
  rotate(axis, degrees) {
    const c = Math.cos(degrees * DEG), s = Math.sin(degrees * DEG);
    const matrix = axis === 'x' ? [1, 0, 0, 0, c, -s, 0, s, c] : axis === 'y' ? [c, 0, s, 0, 1, 0, -s, 0, c] : [c, -s, 0, s, c, 0, 0, 0, 1];
    this.matrix = multiply(this.matrix, matrix); return this;
  }
  scale(x, y = x, z = x) { this.matrix = multiply(this.matrix, [x, 0, 0, 0, y, 0, 0, 0, z]); return this; }
  normalMatrix() {
    const [a, b, c, d, e, f, g, h, i] = this.matrix;
    const cofactors = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
    const determinant = a * cofactors[0] + b * cofactors[1] + c * cofactors[2];
    return cofactors.map(value => value / determinant);
  }
}


export function applyItemDisplay(pose, display = {}, side = 1) {
  const r = display.rotation || [0, 0, 0], t = display.translation || [0, 0, 0], s = display.scale || [1, 1, 1];
  return pose.translate(side * t[0] / 16, t[1] / 16, t[2] / 16).rotate('x', r[0]).rotate('y', side * r[1]).rotate('z', side * r[2]).scale(...s);
}
