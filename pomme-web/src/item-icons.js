const qualify = (name) => name.includes(':') ? name : `minecraft:${name}`;

export class ItemIcons {
  constructor(atlas, materials, registry) {
    this.atlas = atlas; this.materials = materials; this.registry = registry;
    this.cache = new Map(); this.textureCache = new Map();
    this.blocks = new Map((registry?.blocks || []).map((block) => [block.name, block]));
  }

  texture(id) {
    if (this.textureCache.has(id)) return this.textureCache.get(id);
    const tile = this.atlas.tiles[id]; if (!tile) return null;
    const canvas = document.createElement('canvas'); canvas.width = tile.width; canvas.height = tile.height;
    const rgba = new Uint8ClampedArray(tile.width * tile.height * 4);
    for (let y = 0; y < tile.height; y++) {
      const start = ((tile.y + y) * this.atlas.width + tile.x) * 4;
      rgba.set(this.atlas.pixelsRGBA.subarray(start, start + tile.width * 4), y * tile.width * 4);
    }
    canvas.getContext('2d').putImageData(new ImageData(rgba, tile.width, tile.height), 0, 0);
    this.textureCache.set(id, canvas); return canvas;
  }

  sprite(name, seen = new Set()) {
    name = qualify(name);
    if (seen.has(name)) return null; seen.add(name);
    const [namespace, path] = name.split(':');
    let tile = this.atlas.itemTiles?.get(`${namespace}:item/${path}`);
    const model = this.atlas.itemModels?.get(name);
    if (model?.textures?.layer0) tile = this.atlas.tileByName?.get(qualify(model.textures.layer0));
    if (tile !== undefined) return this.texture(tile);
    const parent = model?.parent;
    if (parent && /(?:^|:)item\//.test(parent)) return this.sprite(qualify(parent).replace(':item/', ':'), seen);
    return null;
  }

  blockIcon(material) {
    const quads = material?.model?.quads;
    if (!quads?.length) return null;
    const size = 40, pixels = new Uint8ClampedArray(size * size * 4), depth = new Float32Array(size * size).fill(-Infinity);
    const project = ([x, y, z]) => [20 + (x - z) * 16, 26 + (x + z - 1) * 8 - y * 24, x + z + y * 0.7];
    for (const quad of quads) {
      if (quad.normal[0] + quad.normal[1] * 0.7 + quad.normal[2] <= 0.001) continue;
      const tile = this.atlas.tiles[quad.tile]; if (!tile || quad.tile === 0) continue;
      const vertices = quad.positions.map(project), tint = quad.tint || [1, 1, 1];
      const shade = 0.6 + Math.max(0, quad.normal[1]) * 0.4 + Math.max(0, quad.normal[0]) * 0.15;
      for (const triangle of [[0, 1, 2], [0, 2, 3]]) {
        const [a, b, c] = triangle.map((index) => vertices[index]);
        const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(denominator) < 1e-6) continue;
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const wa = ((b[1] - c[1]) * (x + 0.5 - c[0]) + (c[0] - b[0]) * (y + 0.5 - c[1])) / denominator;
          const wb = ((c[1] - a[1]) * (x + 0.5 - c[0]) + (a[0] - c[0]) * (y + 0.5 - c[1])) / denominator, wc = 1 - wa - wb;
          if (Math.min(wa, wb, wc) < -0.0001) continue;
          const distance = wa * a[2] + wb * b[2] + wc * c[2], pixel = y * size + x;
          if (distance < depth[pixel] - 0.0001) continue;
          const weights = [wa, wb, wc], uv = [0, 0];
          for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 2; axis++) uv[axis] += weights[corner] * quad.uvs[triangle[corner]][axis];
          const tx = tile.x + Math.min(tile.width - 1, Math.max(0, Math.floor((uv[0] - Math.floor(uv[0])) * tile.width)));
          const ty = tile.y + Math.min(tile.height - 1, Math.max(0, Math.floor((uv[1] - Math.floor(uv[1])) * tile.height)));
          const source = (ty * this.atlas.width + tx) * 4;
          if (this.atlas.pixelsRGBA[source + 3] < 64) continue;
          for (let channel = 0; channel < 3; channel++) pixels[pixel * 4 + channel] = this.atlas.pixelsRGBA[source + channel] * tint[channel] * shade;
          pixels[pixel * 4 + 3] = this.atlas.pixelsRGBA[source + 3]; depth[pixel] = distance;
        }
      }
    }
    if (!pixels.some((value, index) => index % 4 === 3 && value)) return null;
    const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(pixels, size, size), 0, 0); return canvas;
  }

  url(item) {
    if (!item) return null;
    if (this.cache.has(item.name)) return this.cache.get(item.name);
    let image = this.sprite(item.name);
    if (!image) {
      const block = this.blocks.get(item.name), material = block && this.materials?.get(block.defaultState);
      image = this.blockIcon(material);
      if (!image) {
        const tile = this.atlas.tileByName?.get(`minecraft:block/${item.name}`);
        if (tile !== undefined && tile !== 0) image = this.texture(tile);
      }
    }
    const url = image?.toDataURL('image/png') || null; this.cache.set(item.name, url); return url;
  }
}
