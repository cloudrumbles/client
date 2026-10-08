// Native atmospheric fog color arithmetic. Spatial biome/attribute inputs are
// supplied by the matching source-version probe; RGB bytes remain source RGB.
import { nativeEnvironmentSin, nativeEnvironmentCos } from './environment-easing.js';
import { nativeFogColorLerp } from './environment-probe.js';
const f = Math.fround, clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rgb = value => [value >>> 16 & 255, value >>> 8 & 255, value & 255];
const packed = (value, channels) => ((value & 0xff000000) | channels[0] << 16 | channels[1] << 8 | channels[2]) >>> 0;
const scale = (value, factors) => packed(value, rgb(value).map((channel, axis) => clamp(Math.trunc(f(f(channel) * factors[axis])), 0, 255)));
export function nativeAtmosphericWeatherColor(color, rain = 0, thunder = 0) {
  let value = color >>> 0;
  if (rain > 0) { const dark = f(1 - f(f(rain) * f(.5))), blue = f(1 - f(f(rain) * f(.4))); value = scale(value, [dark, dark, blue]); }
  if (thunder > 0) { const dark = f(1 - f(f(thunder) * f(.5))); value = scale(value, [dark, dark, dark]); }
  return value;
}
export function nativeModernAtmosphericColor({ fogColor = 0, skyColor = 0, sunAngle = 0, sunriseSunsetColor = 0,
  skyFogEnd = 512, renderDistanceChunks = 8, forward = [0, 0, -1], rain = 0, thunder = 0, version = '1.21.11' } = {}) {
  let value = (fogColor | 0xff000000) >>> 0;
  if (renderDistanceChunks >= 4) {
    const angle = f(f(sunAngle) * f(Math.PI / 180)), axis = nativeEnvironmentSin(angle, version) > 0 ? -1 : 1;
    const toward = f(f(forward[0]) * axis), alpha = f((sunriseSunsetColor >>> 24) / 255);
    if (toward > 0 && alpha > 0) value = nativeFogColorLerp(f(toward * alpha), value, (sunriseSunsetColor | 0xff000000) >>> 0);
  }
  const sky = nativeAtmosphericWeatherColor(skyColor | 0xff000000, rain, thunder);
  const distance = Math.min(f(f(skyFogEnd) / 16), f(renderDistanceChunks)), amount = clamp(f(distance / 32), 0, 1);
  const base = f(f(.25) + f(amount * f(.75))), mix = f(1 - f(base ** .25));
  value = nativeFogColorLerp(mix, value, sky);
  return rgb(value).map(channel => f(channel / 255));
}
export function nativeLegacyTimeOfDay(dayTime, fixedTime) {
  const phase = Number(fixedTime ?? dayTime) / 24000 - .25, fraction = phase - Math.floor(phase);
  return f(f(fraction * 2 + .5 - Math.cos(fraction * Math.PI) / 2) / 3);
}
export function nativeLegacySunriseColor(timeOfDay, dimension = 'minecraft:overworld') {
  if (dimension.endsWith('the_end')) return null;
  const wave = nativeEnvironmentCos(f(f(timeOfDay) * f(Math.PI * 2)), '1.20.4');
  if (wave < -f(.4) || wave > f(.4)) return null;
  const t = f(f(f(wave / f(.4)) * f(.5)) + f(.5));
  const alpha = f(1 - f(f(1 - nativeEnvironmentSin(f(t * f(Math.PI)), '1.20.4')) * f(.99)));
  return [f(f(t * f(.3)) + f(.7)), f(f(f(t * t) * f(.7)) + f(.2)), f(.2), f(alpha * alpha)];
}
export function nativeLegacyFogBrightness(timeOfDay, dimension = 'minecraft:overworld') {
  const angle = f(f(timeOfDay) * f(Math.PI * 2)), light = f(clamp(f(f(nativeEnvironmentCos(angle, '1.20.4') * 2) + f(.5)), 0, 1));
  return [0, 1, 2].map(axis => dimension.endsWith('the_nether') ? 1 : dimension.endsWith('the_end') ? f(.15) : f(f(light * f(axis === 2 ? .91 : .94)) + f(axis === 2 ? .09 : .06)));
}
export function nativeLegacyAtmosphericColor({ fogColor, skyColor, timeOfDay = 0, renderDistanceChunks = 8,
  forward = [0, 0, -1], rain = 0, thunder = 0, skyFlash = 0, partialTick = 0, dimension = 'minecraft:overworld', fogBrightnessApplied = false } = {}) {
  const angle = f(f(timeOfDay) * f(Math.PI * 2));
  const light = f(clamp(f(f(nativeEnvironmentCos(angle, '1.20.4') * 2) + f(.5)), 0, 1));
  const factors = nativeLegacyFogBrightness(timeOfDay, dimension);
  let color = fogColor.map((value, axis) => fogBrightnessApplied ? value : value * factors[axis]);
  color = color.map(f);
  let sky = skyColor.map(value => f(f(value) * light));
  const gray = factor => f(f(f(f(sky[0] * f(.3)) + f(sky[1] * f(.59))) + f(sky[2] * f(.11))) * f(factor));
  for (const [level, intensity] of [[rain, .6], [thunder, .2]]) if (level > 0) {
    const neutral = gray(intensity), remaining = f(1 - f(f(level) * f(.75)));
    sky = sky.map(value => f(f(value * remaining) + f(neutral * f(1 - remaining))));
  }
  if (skyFlash > 0) { const blend = f(Math.min(1, f(f(skyFlash) - f(partialTick))) * f(.45)); sky = sky.map((value, axis) => f(f(value * f(1 - blend)) + f(f(axis === 2 ? 1 : .8) * blend))); }
  if (renderDistanceChunks >= 4) {
    const axis = nativeEnvironmentSin(angle, '1.20.4') > 0 ? -1 : 1, toward = Math.max(0, f(f(forward[0]) * axis));
    const sunrise = toward > 0 ? nativeLegacySunriseColor(timeOfDay, dimension) : null;
    if (sunrise) { const amount = f(toward * sunrise[3]); color = color.map((value, i) => f(f(value * f(1 - amount)) + f(sunrise[i] * amount))); }
  }
  const base = f(f(.25) + f(f(.75) * f(f(renderDistanceChunks) / 32))), mix = f(1 - f(base ** .25));
  color = color.map((value, axis) => f(value + f(f(sky[axis] - value) * mix)));
  if (rain > 0) { const dark = f(1 - f(f(rain) * f(.5))), blue = f(1 - f(f(rain) * f(.4))); color = color.map((value, axis) => f(value * (axis === 2 ? blue : dark))); }
  if (thunder > 0) { const dark = f(1 - f(f(thunder) * f(.5))); color = color.map(value => f(value * dark)); }
  return color;
}
