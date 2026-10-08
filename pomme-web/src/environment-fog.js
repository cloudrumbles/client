// Native Camera, LocalPlayer and FogRenderer/WaterFogEnvironment in the named
// 1.20.4 and 1.21.11 originals. Resolved modern attributes are caller inputs;
// their spatial/day-cycle interpolation belongs to the environment probe.
const f = Math.fround;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const modern = version => version !== '1.20.4';
const bytes = color => [color >>> 16 & 255, color >>> 8 & 255, color & 255];
const rgb = color => bytes(color).map(value => f(value / 255));
const lerp = (amount, a, b) => f(a + f(amount * f(b - a)));

export function nativeWaterVision(ticks, eyesInWater = true) {
  if (!eyesInWater) return 0;
  const time = clamp(Math.trunc(finite(ticks, 0)), 0, 600);
  if (time >= 600) return 1;
  const quick = f(clamp(f(time / 100), 0, 1));
  const slow = time < 100 ? 0 : f(clamp(f(f(time - 100) / 500), 0, 1));
  return f(f(quick * f(0.6)) + f(slow * f(0.39999998)));
}

export function cameraNearPlane({ forward, right, up, fov = 70, aspect = 1 }) {
  if (![forward, right, up].every(vector => vector?.length === 3 && Array.from(vector).every(Number.isFinite))) throw new TypeError('Camera fog requires three finite basis vectors.');
  const near = f(0.05), vertical = Math.tan(f(f(fov) * f(Math.PI / 180)) / 2) * near;
  const horizontal = vertical * finite(aspect, 1), center = Array.from(forward, value => value * near);
  return [center, ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([x, y]) => center.map((value, axis) => value + right[axis] * horizontal * x + up[axis] * vertical * y))];
}

export function cameraFogType(eye, sample, nearPlane = [[0, 0, 0]]) {
  if (!eye?.length || eye.length !== 3 || !Array.from(eye).every(Number.isFinite) || typeof sample !== 'function') return 'none';
  const block = Array.from(eye, Math.floor), state = sample(...block), fluid = state?.fluid;
  // Subtract the integral coordinate first to preserve the native surface
  // fraction even at extreme signed heights.
  if (fluid?.kind === 'water' && eye[1] - block[1] < fluid.height) return 'water';
  for (const offset of nearPlane.slice(0, 5)) {
    if (offset?.length !== 3 || !Array.from(offset).every(Number.isFinite)) continue;
    const point = Array.from(eye, (value, axis) => value + offset[axis]), at = point.map(Math.floor), entry = sample(...at);
    if (entry?.fluid?.kind === 'lava' && point[1] - at[1] <= entry.fluid.height) return 'lava';
    if (entry?.name?.replace(/^minecraft:/, '') === 'powder_snow') return 'powder-snow';
  }
  return 'none';
}

export function nativeFogFactor(distance, start, end, version = '1.21.11') {
  if (distance <= start) return 0;
  if (distance >= end) return 1;
  const factor = (distance - start) / (end - start);
  return version === '1.20.4' ? factor * factor * (3 - 2 * factor) : factor;
}

export class EnvironmentFog {
  constructor({ version = '1.20.4' } = {}) { this.version = version; this.reset(); }
  reset() { this.waterVisionTime = 0; this.previousColor = null; this.targetColor = null; this.colorChangedAt = 0; }
  step({ eyesInWater = false, spectator = false } = {}, ticks = 1) {
    const elapsed = clamp(Math.trunc(finite(ticks, 0)), 0, 600);
    this.waterVisionTime = clamp(this.waterVisionTime + (eyesInWater ? spectator ? 10 : 1 : -10) * elapsed, 0, 600);
  }
  waterColor(color, nowMs) {
    const at = finite(nowMs, 0);
    if (modern(this.version)) return rgb(color);
    if (this.targetColor === null) { this.targetColor = color; this.previousColor = color; this.colorChangedAt = at; }
    const blend = f(clamp(f((at - this.colorChangedAt) / 5000), 0, 1));
    const previous = bytes(this.previousColor), target = bytes(this.targetColor);
    const blended = target.map((value, axis) => lerp(blend, previous[axis], value));
    // The native frame first samples the previous transition, then replaces
    // its target and floors the intermediate bytes for the next transition.
    if (this.targetColor !== color) {
      this.targetColor = color; this.previousColor = Math.floor(blended[0]) << 16 | Math.floor(blended[1]) << 8 | Math.floor(blended[2]); this.colorChangedAt = at;
    }
    return blended.map(value => f(value / 255));
  }
  sample({ type = 'none', farPlane = 128, spectator = false, fireResistance = false, eyesInWater = type === 'water',
    localPlayer = true, waterFogColor = 0x050533, waterFogStart = -8, waterFogEnd = 96, closerWaterFog = false,
    nowMs = 0, eyeY = 64, minY = -64, voidRange = 32, bossDarkening = 0, blindnessDuration = null,
    darknessFactor = 0, hasDarkness = darknessFactor > 0, darknessFactorPresent = true, nightVisionScale = 0, atmosphericColor = null } = {}) {
    const newer = modern(this.version), far = Math.max(1, finite(farPlane, 128));
    let start, end, color, shape = 'sphere', skyEnd;
    const vision = localPlayer ? nativeWaterVision(this.waterVisionTime, eyesInWater) : 1;
    if (type === 'water') {
      color = this.waterColor(waterFogColor >>> 0 & 0xffffff, nowMs);
      start = newer ? finite(waterFogStart, -8) : -8;
      end = f(Math.max(0, newer ? finite(waterFogEnd, 96) : 96) * f(Math.max(0.25, vision)));
      if (!newer && closerWaterFog && localPlayer) end = f(end * f(0.85));
      if (!newer && end > far) { end = far; shape = 'cylinder'; }
    } else {
      this.previousColor = this.targetColor = null;
      if (type === 'lava') { color = newer ? rgb(0x991900) : [f(0.6), f(0.1), 0]; start = spectator ? -8 : fireResistance ? 0 : 0.25; end = spectator ? far * 0.5 : fireResistance ? newer ? 5 : 3 : 1; }
      else if (type === 'powder-snow') { color = newer ? rgb(0x9fbbcc) : [f(0.623), f(0.734), f(0.785)]; start = spectator ? -8 : 0; end = spectator ? far * 0.5 : 2; }
      else { if (!atmosphericColor || blindnessDuration === null && !hasDarkness) return null; color = Array.from(atmosphericColor); start = 0; end = far; }
    }
    if (type !== 'lava' && type !== 'powder-snow') {
      if (blindnessDuration !== null) {
        const duration = finite(blindnessDuration, 0);
        end = duration === -1 ? 5 : lerp(f(Math.min(1, f(f(duration) / 20))), f(far), 5); start = end * 0.25;
        skyEnd = f(end * f(0.8));
      } else if (hasDarkness) {
        // Presence selects the native fog environment even before its blend
        // rises above zero. Legacy absent FactorData leaves FogData at0/0.
        end = !newer && !darknessFactorPresent ? 0 : lerp(f(clamp(darknessFactor, 0, 1)), f(far), 15);
        start = f(end * f(0.75)); skyEnd = end;
      }
      let darkness = clamp((finite(voidRange, 32) + minY - eyeY) / Math.max(1, finite(voidRange, 32)), 0, 1);
      if (blindnessDuration !== null) { const effect = blindnessDuration !== -1 && blindnessDuration < 20 ? blindnessDuration / 20 : 1; darkness = newer ? Math.max(effect, darkness) : Math.max(0, effect); }
      else if (hasDarkness) darkness = newer ? Math.max(darkness, clamp(darknessFactor, 0, 1)) : darknessFactorPresent ? clamp(darknessFactor, 0, 1) : 1;
      const brightness = f(f(1 - darkness) * f(1 - darkness)); color = color.map(value => f(value * brightness));
    }
    const boss = clamp(finite(bossDarkening, 0), 0, 1);
    const blend = newer ? lerp : (t, a, b) => f(f(a * f(1 - t)) + f(b * t));
    color = color.map((value, axis) => blend(f(boss), value, f(value * f(axis === 0 ? 0.7 : 0.6))));
    const colorVision = type === 'water' ? vision : hasDarkness ? 0 : f(clamp(finite(nightVisionScale, 0), 0, 1));
    if (color.every(value => value !== 0)) {
      const gain = f(1 / Math.max(...color)); color = color.map(value => blend(colorVision, value, f(value * gain)));
    }
    return { type, color, colorEncoding: 'native-rgb', start, end, shape, skyEnd: skyEnd ?? end, cloudEnd: skyEnd ?? end,
      renderStart: far - clamp(far / 10, 4, 64), renderEnd: far, separateRenderDistance: newer, waterVision: vision };
  }
}
