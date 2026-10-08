import { decodePNG } from './assets.js';

const DEFAULT_NAMES = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];

export function defaultPlayerSkin(uuid) {
  const digits = `${uuid || ''}`.replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(digits)) return { path: 'minecraft:entity/player/wide/steve', slim: false };
  let hash = 0;
  for (let start = 0; start < 32; start += 8) hash ^= Number.parseInt(digits.slice(start, start + 8), 16);
  const index = ((hash % 18) + 18) % 18, slim = index < 9;
  return { path: `minecraft:entity/player/${slim ? 'slim' : 'wide'}/${DEFAULT_NAMES[index % 9]}`, slim };
}

export function profileSkin(player) {
  const properties = player?.player?.properties || player?.properties || [];
  const encoded = properties.find(property => property.name === 'textures')?.value;
  if (typeof encoded !== 'string' || encoded.length > 32768) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const skin = profile.textures?.SKIN;
    if (typeof skin?.url !== 'string' || skin.url.length > 512) return null;
    const url = new URL(skin.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || url.port || url.username || url.password || url.search || url.hash || !/^\/texture\/[a-f0-9]{40,64}$/i.test(url.pathname)) return null;
    url.protocol = 'https:';
    return { url: url.href, slim: skin.metadata?.model === 'slim' };
  } catch { return null; }
}

export function normalizePlayerSkin(image) {
  if (!(image?.pixelsRGBA instanceof Uint8Array) || image.width !== 64 || ![32, 64].includes(image.height) || image.pixelsRGBA.length !== image.width * image.height * 4) throw new Error('Player skin must be 64×32 or 64×64 RGBA.');
  const pixelsRGBA = new Uint8Array(64 * 64 * 4);
  pixelsRGBA.set(image.pixelsRGBA);
  const alpha = (x0, y0, x1, y1, value) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) pixelsRGBA[(y * 64 + x) * 4 + 3] = value;
  };
  if (image.height === 32) {
    const mirror = (dx0, dy0, dx1, dy1, sx0, sy0, sx1, sy1) => {
      for (let y = dy0; y < dy1; y++) for (let x = dx1; x < dx0; x++) {
        const sx = sx1 - 1 - (x - dx1), sy = sy0 + y - dy0;
        pixelsRGBA.set(image.pixelsRGBA.subarray((sy * 64 + sx) * 4, (sy * 64 + sx) * 4 + 4), (y * 64 + x) * 4);
      }
    };
    for (const rectangle of [[24, 48, 20, 52, 4, 16, 8, 20], [28, 48, 24, 52, 8, 16, 12, 20], [20, 52, 16, 64, 8, 20, 12, 32], [24, 52, 20, 64, 4, 20, 8, 32], [28, 52, 24, 64, 0, 20, 4, 32], [32, 52, 28, 64, 12, 20, 16, 32], [40, 48, 36, 52, 44, 16, 48, 20], [44, 48, 40, 52, 48, 16, 52, 20], [36, 52, 32, 64, 48, 20, 52, 32], [40, 52, 36, 64, 44, 20, 48, 32], [44, 52, 40, 64, 40, 20, 44, 32], [48, 52, 44, 64, 52, 20, 56, 32]]) mirror(...rectangle);
    let opaqueHat = true;
    for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) if (pixelsRGBA[(y * 64 + x) * 4 + 3] < 128) opaqueHat = false;
    if (opaqueHat) alpha(32, 0, 64, 32, 0);
  }
  alpha(0, 0, 32, 16, 255);
  alpha(0, 16, 64, 32, 255);
  alpha(16, 48, 48, 64, 255);
  return { width: 64, height: 64, pixelsRGBA };
}

export class PlayerSkinCache {
  constructor({ appendTile, fetchSkin = globalThis.fetch?.bind(globalThis), onReady = () => {}, maxSkins = 64 } = {}) {
    this.appendTile = appendTile; this.fetchSkin = fetchSkin; this.onReady = onReady;
    this.maxSkins = Math.max(1, Math.min(128, Math.floor(maxSkins)));
    this.skins = new Map(); this.controllers = new Set(); this.generation = 0;
  }

  request(player) {
    const skin = profileSkin(player);
    if (!skin || !this.appendTile || !this.fetchSkin) return null;
    if (this.skins.has(skin.url)) return { ...this.skins.get(skin.url), slim: skin.slim };
    if (this.skins.size >= this.maxSkins) return null;
    const entry = { state: 'loading', tile: null };
    this.skins.set(skin.url, entry);
    const controller = new AbortController(), generation = this.generation;
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    entry.promise = (async () => {
      try {
        const response = await this.fetchSkin(skin.url, { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
        if (!response.ok) throw new Error(`Skin HTTP ${response.status}`);
        const length = Number(response.headers?.get('content-length'));
        if (length > 1048576) throw new Error('Player skin exceeds 1 MB.');
        let bytes;
        if (response.body?.getReader) {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 1048576) { await reader.cancel(); throw new Error('Player skin exceeds 1 MB.'); }
            chunks.push(next.value);
          }
          bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        } else bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 1048576) throw new Error('Player skin exceeds 1 MB.');
        const image = normalizePlayerSkin(decodePNG(bytes, { maxPixels: 4096 }));
        if (generation !== this.generation) return;
        const tile = await this.appendTile(image, { name: `minecraft:profile/${skin.url.split('/').at(-1)}` });
        if (generation !== this.generation) return;
        if (!Number.isInteger(tile?.id ?? tile)) throw new Error('Skin atlas did not return a tile ID.');
        entry.tile = tile.id ?? tile; entry.state = 'ready'; this.onReady(skin.url);
      } catch (error) { entry.state = 'failed'; entry.error = error.message; }
      finally { clearTimeout(timeout); this.controllers.delete(controller); }
    })();
    return { ...entry, slim: skin.slim };
  }

  clear() {
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.skins.clear();
  }
}
