// Factual geometry/timing from Java BeaconRenderer/TheEndGatewayRenderer in
// 1.20.4, 1.21.11 and 26.1. Texture pixels remain in the user's imported client JAR.
export const NATIVE_BEAM = 536870912;
export const BEAM_FULLBRIGHT = 16777216;
const f = Math.fround, PI = f(Math.PI), sine = new Float32Array(65536);
for (let index = 0; index < sine.length; index++) sine[index] = Math.sin(index * Math.PI * 2 / sine.length);
const versionText = version => String(typeof version === 'object' ? version?.minecraftVersion ?? version?.majorVersion ?? '1.20.4' : version ?? '1.20.4');

/** Both original Mth tables contain identical Float32 values. Legacy sin(float)
 * narrows a float product to int; modern sin(double) narrows a double product
 * to long. Java saturates overflowing casts and maps NaN to zero. */
export function nativeSin(value, modern = false) {
  const product = modern ? value * 10430.378350470453 : f(f(value) * f(10430.378));
  const index = Number.isNaN(product) ? 0 : modern
    ? product >= 9223372036854775808 ? 65535 : product <= -9223372036854775808 ? 0 : Math.trunc(product)
    : Math.max(-2147483648, Math.min(2147483647, Math.trunc(product)));
  return sine[index & 65535];
}
export function nativeBeamTime(age, partial = 0) {
  const tick = typeof age === 'bigint' ? Number((age % 40n + 40n) % 40n) : ((Math.floor(Number(age) || 0) % 40) + 40) % 40;
  return f(tick + f(Math.max(0, Math.min(1, partial))));
}
export function nativeBeamProfile(version = '1.20.4', horizontalDistance = 0, scoping = false) {
  const [major, minor] = versionText(version).split('.').map(Number), modern = major >= 26 || major === 1 && minor >= 21;
  const radiusScale = modern && !scoping ? Math.max(1, f(f(horizontalDistance) / 96)) : 1;
  return { modern, finalHeight: modern ? 2048 : 1024, radiusScale, outerAlpha: modern ? 32 / 255 : .125 };
}
export function nativeBeamTexture(version = '1.20.4', gateway = false) {
  const calendar = Number(versionText(version).split('.')[0]) >= 26;
  return `minecraft:entity/${gateway ? calendar ? 'end_portal/end_gateway_beam' : 'end_gateway_beam' : calendar ? 'beacon/beacon_beam' : 'beacon_beam'}`;
}
export function nativeBeamColorMix(current, next, modern = false) {
  return next.map((value, axis) => modern ? Math.floor((Math.round(value * 255) + Math.round(current[axis] * 255)) / 2) / 255 : f((f(value) + f(current[axis])) / 2));
}

/** Eight native quads. Outer faces retain the source's inward winding and UV
 * direction; both native beam render types use default backface culling. */
export function nativeBeamQuads({ bottom = 0, height, animationTime = 0, intensity = 1, innerRadius = .2, outerRadius = .25, outerAlpha = .125 } = {}) {
  const top = (bottom + height) | 0, time = f(animationTime), phase = height < 0 ? time : -time;
  const scrollValue = f(f(phase * f(.2)) - Math.floor(f(phase * f(.1)))), scroll = f(f(scrollValue - Math.floor(scrollValue)) - 1);
  const angle = f(f(time * f(2.25)) - 45) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle), quads = [];
  for (const outer of [false, true]) {
    const radius = outer ? outerRadius : innerRadius;
    const points = outer ? [[-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]] : [[0, radius], [radius, 0], [-radius, 0], [0, -radius]].map(([x, z]) => [x * c + z * s, -x * s + z * c]);
    const topV = f(f(f(f(height) * f(intensity)) * (outer ? 1 : f(.5 / radius))) + scroll);
    for (const [a, b] of [[0, 1], [3, 2], [1, 3], [2, 0]]) {
      const [x, z] = points[a], [X, Z] = points[b];
      quads.push({ positions: [[x + .5, top, z + .5], [x + .5, bottom, z + .5], [X + .5, bottom, Z + .5], [X + .5, top, Z + .5]], normal: [0, 1, 0], uv: [[1, topV], [1, scroll], [0, scroll], [0, topV]], alpha: outer ? outerAlpha : 1, flags: NATIVE_BEAM | BEAM_FULLBRIGHT | (outer ? 64 : 0), outer });
    }
  }
  return quads;
}
export function nativeGatewayExtent({ age = 0n, cooldown = 0, partial = 0, maxY = 320, modern = false } = {}) {
  const spawning = age < 200, progress = spawning ? f(f(f(Number(age)) + f(partial)) / 200) : f(1 - Math.max(0, Math.min(1, f(f(cooldown - f(partial)) / 40))));
  const intensity = nativeSin(f(Math.max(0, Math.min(1, progress)) * PI), modern), extent = Math.floor(intensity * (spawning ? maxY - (modern ? 1 : 0) : 50));
  return { spawning, intensity, extent, bottom: (-extent) | 0, height: (extent * 2) | 0 };
}
