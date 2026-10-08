import { EnvironmentFog, cameraNearPlane, cameraFogType } from './environment-fog.js';
import { NativeFogAttributeProbe, createFogBiomeLookup } from './environment-probe.js';
import { NativeDarknessFactor, nativeNightVisionScale } from './environment-effects.js';
import { nativeModernAtmosphericColor, nativeLegacyAtmosphericColor, nativeLegacyTimeOfDay, nativeLegacyFogBrightness } from './environment-atmosphere.js';
import { fluidState } from './movement.js';

/** Native FluidState.getHeight returns1 when the same fluid occupies above. */
export function createFogBlockSampler({ core, materials, registry } = {}) {
  return (x, y, z) => {
    const id = core.block_get(x, y, z), material = materials?.get(id), flags = core.block_flags?.(id) ?? material?.flags ?? 0;
    const fluid = fluidState(material, flags);
    if (fluid.kind) {
      const aboveId = core.block_get(x, y + 1, z), above = materials?.get(aboveId);
      if (fluidState(above, core.block_flags?.(aboveId) ?? above?.flags ?? 0).kind === fluid.kind) fluid.height = 1;
    }
    const name = material?.name ?? registry?.blocks.find(block => id >= block.minStateId && id <= block.maxStateId)?.name;
    return { name, fluid };
  };
}

export class EnvironmentRuntime {
  constructor({ version = '1.20.4' } = {}) { this.version = version; this.fog = new EnvironmentFog({ version }); this.reset(); }
  reset() { this.fog.reset(); this.probe?.reset(); this.darkness = null; this.darknessSource = null; this.sourceErrors = []; this.lastSample = null; }
  configure({ world, registry, atlas, registries = new Map(), dimensionId = 'minecraft:overworld', dimensionName = dimensionId, dimension, biomeTags } = {}) {
    this.world = world; this.registry = registry;
    const sources = atlas?.environmentSources, sourceDimension = dimension ?? sources?.dimensions.get(dimensionId);
    this.sampleBlock = createFogBlockSampler({ core: world.core, registry, materials: world.materialRegistry?.materials ?? atlas?.materials });
    const getNoiseBiome = createFogBiomeLookup({ world, registry, registries, definitions: atlas?.biomeDefinitions });
    this.sourceErrors = [];
    const closerWaterFog = biomeTags ? biome => biomeTags.has(biome?.id) : sources?.biomeTags.has('minecraft:has_closer_water_fog')
      ? biome => sources.biomeHasTag('minecraft:has_closer_water_fog', biome?.name) : undefined;
    this.dimension = sourceDimension;
    this.dimensionId = dimensionId;
    this.canHaveWeather = Boolean(world.hasSkylight ?? sourceDimension?.has_skylight ?? true) && !sourceDimension?.has_ceiling && dimensionName !== 'minecraft:the_end';
    const timelines = new Map(sources?.timelines ?? []);
    for (const [index, entry] of (registries.get('minecraft:timeline') ?? []).entries()) {
      const name = entry.key ?? entry.name, value = entry.value ?? entry.element;
      if (typeof name === 'string' && value) timelines.set(name, value);
      if (index >= 4095) break;
    }
    try {
      this.probe = new NativeFogAttributeProbe({ version: this.version, seed: world.biomeSeed ?? 0n, getNoiseBiome, dimensionId,
        dimensionAttributes: sourceDimension?.attributes, timelines: sourceDimension?.timelines ?? [], timelineDefinitions: timelines, timelineTags: sources?.timelineTags, closerWaterFog });
    } catch (error) {
      this.sourceErrors.push(error.message);
      this.probe = new NativeFogAttributeProbe({ version: this.version, seed: world.biomeSeed ?? 0n, getNoiseBiome, dimensionId: 'unavailable:source', closerWaterFog });
    }
  }
  syncEffects(player, sourceEffects = [], simplify = value => value) {
    const current = player.effects?.get('darkness'), source = sourceEffects.find(effect => effect.name?.replace(/^minecraft:/, '') === 'darkness') ?? current;
    if (!current) { this.darkness = null; this.darknessSource = null; return; }
    if (source === this.darknessSource) return;
    const previous = this.darkness;
    const factorData = source && Object.hasOwn(source, 'factorData') ? source.factorData === null ? null : simplify(source.factorData) : undefined;
    this.darkness = new NativeDarknessFactor({ version: this.version, factorData, shouldBlend: source?.shouldBlend, remainingDuration: current.duration });
    if (previous && this.version !== '1.20.4') this.darkness.copyFrom(previous);
    this.darknessSource = source;
  }
  tick(player, { dayTime = 0n, clocks, weather, spectator = false, sourceEffects = [], simplify } = {}) {
    this.syncEffects(player, sourceEffects, simplify);
    this.fog.step({ eyesInWater: player.eyesInWater, spectator });
    const effect = player.effects?.get('darkness'); if (effect) this.darkness?.tick(effect.duration);
    this.probe.tick({ position: player.eye, playerPosition: player.position, dayTime, clocks, weather: this.weatherState(weather) });
  }
  weatherState(weather = {}) {
    const clamp = value => Math.fround(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)));
    const rain = clamp(weather.rainLevel), thunder = Math.fround(clamp(weather.thunderLevel) * rain);
    return this.canHaveWeather ? { rain, thunder } : { rain: 0, thunder: 0 };
  }
  sample(player, { partialTick = 0, nowMs = 0, farPlane = 128, renderDistanceChunks = 8, aspect = 1, fov = 70, spectator = false, voidRange = 32, dayTime = 0n, weather, skyFlash = 0 } = {}) {
    if (!this.probe?.position) this.probe?.tick({ position: player.eye, playerPosition: player.position, dayTime, weather: this.weatherState(weather) });
    const yaw = player.yaw, pitch = player.pitch, right = [Math.cos(yaw), 0, Math.sin(yaw)];
    const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    const type = cameraFogType(player.eye, this.sampleBlock, cameraNearPlane({ forward: player.direction, right, up, fov, aspect }));
    // Native client hasEffect checks the synchronized map. Client ticks can
    // reach zero before the server's remove-effect packet arrives.
    const active = name => player.effects?.get(name) ?? null;
    const night = active('night_vision'), dark = active('darkness'), blind = active('blindness');
    let attributes, atmosphericColor;
    try {
      attributes = this.probe.sample(partialTick);
      if (type === 'none' && (blind || dark)) {
        const nativeWeather = this.weatherState(weather), parameters = { ...nativeWeather, forward: player.direction, renderDistanceChunks, partialTick, skyFlash };
        if (this.version === '1.20.4') {
          const timeOfDay = nativeLegacyTimeOfDay(this.probe.dayTime, this.dimension?.fixed_time), dimension = this.dimension?.effects ?? this.dimensionId;
          atmosphericColor = nativeLegacyAtmosphericColor({ ...this.probe.sampleLegacyAtmosphere(nativeLegacyFogBrightness(timeOfDay, dimension)), ...parameters, dimension, timeOfDay });
        } else {
          const atmosphere = this.probe.sampleAtmosphere(partialTick);
          atmosphericColor = nativeModernAtmosphericColor({ ...atmosphere, ...parameters, version: this.version });
        }
        attributes = { ...attributes, resolved: this.probe.diagnostics.length === 0, diagnostics: this.probe.diagnostics.slice() };
      }
    }
    catch (error) { if (!this.sourceErrors.includes(error.message) && this.sourceErrors.length < 32) this.sourceErrors.push(error.message); attributes = { resolved: false, diagnostics: this.sourceErrors.slice(0, 32) }; }
    this.lastSample = this.fog.sample({ type, ...attributes, nowMs, farPlane, spectator, eyesInWater: player.eyesInWater,
      atmosphericColor,
      eyeY: player.eye[1], minY: this.world.core.world_min_y(), voidRange,
      fireResistance: Boolean(active('fire_resistance')), blindnessDuration: blind?.duration ?? null,
      hasDarkness: Boolean(dark), darknessFactor: dark ? this.darkness?.sample(partialTick) ?? 0 : 0,
      darknessFactorPresent: this.darkness?.present ?? true,
      nightVisionScale: night ? nativeNightVisionScale(night.duration, partialTick, this.version) : 0 });
    this.lastAttributes = { ...attributes, resolved: attributes.resolved && this.sourceErrors.length === 0, diagnostics: [...(attributes.diagnostics ?? []), ...this.sourceErrors].slice(0, 32) };
    return this.lastSample;
  }
  stats() { return { version: this.version, waterVisionTime: this.fog.waterVisionTime, attributes: this.lastAttributes ?? null, fog: this.lastSample,
    darkness: this.darkness?.snapshot() ?? null }; }
}
