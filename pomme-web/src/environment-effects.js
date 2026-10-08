// Source-version GameRenderer night vision and MobEffectInstance darkness
// blending. Call tick with the remaining duration AFTER the native20TPS
// duration decrement; effect presence/removal belongs to the caller.
import { nativeEnvironmentSin } from './environment-easing.js';
const f = Math.fround, clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const lerp = (t, a, b) => f(f(a) + f(f(t) * f(f(b) - f(a))));
function duration(value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Native fog effect duration requires a source int.');
  return value;
}
function partial(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Native fog effect partial tick is outside [0,1].');
  return f(value);
}
const endsWithin = (time, ticks) => time !== -1 && time <= ticks;
export function nativeNightVisionScale(remainingDuration, partialTick = 0, version = '1.20.4') {
  const time = duration(remainingDuration), at = partial(partialTick);
  if (!endsWithin(time, 200)) return 1;
  const angle = f(f(f(f(time) - at) * f(Math.PI)) * f(.2));
  return f(f(.7) + f(nativeEnvironmentSin(angle, version) * f(.3)));
}
function sourceFloat(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isFinite(result) || !Number.isFinite(f(result))) throw new Error('Native darkness factor requires finite source floats.');
  return f(result);
}
function sourceCounter(value, fallback = 0) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > 2147483647) throw new Error('Native darkness factor counter requires a nonnegative source int.');
  return result;
}
export class NativeDarknessFactor {
  constructor({ version = '1.20.4', factorData, shouldBlend = true, remainingDuration = -1 } = {}) {
    if (!['1.20.4', '1.21.11', '26.1'].includes(version)) throw new Error('Unsupported native darkness version.');
    this.version = version;
    if (version === '1.20.4') {
      this.present = factorData !== null;
      const data = factorData ?? {};
      this.padding = sourceCounter(data.padding_duration, 22);
      this.start = sourceFloat(data.factor_start, 0); this.target = sourceFloat(data.factor_target, 1);
      this.current = sourceFloat(data.factor_current, 0); this.previous = sourceFloat(data.factor_previous_frame, 0);
      this.ticks = sourceCounter(data.ticks_active); this.hadEffect = data.had_effect_last_tick ?? false;
      if (typeof this.hadEffect !== 'boolean') throw new Error('Native darkness factor requires its source boolean.');
    } else {
      this.present = true; this.current = this.previous = 0;
      if (shouldBlend === false) this.setImmediate(remainingDuration);
    }
  }
  tick(remainingDuration) {
    const time = duration(remainingDuration); if (!this.present) return;
    this.previous = this.current;
    if (this.version === '1.20.4') {
      const active = !endsWithin(time, this.padding); this.ticks = this.ticks + 1 | 0;
      if (active !== this.hadEffect) {
        this.hadEffect = active; this.ticks = 0; this.start = this.current; this.target = active ? 1 : 0;
      }
      // Padding0 is accepted by the original codec; preserve its division
      // semantics rather than silently replacing it with a positive duration.
      this.current = lerp(clamp(f(f(this.ticks) / f(this.padding)), 0, 1), this.start, this.target);
    } else {
      const target = endsWithin(time, 22) ? 0 : 1;
      if (this.current !== target) this.current = f(this.current + clamp(f(target - this.current), -f(1 / 22), f(1 / 22)));
    }
  }
  sample(partialTick = 0, { removed = false } = {}) {
    const at = partial(partialTick); if (!this.present) return 0;
    if (removed) this.previous = this.current;
    return lerp(at, this.previous, this.current);
  }
  setImmediate(remainingDuration) {
    const time = duration(remainingDuration);
    if (this.version === '1.20.4') throw new Error('Immediate blending belongs to the modern native effect.');
    this.current = this.previous = endsWithin(time, 22) ? 0 : 1;
  }
  copyFrom(previous) {
    if (!(previous instanceof NativeDarknessFactor) || previous.version !== this.version) throw new Error('Native darkness blend state requires a matching source version.');
    if (this.version === '1.20.4') throw new Error('Legacy packet factor data replaces the previous state.');
    this.current = previous.current; this.previous = previous.previous;
  }
  snapshot() {
    if (this.version !== '1.20.4') return { factor: this.current, factorPreviousFrame: this.previous };
    return this.present ? { padding_duration: this.padding, factor_start: this.start, factor_target: this.target,
      factor_current: this.current, ticks_active: this.ticks, factor_previous_frame: this.previous, had_effect_last_tick: this.hadEffect } : null;
  }
}
