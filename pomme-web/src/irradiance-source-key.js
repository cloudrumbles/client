// Content identity survives world reopen and time commands. Algorithm/material
// changes and native voxel/light/source-band changes select different entries.
const algorithm = 'pomme-irradiance-half-rgb-v2';
const encoder = new TextEncoder();
async function digest(parts) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0; for (const part of parts) { bytes.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at); at += part.byteLength; }
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
export function irradianceMaterialKey(tables) {
  return digest([encoder.encode(algorithm), tables.opacity, tables.emission, tables.albedo, tables.emissionColor]);
}
export function irradianceSourceKey(snapshot, materialKey) {
  return digest([encoder.encode(JSON.stringify([algorithm, materialKey, snapshot.origin, snapshot.dimensions, snapshot.hasSkylight])), snapshot.states, snapshot.known, snapshot.sky, snapshot.block]);
}
