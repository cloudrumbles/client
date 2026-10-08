import { zlibSync } from '../vendor/fflate.js';

export function rgbaPNG(width, height, pixels) {
  const join = arrays => { const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0)); let offset = 0; for (const array of arrays) { result.set(array, offset); offset += array.length; } return result; };
  const chunk = (type, data) => {
    const bytes = join([new TextEncoder().encode(type), data]); let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const result = new Uint8Array(data.length + 12), view = new DataView(result.buffer);
    view.setUint32(0, data.length); result.set(bytes, 4); view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0); return result;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const rows = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(rows)), chunk('IEND', new Uint8Array())]);
}

export const textureProfile = (uuid, url, slim = false) => ({ uuid, player: { name: 'Fixture', properties: [{ name: 'textures', value: btoa(JSON.stringify({ textures: { SKIN: { url, metadata: slim ? { model: 'slim' } : {} } } })) }] } });
