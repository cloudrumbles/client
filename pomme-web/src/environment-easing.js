// Factual float operations of the named 1.21.11 Ease/EasingType timeline
// functions. Native trigonometric easings use Mth's bounded 65536-entry table.
const f = Math.fround;
const add = (a, b) => f(f(a) + f(b)), sub = (a, b) => f(f(a) - f(b));
const mul = (a, b) => f(f(a) * f(b)), div = (a, b) => f(f(a) / f(b));
const square = x => mul(x, x), cube = x => mul(square(x), x);
let sineTable, legacySineTable;
function trig(x, cosine = false, legacy = false) {
  if (legacy) {
    legacySineTable ??= Float32Array.from({ length: 65536 }, (_, i) => Math.sin(i * Math.PI * 2 / 65536));
    const at = cosine ? add(mul(x, 10430.378), 16384) : mul(x, 10430.378);
    return legacySineTable[Math.max(-2147483648, Math.min(2147483647, Math.trunc(at))) & 65535];
  }
  sineTable ??= Float32Array.from({ length: 65536 }, (_, i) => Math.sin(i / 10430.378350470453));
  const at = x * 10430.378350470453 + (cosine ? 16384 : 0);
  const index = Number.isSafeInteger(Math.trunc(at)) ? Math.trunc(at) & 65535
    : Number((at >= 9223372036854775807 ? 9223372036854775807n : at <= -9223372036854775808 ? -9223372036854775808n : BigInt(Math.trunc(at))) & 65535n);
  return sineTable[index];
}
export const nativeEnvironmentSin = (value, version = '1.21.11') => trig(value, false, version === '1.20.4');
export const nativeEnvironmentCos = (value, version = '1.21.11') => trig(value, true, version === '1.20.4');
function bounce(x) {
  const shift = x < f(0.36363637) ? 0 : x < f(0.72727275) ? f(0.54545456) : x < 0.9090909090909091 ? f(0.8181818) : f(0.95454544);
  const base = shift === 0 ? 0 : shift === f(0.54545456) ? 0.75 : shift === f(0.8181818) ? 0.9375 : 0.984375;
  return add(mul(7.5625, square(sub(x, shift))), base);
}
const curves = {
  constant: () => 0, linear: x => x,
  in_quad: square, in_cubic: cube, in_quart: x => square(square(x)), in_quint: x => mul(square(square(x)), x),
  out_quad: x => sub(1, square(sub(1, x))), out_cubic: x => sub(1, cube(sub(1, x))), out_quart: x => sub(1, square(square(sub(1, x)))), out_quint: x => sub(1, f((1 - x) ** 5)),
  in_out_quad: x => x < .5 ? mul(2, square(x)) : f(1 - (-2 * x + 2) ** 2 / 2),
  in_out_cubic: x => x < .5 ? mul(4, cube(x)) : f(1 - (-2 * x + 2) ** 3 / 2),
  in_out_quart: x => x < .5 ? mul(8, square(square(x))) : f(1 - (-2 * x + 2) ** 4 / 2),
  in_out_quint: x => x < .5 ? mul(mul(mul(mul(mul(16, x), x), x), x), x) : f(1 - (-2 * x + 2) ** 5 / 2),
  in_sine: x => sub(1, trig(mul(x, Math.PI / 2), true)), out_sine: x => trig(mul(x, Math.PI / 2)), in_out_sine: x => div(-sub(trig(mul(Math.PI, x), true), 1), 2),
  in_expo: x => x === 0 ? 0 : f(2 ** (10 * x - 10)), out_expo: x => x === 1 ? 1 : sub(1, f(2 ** (-10 * x))),
  in_out_expo: x => x < .5 ? x === 0 ? 0 : f(2 ** (20 * x - 10) / 2) : x === 1 ? 1 : f((2 - 2 ** (-20 * x + 10)) / 2),
  in_circ: x => add(f(-Math.sqrt(sub(1, square(x)))), 1), out_circ: x => f(Math.sqrt(sub(1, square(sub(x, 1))))),
  in_out_circ: x => x < .5 ? f((1 - Math.sqrt(1 - (2 * x) ** 2)) / 2) : f((Math.sqrt(1 - (-2 * x + 2) ** 2) + 1) / 2),
  in_back: x => mul(square(x), sub(mul(2.70158, x), 1.70158)),
  out_back: x => add(add(1, mul(2.70158, cube(sub(x, 1)))), mul(1.70158, square(sub(x, 1)))),
  in_out_back: x => {
    if (x < .5) return div(mul(mul(mul(4, x), x), sub(mul(7.189819, x), 2.5949094)), 2);
    const t = sub(mul(2, x), 2); return div(add(mul(square(t), add(mul(3.5949094, t), 2.5949094)), 2), 2);
  },
  out_bounce: bounce, in_bounce: x => sub(1, bounce(sub(1, x))),
  in_out_bounce: x => x < .5 ? div(sub(1, bounce(sub(1, mul(2, x)))), 2) : div(add(1, bounce(sub(mul(2, x), 1))), 2),
  in_elastic: x => x === 0 || x === 1 ? x : f(-(2 ** (10 * x - 10)) * Math.sin((x * 10 - 10.75) * f(2.0943952))),
  out_elastic: x => x === 0 || x === 1 ? x : f(2 ** (-10 * x) * Math.sin((x * 10 - .75) * f(2.0943952)) + 1),
  in_out_elastic: x => {
    if (x === 0 || x === 1) return x;
    const wave = Math.sin((20 * x - 11.125) * f(1.3962635));
    return x < .5 ? f(-(2 ** (20 * x - 10) * wave) / 2) : f(2 ** (-20 * x + 10) * wave / 2 + 1);
  },
};

export const ENVIRONMENT_EASINGS = Object.freeze(Object.keys(curves));
export function compileEnvironmentEase(ease = 'linear') {
  if (typeof ease === 'string') {
    const curve = curves[ease]; if (!curve) throw new Error(`Unsupported native timeline easing: ${ease.slice(0, 128)}`);
    return x => curve(f(x));
  }
  const controls = ease?.cubic_bezier;
  if (!Array.isArray(controls) || controls.length !== 4 || !controls.every(Number.isFinite) || controls[0] < 0 || controls[0] > 1 || controls[2] < 0 || controls[2] > 1) throw new Error('Invalid native cubic Bezier controls.');
  const curve = (first, second) => {
    const a = add(sub(mul(3, first), mul(3, second)), 1), b = add(mul(-6, first), mul(3, second)), c = mul(3, first);
    return { value: t => mul(add(mul(add(mul(a, t), b), t), c), t), gradient: t => add(mul(add(mul(mul(3, a), t), mul(2, b)), t), c) };
  };
  const xCurve = curve(f(controls[0]), f(controls[2])), yCurve = curve(f(controls[1]), f(controls[3]));
  return value => {
    const x = f(value); let t = x;
    for (let step = 0; step < 4; step++) { const gradient = xCurve.gradient(t); if (gradient < f(1e-5)) break; t = sub(t, div(sub(xCurve.value(t), x), gradient)); }
    return yCurve.value(t);
  };
}
