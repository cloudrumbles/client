import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { zipSync, zlibSync } from '../vendor/fflate.js';

// This isolated proof exercises the overlay's explicit GPU sink contract.
// Production main/renderer integration is tested separately. A private original
// JAR can supply source textures/models; the default archive is our own fixture.
const encode = new TextEncoder();
const join = arrays => { const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0)); let at = 0; for (const array of arrays) { out.set(array, at); at += array.length; } return out; };
function crc(bytes) { let c = 0xffffffff; for (const byte of bytes) { c ^= byte; for (let i = 0; i < 8; i++) c = c >>> 1 ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function pngChunk(name, data) { const payload = join([encode.encode(name), data]), out = new Uint8Array(data.length + 12), view = new DataView(out.buffer); view.setUint32(0, data.length); out.set(payload, 4); view.setUint32(out.length - 4, crc(payload)); return out; }
function png(pixels) {
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, 16); view.setUint32(4, 16); header[8] = 8; header[9] = 6;
  const rows = new Uint8Array(16 * 65); for (let y = 0; y < 16; y++) rows.set(pixels.subarray(y * 64, y * 64 + 64), y * 65 + 1);
  return join([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlibSync(rows)), pngChunk('IEND', new Uint8Array())]);
}
function fixturePack() {
  const files = {}, faces = Object.fromEntries(['east', 'west', 'up', 'down', 'south', 'north'].map(face => [face, { texture: '#all', cullface: face }]));
  const model = (from, to) => ({ textures: { all: 'minecraft:block/fixture' }, elements: [{ from, to, faces }] });
  const checker = new Uint8Array(16 * 16 * 4); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) checker.set([200, 180, 160, (x + y) % 2 ? 255 : 0], (y * 16 + x) * 4);
  files['assets/minecraft/textures/block/fixture.png'] = png(checker);
  files['assets/minecraft/models/block/stone.json'] = model([0, 0, 0], [16, 16, 16]);
  files['assets/minecraft/models/block/slab.json'] = model([0, 0, 0], [16, 8, 16]);
  files['assets/minecraft/models/block/flower.json'] = { textures: { all: 'minecraft:block/fixture' }, elements: [
    { from: [2, 0, 8], to: [14, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45 }, faces: { north: { texture: '#all' }, south: { texture: '#all' } } },
    { from: [2, 0, 8], to: [14, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: -45 }, faces: { north: { texture: '#all' }, south: { texture: '#all' } } },
  ] };
  files['assets/minecraft/blockstates/stone.json'] = { variants: { '': { model: 'minecraft:block/stone' } } };
  files['assets/minecraft/blockstates/oak_slab.json'] = { variants: { 'type=bottom': { model: 'minecraft:block/slab' }, 'type=top': { model: 'minecraft:block/slab', x: 180 } } };
  files['assets/minecraft/blockstates/dandelion.json'] = { variants: { '': { model: 'minecraft:block/flower' } } };
  for (let stage = 0; stage < 10; stage++) {
    const pixels = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels.set((x + y * 3) % (12 - stage) === 0 ? [32, 48, 64, 255] : [128, 128, 128, 255], (y * 16 + x) * 4);
    files[`assets/minecraft/textures/block/destroy_stage_${stage}.png`] = png(pixels);
  }
  return zipSync(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, value instanceof Uint8Array ? value : encode.encode(JSON.stringify(value))])));
}
const version = process.env.POMME_MINECRAFT_VERSION ?? '1.20.4', source = process.env.POMME_MINECRAFT_JAR;
const original = source ? await readFile(source) : Buffer.from(fixturePack()), software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } }); page.setDefaultTimeout(180000);
  await page.route('**/__breaking-pack.zip', route => { console.log('Serving local breaking assets.'); return route.fulfill({ status: 200, contentType: 'application/zip', body: original }); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); else if (message.text().startsWith('breaking proof:')) console.log(message.text()); });
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async ({ version, native }) => {
    const [{ BreakingOverlay, CRUMBLING_RENDER_STATE }, { loadResourcePack }, { loadMinecraftRegistry }, { registryStates }] = await Promise.all([
      import('/src/breaking-overlay.js'), import('/src/assets.js'), import('/src/registry.js'), import('/src/anvil.js'),
    ]);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const deadline = (promise, label, ms = 30000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} stalled.`)), ms))]);
    console.log('breaking proof: requesting adapter');
    const adapter = await deadline(navigator.gpu?.requestAdapter(), 'Adapter'); check(adapter, 'WebGPU adapter unavailable.');
    const device = await deadline(adapter.requestDevice(), 'Device'), gpuErrors = []; device.addEventListener('uncapturederror', event => { gpuErrors.push(event.error.message); console.log(`breaking proof: GPU validation ${event.error.message}`); });
    const nativeRegistry = await loadMinecraftRegistry({ url: `/data/${version}-registry.json` });
    const registry = native ? { ...nativeRegistry, blocks: nativeRegistry.blocks.filter(block => ['air', 'stone', 'oak_slab', 'dandelion'].includes(block.name)) }
      : { blocks: [{ name: 'air', minStateId: 0, maxStateId: 0, boundingBox: 'empty' }, { name: 'stone', minStateId: 1, maxStateId: 1, boundingBox: 'block' },
        { name: 'oak_slab', minStateId: 2, maxStateId: 3, boundingBox: 'block', states: [{ name: 'type', values: ['bottom', 'top'] }] }, { name: 'dandelion', minStateId: 4, maxStateId: 4, boundingBox: 'empty' }] };
    console.log('breaking proof: loading user pack');
    const assetBytes = new Uint8Array(await deadline((await deadline(fetch('/__breaking-pack.zip'), 'Asset fetch')).arrayBuffer(), 'Asset bytes'));
    const pack = await loadResourcePack(assetBytes, { registry }), states = registryStates(registry);
    console.log('breaking proof: assets baked');
    const select = (name, properties) => properties ? states.lookup(name, properties) : registry.blocks.find(block => block.name === name).defaultState ?? registry.blocks.find(block => block.name === name).minStateId;
    const stone = select('stone'), slab = select('oak_slab', native ? { type: 'bottom', waterlogged: 'false' } : { type: 'bottom' }), flower = select('dandelion');
    for (const id of [stone, slab, flower]) check(pack.materials.get(id)?.model.supported && pack.materials.get(id).templateVertices.length, `Source model ${id} unavailable.`);
    document.body.replaceChildren(); const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; canvas.style.cssText = 'width:256px;height:256px'; document.body.append(canvas);
    const display = canvas.getContext('webgpu'), displayFormat = navigator.gpu.getPreferredCanvasFormat(); display.configure({ device, format: displayFormat });
    const size = 256, hdr = device.createTexture({ size: [size, size], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    const depth = device.createTexture({ size: [size, size], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const texture = device.createTexture({ size: [pack.atlas.width, pack.atlas.height], format: 'rgba8unorm-srgb', viewFormats: ['rgba8unorm'], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture }, pack.atlas.pixelsRGBA, { bytesPerRow: pack.atlas.width * 4 }, [pack.atlas.width, pack.atlas.height]);
    const rectangles = new Uint32Array(pack.atlas.tiles.flatMap(tile => [tile.x, tile.y, tile.width, tile.height]));
    const tileBuffer = device.createBuffer({ size: rectangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(tileBuffer, 0, rectangles);
    const transform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(transform, 0, new Float32Array([0, 0, 0, 0]));
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var atlas: texture_2d<f32>;
      @group(0) @binding(1) var<storage,read> tiles: array<vec4<u32>>;
      @group(0) @binding(2) var<uniform> transform: vec4<f32>;
      struct V { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) @interpolate(flat) tile: u32 };
      @vertex fn vertex(@location(0) p: vec3<f32>, @location(1) uv: vec2<f32>, @location(2) tile: f32) -> V {
        var out: V; let local=p+transform.xyz;
        out.clip=vec4<f32>(local.x*2.0-1.0,local.y*2.0-1.0,0.5-local.z*0.1,1.0); out.uv=uv; out.tile=u32(tile); return out;
      }
      fn texel(v:V)->vec4<f32> { let r=tiles[v.tile]; return textureLoad(atlas,vec2<i32>(r.xy+vec2<u32>(floor(fract(v.uv)*vec2<f32>(r.zw)))),0); }
      @fragment fn base(v:V)->@location(0) vec4<f32> { return vec4<f32>(0.4,0.6,0.8,1.0); }
      @fragment fn baseCutout(v:V)->@location(0) vec4<f32> { if(texel(v).a<0.1){discard;} return vec4<f32>(0.4,0.6,0.8,1.0); }
      @fragment fn crack(v:V)->@location(0) vec4<f32> { let c=texel(v); if(c.a<0.1){discard;} return c; }
    ` });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const vertexLayout = [{ arrayStride: 56, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 40, format: 'float32x2' }, { shaderLocation: 2, offset: 48, format: 'float32' }] }];
    const pipeline = (entryPoint, cracking, bias = true) => device.createRenderPipeline({ layout: pipelineLayout, vertex: { module, entryPoint: 'vertex', buffers: vertexLayout },
      fragment: { module, entryPoint, targets: [{ format: 'rgba16float', ...(cracking ? { blend: CRUMBLING_RENDER_STATE.blend } : {}) }] }, primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: !cracking, depthCompare: cracking ? CRUMBLING_RENDER_STATE.depthCompare : 'less',
        depthBias: cracking ? bias ? CRUMBLING_RENDER_STATE.depthBias : 0 : -5, depthBiasSlopeScale: cracking && bias ? CRUMBLING_RENDER_STATE.depthBiasSlopeScale : 0 } });
    const basePipeline = pipeline('base', false), cutoutPipeline = pipeline('baseCutout', false), crackPipeline = pipeline('crack', true), unbiasedPipeline = pipeline('crack', true, false);
    const textureView = texture.createView({ format: 'rgba8unorm' });
    const makeBind = uniform => device.createBindGroup({ layout, entries: [{ binding: 0, resource: textureView }, { binding: 1, resource: { buffer: tileBuffer } }, { binding: 2, resource: { buffer: uniform } }] });
    const bind = makeBind(transform), meshes = new Map(), allocations = { buffers: 0, uploads: 0, removals: 0 };
    let baseBuffer, baseCount = 0, stateId = stone, origin = [0, 0, 0], baseOrigin = [0, 0, 0], cameraOrigin = [0, 0, 0];
    const overlay = new BreakingOverlay({ materials: pack.materials, atlas: pack.atlas, version, getState: (x, y, z) => x === origin[0] && y === origin[1] && z === origin[2] ? stateId : 0,
      uploadMesh(key, vertices, bounds, options) {
        let mesh = meshes.get(key); if (!mesh || mesh.capacity < vertices.byteLength) { mesh?.buffer.destroy(); mesh?.transform.destroy();
          const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          mesh = { buffer: device.createBuffer({ size: vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }), capacity: vertices.byteLength, transform: uniform, bind: makeBind(uniform) }; allocations.buffers++; }
        device.queue.writeBuffer(mesh.buffer, 0, vertices); Object.assign(mesh, { count: vertices.length / 14, bounds, options }); meshes.set(key, mesh); allocations.uploads++;
      }, removeMesh(key) { const mesh = meshes.get(key); if (mesh) { mesh.buffer.destroy(); mesh.transform.destroy(); meshes.delete(key); allocations.removals++; } },
    });
    const setBase = id => { stateId = id; baseOrigin = [...origin]; baseBuffer?.destroy(); const v = pack.materials.get(id).templateVertices; baseBuffer = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(baseBuffer, 0, v); baseCount = v.length / 14; };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023; return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const draw = async ({ unbiased = false, cutout = false, cracks = true } = {}) => {
      // Subtract in JS Float64 before admission to the Float32 GPU uniforms.
      device.queue.writeBuffer(transform, 0, new Float32Array([...baseOrigin.map((value, axis) => value - cameraOrigin[axis]), 0]));
      for (const mesh of meshes.values()) device.queue.writeBuffer(mesh.transform, 0, new Float32Array([...mesh.options.origin.map((value, axis) => value - cameraOrigin[axis]), 0]));
      const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [{ view: hdr.createView(), clearValue: { r: 0.1, g: 0.1, b: 0.1, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setBindGroup(0, bind); pass.setPipeline(cutout ? cutoutPipeline : basePipeline); pass.setVertexBuffer(0, baseBuffer); pass.draw(baseCount);
      if (cracks) { pass.setPipeline(unbiased ? unbiasedPipeline : crackPipeline); for (const mesh of meshes.values()) { pass.setBindGroup(0, mesh.bind); pass.setVertexBuffer(0, mesh.buffer); pass.draw(mesh.count); } } pass.end();
      const colors = device.createBuffer({ size: size * size * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), depths = device.createBuffer({ size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: hdr }, { buffer: colors, bytesPerRow: size * 8 }, [size, size]); encoder.copyTextureToBuffer({ texture: depth }, { buffer: depths, bytesPerRow: size * 4 }, [size, size]); device.queue.submit([encoder.finish()]);
      await deadline(Promise.all([colors.mapAsync(GPUMapMode.READ), depths.mapAsync(GPUMapMode.READ)]), `GPU readback ${JSON.stringify(gpuErrors)}`);
      const image = new Uint16Array(colors.getMappedRange().slice(0)), depthImage = new Float32Array(depths.getMappedRange().slice(0)); colors.unmap(); colors.destroy(); depths.unmap(); depths.destroy();
      return { image, depthImage };
    };
    const pixel = (image, x, y) => Array.from(image.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)).map(half);
    const near = (actual, expected, label) => check(actual.every((value, axis) => Math.abs(value - expected[axis]) < 0.003), `${label}: ${JSON.stringify({ actual, expected })}`);
    const texturePixel = (tile, x, y) => pack.atlas.pixelsRGBA.subarray(((tile.y + y) * pack.atlas.width + tile.x + x) * 4, ((tile.y + y) * pack.atlas.width + tile.x + x) * 4 + 4);
    const changed = (a, b) => { let count = 0; for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++; return count; };
    const captures = {}, cases = []; let base;
    const capture = (name, image) => { const displayBytes = new Uint8ClampedArray(size * size * 4); for (let i = 0; i < image.length; i += 4) { for (let c = 0; c < 3; c++) displayBytes[i + c] = Math.min(255, Math.max(0, half(image[i + c]) * 255)); displayBytes[i + 3] = 255; }
      const picture = document.createElement('canvas'); picture.width = size; picture.height = size; picture.getContext('2d').putImageData(new ImageData(displayBytes, size, size), 0, 0); captures[name] = picture.toDataURL(); };
    try {
      console.log('breaking proof: first draw'); setBase(stone); base = await draw({ cracks: false });
      for (let stage = 0; stage < 10; stage++) {
        overlay.event({ type: 'break-progress', entityId: 3, location: { x: 0, y: 0, z: 0 }, destroyStage: stage }, stage); overlay.update({ eye: [0.5, 0.5, 2], tick: stage });
        const result = await draw(), tile = pack.atlas.tiles[overlay.stageTiles[stage]]; let samples = 0, neutral = 0, darkened = 0;
        for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x++) {
          const source = texturePixel(tile, x, y), actual = pixel(result.image, Math.floor((x + 0.5) * size / tile.width), Math.floor((y + 0.5) * size / tile.height));
          const expected = [0.4, 0.6, 0.8].map((value, axis) => source[3] / 255 < 0.1 ? value : 2 * source[axis] / 255 * value); near(actual.slice(0, 3), expected, `stage${stage} source texel${x},${y}`); samples++;
          if (source[0] >= 126 && source[0] <= 129) neutral++; if (source[0] < 100 && source[3] / 255 >= 0.1) darkened++;
        }
        check(changed(base.depthImage, result.depthImage) === 0 && base.depthImage.every((value, index) => value === result.depthImage[index]), 'Crack pass wrote depth.');
        cases.push({ stage, tile: tile.name, sourceSize: [tile.width, tile.height], samples, neutral, darkened, changedPixels: changed(base.image, result.image) }); capture(`stage-${stage}`, result.image); console.log(`breaking proof: stage${stage}`);
      }
      const snapshot = { ...allocations }, overlaySnapshot = overlay.stats();
      for (let frame = 10; frame < 70; frame++) overlay.update({ eye: [0.5, 0.5, 2], tick: frame });
      check(allocations.uploads === snapshot.uploads && allocations.buffers === snapshot.buffers && overlay.stats().geometryBuilds === overlaySnapshot.geometryBuilds, 'Unchanged frames allocated/uploaded cracks.');
      overlay.progress(3, origin, 0, 70); overlay.update({ eye: [0.5, 0.5, 2], tick: 70 }); check(overlay.stats().geometryBuilds === 10 && overlay.stats().cacheHits >= 1, 'Returning to an old stage rebuilt native geometry.');
      const biased = await draw(), unbiased = await draw({ unbiased: true });
      check(changed(base.image, biased.image) > 100 && changed(base.image, unbiased.image) === 0, 'Native negative polygon bias did not resolve coincident crack depth.');
      // Admission-control texture has alpha just below/above the native0.1
      // discard threshold. This deliberately generated control is not native.
      const tile = pack.atlas.tiles[overlay.stageTiles[0]], control = new Uint8Array(tile.width * tile.height * 4);
      for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x++) control.set([64, 64, 64, x < tile.width / 2 ? 25 : 26], (y * tile.width + x) * 4);
      device.queue.writeTexture({ texture, origin: [tile.x, tile.y] }, control, { bytesPerRow: tile.width * 4 }, [tile.width, tile.height]);
      const alpha = await draw(); near(pixel(alpha.image, 32, 128).slice(0, 3), [0.4, 0.6, 0.8], 'alpha25 must discard'); near(pixel(alpha.image, 224, 128).slice(0, 3), [0.4, 0.6, 0.8].map(value => value * 128 / 255), 'alpha26 must render');
      const restored = new Uint8Array(control.length); for (let y = 0; y < tile.height; y++) restored.set(pack.atlas.pixelsRGBA.subarray(((tile.y + y) * pack.atlas.width + tile.x) * 4, ((tile.y + y) * pack.atlas.width + tile.x + tile.width) * 4), y * tile.width * 4);
      device.queue.writeTexture({ texture, origin: [tile.x, tile.y] }, restored, { bytesPerRow: tile.width * 4 }, [tile.width, tile.height]);
      const models = {};
      for (const [name, id] of [['bottom-slab', slab], ['cross-flower', flower]]) {
        overlay.clear(); setBase(id); const baseline = await draw({ cutout: name === 'cross-flower', cracks: false });
        overlay.localProgress(7, origin, 0.95, 0); overlay.update({ eye: [0.5, 0.5, 2], tick: 0 }); const cracks = await draw({ cutout: name === 'cross-flower' });
        const mesh = [...meshes.values()][0], vertices = pack.materials.get(id).templateVertices.length / 14;
        check(mesh && mesh.count === vertices && changed(baseline.image, cracks.image) > 100, `Source ${name} geometry/texture did not render.`);
        if (name === 'bottom-slab') { check(Math.abs(mesh.bounds.max[1] - 0.5) < 1e-6, 'Cracks expanded slab into a cube.'); near(pixel(cracks.image, 128, 32).slice(0, 3), [0.1, 0.1, 0.1], 'thin model upper air'); }
        models[name] = { stateId: id, vertices, bounds: mesh.bounds, changedPixels: changed(baseline.image, cracks.image) }; capture(name, cracks.image);
      }
      overlay.clear(); setBase(stone); overlay.progress(7, origin, 9, 0); overlay.update({ eye: [0.5, 0.5, 2], tick: 0 }); const originImage = await draw(), dimensions = [];
      for (const y of [40000, 2000000000, -2000000000]) {
        overlay.clear(); origin = [0, y, 0]; cameraOrigin = [...origin]; setBase(stone); overlay.progress(7, origin, 9, 0); overlay.update({ eye: [0.5, y + 0.5, 2], tick: 0 });
        check([...meshes.values()][0].options.origin[1] === y, 'ExtremeY leaked into Float32 model vertices.'); const high = await draw();
        check(high.image.every((value, index) => value === originImage.image[index]) && high.depthImage.every((value, index) => value === originImage.depthImage[index]), 'Source cracks changed after a highY GPU origin rebase.');
        dimensions.push({ y, exactHdr: true, exactDepth: true }); capture(`high-y-${y}`, high.image);
      }
      overlay.progress(7, null, -1); overlay.update({ eye: [0.5, origin[1] + 0.5, 2], tick: 0 }); check(meshes.size === 0, 'Remove packet left a GPU mesh.');
      check(gpuErrors.length === 0, JSON.stringify(gpuErrors));
      return { version, nativeAssetInput: native, isolatedGpuSink: true, cases, models, dimensions, alphaThreshold: { below: 25, above: 26, divisor: 255 },
        neutralUsesSourceUnormView: true, depthWrite: false, nativeBiasVisible: true, unchangedFrames: 60, allocations, overlay: overlay.stats(), adapter: adapter.info, captures, gpuErrors };
    } finally { overlay.destroy(); baseBuffer?.destroy(); transform.destroy(); tileBuffer.destroy(); texture.destroy(); hdr.destroy(); depth.destroy(); device.destroy(); }
  }, { version, native: Boolean(source) });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive: true });
  for (const [name, data] of Object.entries(proof.captures)) await writeFile(`test-results/breaking-overlay-${version}-${name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  delete proof.captures; await writeFile(`test-results/breaking-overlay-${version}.json`, JSON.stringify({ ...proof, softwareGPU: software, errors }, null, 2));
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
