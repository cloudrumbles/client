const TYPES = Object.freeze({ water:1,lava:2,'powder-snow':3,none:4 });

// Native FogRenderer combines its colors in source RGB. Convert the final
// result once, after those source calculations, for this linear HDR pipeline.
export function nativeFogColorToLinear(color) {
  if (!color || color.length !== 3 || !Array.from(color).every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('Environment fog requires three native RGB components in 0..1.');
  return Array.from(color,value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
}

export function admitEnvironmentFog(input) {
  if (input === null || input === undefined) return null;
  if (!Object.hasOwn(TYPES,input.type)) throw new Error('Environment fog type must be water, lava, powder-snow, or none.');
  if (input.colorEncoding !== 'native-rgb') throw new Error('Environment fog colorEncoding must explicitly be native-rgb.');
  const color = nativeFogColorToLinear(input.color), sourceColor=Array.from(input.color);
  const ranges = { start:input.start,end:input.end,skyEnd:input.skyEnd ?? input.end,
    renderStart:input.renderStart ?? 0,renderEnd:input.renderEnd ?? 0 };
  if (!Object.values(ranges).every(value => Number.isFinite(value) && Number.isFinite(Math.fround(value)))) throw new Error('Environment fog distances must be finite.');
  if (!['sphere','cylinder'].includes(input.shape ?? 'sphere')) throw new Error('Environment fog shape must be sphere or cylinder.');
  return { ...ranges,type:input.type,code:TYPES[input.type],color,sourceColor,colorEncoding:'linear-hdr',sourceColorEncoding:'native-rgb',
    shape:input.shape ?? 'sphere',separateRenderDistance:Boolean(input.separateRenderDistance),immersed:input.type !== 'none' };
}
