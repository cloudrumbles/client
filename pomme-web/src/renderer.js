// A browser-native WebGPU renderer. This is its own lighting pipeline, not an
// Iris/Photon compatibility layer. Stable chunk meshes stay on the GPU, while a
// bounded shadow cache avoids redrawing unchanged terrain every frame. A small
// HDR environment cache shares slowly changing sky/cloud work with water.

const VERTEX_BYTES = 40;
const FRAME_BYTES = 256;
const HDR_FORMAT = 'rgba16float';
const DEPTH_FORMAT = 'depth32float';
const TAU = Math.PI * 2;
const QUALITY = {
  low: { id: 0, shadowSize: 1024, shadowRadius: 60, bloom: 0, skyWidth: 256, skyHeight: 128, cloudInterval: Infinity },
  balanced: { id: 1, shadowSize: 1536, shadowRadius: 82, bloom: 0.13, skyWidth: 512, skyHeight: 256, cloudInterval: 1 },
  high: { id: 2, shadowSize: 2048, shadowRadius: 92, bloom: 0.19, skyWidth: 1024, skyHeight: 512, cloudInterval: 0.5 },
};

const shaderURLs = {
  common: new URL('./shaders/common.wgsl', import.meta.url),
  world: new URL('./shaders/world.wgsl', import.meta.url),
  sky: new URL('./shaders/sky.wgsl', import.meta.url),
  environment: new URL('./shaders/environment.wgsl', import.meta.url),
  water: new URL('./shaders/water.wgsl', import.meta.url),
  shadow: new URL('./shaders/shadow.wgsl', import.meta.url),
  bloom: new URL('./shaders/bloom.wgsl', import.meta.url),
  post: new URL('./shaders/post.wgsl', import.meta.url),
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

function multiply(a, b) {
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      result[column * 4 + row] = a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }
  return result;
}

function perspective(aspect, fieldOfView, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  // Right-handed view space, WebGPU's zero-to-one depth interval.
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ]);
}

function lookAt(eye, target, up = [0, 1, 0]) {
  const z = normalize(eye.map((value, i) => value - target[i]));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function orthographic(radius, near, far) {
  return new Float32Array([
    1 / radius, 0, 0, 0,
    0, 1 / radius, 0, 0,
    0, 0, 1 / (near - far), 0,
    0, 0, near / (near - far), 1,
  ]);
}

function frustumPlanes(matrix) {
  const row = index => [matrix[index], matrix[4 + index], matrix[8 + index], matrix[12 + index]];
  const x = row(0), y = row(1), z = row(2), w = row(3);
  return [
    w.map((value, i) => value + x[i]), w.map((value, i) => value - x[i]),
    w.map((value, i) => value + y[i]), w.map((value, i) => value - y[i]),
    z, w.map((value, i) => value - z[i]),
  ];
}

function intersectsFrustum(bounds, planes) {
  for (const plane of planes) {
    const x = plane[0] >= 0 ? bounds.max[0] : bounds.min[0];
    const y = plane[1] >= 0 ? bounds.max[1] : bounds.min[1];
    const z = plane[2] >= 0 ? bounds.max[2] : bounds.min[2];
    if (plane[0] * x + plane[1] * y + plane[2] * z + plane[3] < 0) return false;
  }
  return true;
}

function meshBounds(input, opaque, water) {
  if (input?.min && input?.max) return { min: Array.from(input.min), max: Array.from(input.max) };
  if (input?.length === 6) return { min: Array.from(input).slice(0, 3), max: Array.from(input).slice(3, 6) };
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const data of [opaque, water]) {
    for (let vertex = 0; vertex < data.length; vertex += 10) {
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], data[vertex + axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], data[vertex + axis]);
      }
    }
  }
  return bounds;
}

function meshData(value) {
  if (!value) return new Float32Array(0);
  const data = value instanceof Float32Array ? value : new Float32Array(value);
  if (data.byteLength % (VERTEX_BYTES * 3) !== 0) throw new Error('A chunk mesh must contain complete triangles of ten-float vertices.');
  return data;
}

function smoothstep(low, high, value) {
  const x = clamp((value - low) / (high - low), 0, 1);
  return x * x * (3 - 2 * x);
}

export async function createRenderer(canvas, { onStatus = () => {} } = {}) {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a recent Chrome or Edge browser on HTTPS or localhost.');
  onStatus('Requesting the high-performance WebGPU adapter…');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available. Check the browser’s hardware acceleration setting.');

  const gpuTimingSupported = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    label: 'Pomme browser renderer',
    requiredFeatures: gpuTimingSupported ? ['timestamp-query'] : [],
  });
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy();
    throw new Error('The canvas could not create a WebGPU context.');
  }
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: 'opaque' });

  let destroyed = false;
  let fatalError = null;
  device.addEventListener('uncapturederror', event => {
    fatalError = new Error(`WebGPU validation: ${event.error.message}`);
    onStatus(fatalError.message);
  });
  device.lost.then(info => {
    if (!destroyed) {
      fatalError = new Error(`WebGPU device lost (${info.reason}): ${info.message || 'reload the page to reconnect'}`);
      onStatus(fatalError.message);
    }
  });

  const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {});
  const adapterInfo = {
    vendor: info.vendor || 'undisclosed',
    architecture: info.architecture || 'undisclosed',
    device: info.device || 'undisclosed',
    description: info.description || 'WebGPU adapter',
    isFallbackAdapter: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? false,
  };

  onStatus('Compiling the HDR terrain, sky, water, and shadow shaders…');
  const shaderText = Object.fromEntries(await Promise.all(Object.entries(shaderURLs).map(async ([name, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load shader ${name}: HTTP ${response.status}.`);
    return [name, await response.text()];
  })));
  const modules = {};
  for (const name of ['world', 'sky', 'environment', 'water', 'shadow', 'bloom', 'post']) {
    const shared = ['world', 'sky', 'environment', 'water'].includes(name) ? shaderText.common + '\n' : '';
    const module = device.createShaderModule({ label: `${name}.wgsl`, code: shared + shaderText[name] });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(message => message.type === 'error');
    if (errors.length) {
      device.destroy();
      throw new Error(`${name}.wgsl failed to compile:\n${errors.map(error => `line ${error.lineNum}: ${error.message}`).join('\n')}`);
    }
    modules[name] = module;
  }

  const frameBuffer = device.createBuffer({ label: 'Camera and light uniforms', size: FRAME_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const frameData = new Float32Array(FRAME_BYTES / 4);
  const postBuffer = device.createBuffer({ label: 'Tone mapping settings', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bloomBuffers = Array.from({ length: 3 }, (_, index) => device.createBuffer({ label: `Bloom settings ${index}`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const linearSampler = device.createSampler({ label: 'Linear clamp sampler', minFilter: 'linear', magFilter: 'linear' });
  const shadowSampler = device.createSampler({ label: 'Shadow comparison sampler', compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
  const environmentSampler = device.createSampler({ label: 'Wrapping sky environment sampler', addressModeU: 'repeat', addressModeV: 'clamp-to-edge', minFilter: 'linear', magFilter: 'linear' });
  const frameLayout = device.createBindGroupLayout({
    label: 'Camera and cached shadow bindings',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: FRAME_BYTES } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const shadowLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', minBindingSize: 128 } }] });
  const environmentLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: FRAME_BYTES } }] });
  const sceneLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  ] });
  const bloomLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 32 } },
  ] });
  const postLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 16 } },
  ] });
  const vertexLayout = {
    arrayStride: VERTEX_BYTES,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
      { shaderLocation: 3, offset: 36, format: 'float32' },
    ],
  };
  const worldPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout] });
  const waterPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, sceneLayout] });
  const bloomPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bloomLayout] });
  const postPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [postLayout] });
  device.pushErrorScope('validation');
  let pipelines;
  try {
    const pipelineList = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'HDR opaque terrain', layout: worldPipelineLayout,
        vertex: { module: modules.world, entryPoint: 'vs_terrain', buffers: [vertexLayout] },
        fragment: { module: modules.world, entryPoint: 'fs_terrain', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        label: 'Procedural atmosphere', layout: worldPipelineLayout,
        vertex: { module: modules.sky, entryPoint: 'vs_sky' },
        fragment: { module: modules.sky, entryPoint: 'fs_sky', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
      }),
      device.createRenderPipelineAsync({
        label: 'Cached equirectangular atmosphere and clouds', layout: device.createPipelineLayout({ bindGroupLayouts: [environmentLayout] }),
        vertex: { module: modules.environment, entryPoint: 'vs_environment' },
        fragment: { module: modules.environment, entryPoint: 'fs_environment', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'Reflective refractive water', layout: waterPipelineLayout,
        vertex: { module: modules.water, entryPoint: 'vs_water', buffers: [vertexLayout] },
        fragment: { module: modules.water, entryPoint: 'fs_water', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal' },
      }),
      device.createRenderPipelineAsync({
        label: 'Cached directional shadow', layout: device.createPipelineLayout({ bindGroupLayouts: [shadowLayout] }),
        vertex: { module: modules.shadow, entryPoint: 'vs_shadow', buffers: [{ arrayStride: VERTEX_BYTES, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less', depthBias: 1, depthBiasSlopeScale: 1.5 },
      }),
      device.createRenderPipelineAsync({
        label: 'Quarter-resolution bloom extraction', layout: bloomPipelineLayout,
        vertex: { module: modules.bloom, entryPoint: 'vs_fullscreen' },
        fragment: { module: modules.bloom, entryPoint: 'fs_extract', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'Separable bloom blur', layout: bloomPipelineLayout,
        vertex: { module: modules.bloom, entryPoint: 'vs_fullscreen' },
        fragment: { module: modules.bloom, entryPoint: 'fs_blur', targets: [{ format: HDR_FORMAT }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'ACES tone mapping and presentation', layout: postPipelineLayout,
        vertex: { module: modules.post, entryPoint: 'vs_fullscreen' },
        fragment: { module: modules.post, entryPoint: 'fs_post', targets: [{ format: canvasFormat }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    pipelines = Object.fromEntries(['world', 'sky', 'environment', 'water', 'shadow', 'bloomExtract', 'bloomBlur', 'post'].map((name, i) => [name, pipelineList[i]]));
  } catch (error) {
    await device.popErrorScope();
    device.destroy();
    throw error;
  }
  const pipelineError = await device.popErrorScope();
  if (pipelineError) {
    device.destroy();
    throw new Error(`WebGPU pipeline validation: ${pipelineError.message}`);
  }

  const chunks = new Map();
  let geometryRevision = 0;
  let geometryBytes = 0;
  let meshUploadCount = 0;
  let meshUploadBytes = 0;
  let qualityName = 'balanced';
  let scale = 1;
  let width = 0, height = 0, renderWidth = 0, renderHeight = 0;
  let targets = null;
  let shadowTexture = null;
  let environmentTarget = null;
  let skyKey = null;
  let skyCacheUpdates = 0;
  let skyCachedFrames = 0;
  let skyAgeFrames = 0;
  let lastSkyReason = 'initial';
  let skyCpuMs = 0;
  let frameGroup = null;
  const shadowGroup = device.createBindGroup({ layout: shadowLayout, entries: [{ binding: 0, resource: { buffer: frameBuffer } }] });
  const environmentGroup = device.createBindGroup({ layout: environmentLayout, entries: [{ binding: 0, resource: { buffer: frameBuffer } }] });
  let shadowSize = 0;
  let shadowKey = null;
  let lightViewProjection = new Float32Array(16);
  let shadowLightDirection = [0.3, 1, 0.2];
  let shadowUpdates = 0;
  let shadowCachedFrames = 0;
  let shadowAgeFrames = 0;
  let lastShadowReason = 'initial';
  let frameCount = 0;
  let gpuMs = null;
  let lastGpuMs = null;
  let gpuSampleCount = 0;
  let cpuMs = 0;
  let visibleChunks = 0;
  let drawCalls = 0;
  let triangles = 0;
  let renderedVertices = 0;
  let shadowDrawCalls = 0;
  let shadowCpuMs = 0;

  // Three asynchronous readback slots keep timing off the render loop. Browser
  // timestamps are nanoseconds; a RAF interval is never reported as GPU time.
  const querySet = gpuTimingSupported ? device.createQuerySet({ label: 'Frame GPU timestamps', type: 'timestamp', count: 2 }) : null;
  const queryResolve = querySet ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const timingSlots = querySet ? Array.from({ length: 3 }, () => ({
    busy: false, buffer: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
  })) : [];

  function ensureAlive() {
    if (destroyed) throw new Error('The renderer has been destroyed.');
    if (fatalError) throw fatalError;
  }

  function makeTexture(label, textureWidth, textureHeight, format, usage) {
    const texture = device.createTexture({ label, size: [textureWidth, textureHeight], format, usage });
    return { texture, view: texture.createView() };
  }

  function rebuildFrameGroup() {
    if (!shadowTexture || !environmentTarget) return;
    frameGroup = device.createBindGroup({
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: shadowTexture.createView() },
        { binding: 2, resource: shadowSampler },
        { binding: 3, resource: environmentTarget.view },
        { binding: 4, resource: environmentSampler },
      ],
    });
  }

  function createShadowTarget() {
    const desiredSize = Math.min(QUALITY[qualityName].shadowSize, device.limits.maxTextureDimension2D);
    if (shadowSize === desiredSize) return;
    shadowTexture?.destroy();
    shadowSize = desiredSize;
    shadowTexture = device.createTexture({ label: 'Persistent cached directional shadow map', size: [shadowSize, shadowSize], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    rebuildFrameGroup();
    shadowKey = null;
  }

  function createEnvironmentTarget() {
    const preset = QUALITY[qualityName];
    const skyWidth = Math.min(preset.skyWidth, device.limits.maxTextureDimension2D);
    const skyHeight = Math.min(preset.skyHeight, device.limits.maxTextureDimension2D);
    if (environmentTarget?.width === skyWidth && environmentTarget?.height === skyHeight) return;
    environmentTarget?.texture.destroy();
    environmentTarget = {
      ...makeTexture('Persistent sky and cloud environment cache', skyWidth, skyHeight, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING),
      width: skyWidth, height: skyHeight,
    };
    rebuildFrameGroup();
    skyKey = null;
  }

  function destroyTargets() {
    if (targets) for (const texture of targets.textures) texture.destroy();
    targets = null;
  }

  function resize(nextScale = scale) {
    ensureAlive();
    scale = clamp(Number(nextScale) || 1, 0.35, 1);
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1280) * pixelRatio));
    const nextHeight = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 720) * pixelRatio));
    const dimensionLimit = device.limits.maxTextureDimension2D;
    width = Math.min(nextWidth, dimensionLimit);
    height = Math.min(nextHeight, dimensionLimit);
    canvas.width = width;
    canvas.height = height;
    const nextRenderWidth = Math.max(1, Math.round(width * scale));
    const nextRenderHeight = Math.max(1, Math.round(height * scale));
    if (targets && renderWidth === nextRenderWidth && renderHeight === nextRenderHeight) {
      return { width, height, renderWidth, renderHeight, scale };
    }
    renderWidth = nextRenderWidth;
    renderHeight = nextRenderHeight;
    destroyTargets();
    const hdrUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const opaque = makeTexture('Opaque HDR scene', renderWidth, renderHeight, HDR_FORMAT, hdrUsage);
    const composite = makeTexture('HDR scene with water', renderWidth, renderHeight, HDR_FORMAT, hdrUsage);
    const depth = makeTexture('World depth', renderWidth, renderHeight, DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT);
    const bloomWidth = Math.max(1, Math.ceil(renderWidth / 4));
    const bloomHeight = Math.max(1, Math.ceil(renderHeight / 4));
    const bloomA = makeTexture('Quarter-resolution bloom A', bloomWidth, bloomHeight, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const bloomB = makeTexture('Quarter-resolution bloom B', bloomWidth, bloomHeight, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const emptyBloom = makeTexture('Black bloom fallback', 1, 1, HDR_FORMAT, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: emptyBloom.texture }, new Uint16Array(4), { bytesPerRow: 8 }, [1, 1]);
    const sceneGroup = device.createBindGroup({ layout: sceneLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: opaque.view },
    ] });
    const bloomGroup = (source, buffer) => device.createBindGroup({ layout: bloomLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: source }, { binding: 2, resource: { buffer } },
    ] });
    const postGroup = (source, bloomSource) => device.createBindGroup({ layout: postLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: source }, { binding: 2, resource: bloomSource }, { binding: 3, resource: { buffer: postBuffer } },
    ] });
    targets = {
      opaque, composite, depth, bloomA, bloomB, emptyBloom,
      sceneGroup,
      bloomExtractOpaque: bloomGroup(opaque.view, bloomBuffers[0]),
      bloomExtractWater: bloomGroup(composite.view, bloomBuffers[0]),
      bloomHorizontal: bloomGroup(bloomA.view, bloomBuffers[1]),
      bloomVertical: bloomGroup(bloomB.view, bloomBuffers[2]),
      postOpaque: postGroup(opaque.view, bloomA.view),
      postWater: postGroup(composite.view, bloomA.view),
      postOpaqueLow: postGroup(opaque.view, emptyBloom.view),
      postWaterLow: postGroup(composite.view, emptyBloom.view),
      textures: [opaque.texture, composite.texture, depth.texture, bloomA.texture, bloomB.texture, emptyBloom.texture],
    };
    device.queue.writeBuffer(bloomBuffers[0], 0, new Float32Array([1 / renderWidth, 1 / renderHeight, 0, 0, 0.95, 0, 0, 0]));
    device.queue.writeBuffer(bloomBuffers[1], 0, new Float32Array([1 / bloomWidth, 1 / bloomHeight, 1, 0, 0, 0, 0, 0]));
    device.queue.writeBuffer(bloomBuffers[2], 0, new Float32Array([1 / bloomWidth, 1 / bloomHeight, 0, 1, 0, 0, 0, 0]));
    return { width, height, renderWidth, renderHeight, scale };
  }

  function uploadChunk(index, opaqueInput, waterInput, boundsInput) {
    ensureAlive();
    const opaque = meshData(opaqueInput);
    const water = meshData(waterInput);
    if (!opaque.length && !water.length) {
      removeChunk(index);
      return;
    }
    const bounds = meshBounds(boundsInput, opaque, water);
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error(`Chunk ${index} has invalid bounds.`);
    const createMeshBuffer = (data, kind) => {
      if (!data.byteLength) return null;
      if (data.byteLength > device.limits.maxBufferSize) throw new Error(`Chunk ${index} exceeds the GPU buffer-size limit.`);
      const buffer = device.createBuffer({ label: `Chunk ${index} ${kind}`, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
      return buffer;
    };
    const opaqueBuffer = createMeshBuffer(opaque, 'opaque');
    let waterBuffer;
    try {
      waterBuffer = createMeshBuffer(water, 'water');
    } catch (error) {
      opaqueBuffer?.destroy();
      throw error;
    }
    removeChunk(index);
    const bytes = opaque.byteLength + water.byteLength;
    chunks.set(index, { bounds, opaqueBuffer, waterBuffer, opaqueCount: opaque.length / 10, waterCount: water.length / 10, bytes });
    geometryBytes += bytes;
    meshUploadBytes += bytes;
    meshUploadCount++;
    geometryRevision++;
  }

  function removeChunk(index) {
    ensureAlive();
    const chunk = chunks.get(index);
    if (!chunk) return;
    chunk.opaqueBuffer?.destroy();
    chunk.waterBuffer?.destroy();
    geometryBytes -= chunk.bytes;
    chunks.delete(index);
    geometryRevision++;
  }

  function updateShadowCache(eye, dayPhase, revision) {
    const bucket = Math.floor(dayPhase * 240) % 240;
    const centerX = clamp(Math.floor(eye[0] / 32) * 32 + 16, 20, 108);
    const centerZ = clamp(Math.floor(eye[2] / 32) * 32 + 16, 20, 108);
    const key = `${geometryRevision}:${revision ?? 0}:${bucket}:${centerX}:${centerZ}:${qualityName}`;
    if (key === shadowKey) {
      shadowCachedFrames++;
      shadowAgeFrames++;
      return false;
    }
    if (!shadowKey) lastShadowReason = 'initial / quality';
    else {
      const oldParts = shadowKey.split(':');
      if (oldParts[0] !== String(geometryRevision) || oldParts[1] !== String(revision ?? 0)) lastShadowReason = 'world edit';
      else if (oldParts[2] !== String(bucket)) lastShadowReason = 'sun angle';
      else lastShadowReason = 'camera region';
    }
    shadowKey = key;
    const angle = (bucket + 0.5) / 240 * TAU;
    const sun = normalize([Math.cos(angle) * 0.75, Math.sin(angle), -Math.cos(angle) * 0.45]);
    const direction = sun[1] >= 0 ? sun : sun.map(value => -value);
    // Very low sun angles produce huge shadow footprints. Keep the cached
    // directional light above a small elevation and soften its dusk intensity.
    shadowLightDirection = normalize([direction[0], Math.max(direction[1], 0.10), direction[2]]);
    const focus = [centerX, 25, centerZ];
    const lightEye = focus.map((value, i) => value + shadowLightDirection[i] * 150);
    const up = Math.abs(shadowLightDirection[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    lightViewProjection = multiply(orthographic(QUALITY[qualityName].shadowRadius, 0.1, 320), lookAt(lightEye, focus, up));
    shadowUpdates++;
    shadowAgeFrames = 0;
    return true;
  }

  function updateSkyCache(eye, dayPhase, timeSeconds) {
    const sunBucket = Math.floor(dayPhase * 240) % 240;
    const cloudBucket = Math.floor(timeSeconds / QUALITY[qualityName].cloudInterval);
    const cameraX = Math.floor(eye[0] / 32);
    const cameraZ = Math.floor(eye[2] / 32);
    const key = `${sunBucket}:${cloudBucket}:${cameraX}:${cameraZ}:${qualityName}`;
    if (key === skyKey) {
      skyCachedFrames++;
      skyAgeFrames++;
      return false;
    }
    if (!skyKey) lastSkyReason = 'initial / quality';
    else {
      const old = skyKey.split(':');
      if (old[0] !== String(sunBucket)) lastSkyReason = 'sun angle';
      else if (old[1] !== String(cloudBucket)) lastSkyReason = 'cloud wind';
      else lastSkyReason = 'camera region';
    }
    skyKey = key;
    skyCacheUpdates++;
    skyAgeFrames = 0;
    return true;
  }

  function render({ eye = [64, 38, 100], yaw = 0, pitch = 0, timeSeconds = 0, dayPhase = 0.22, revision = 0, quality = qualityName, scale: requestedScale = scale } = {}) {
    ensureAlive();
    const started = performance.now();
    if (quality !== qualityName && QUALITY[quality]) {
      qualityName = quality;
      createShadowTarget();
      createEnvironmentTarget();
      shadowKey = null;
    }
    if (!targets || Math.abs(requestedScale - scale) > 0.005) resize(requestedScale);
    const preset = QUALITY[qualityName];
    const normalizedPhase = ((dayPhase % 1) + 1) % 1;
    const shadowUpdated = updateShadowCache(eye, normalizedPhase, revision);
    const skyUpdated = updateSkyCache(eye, normalizedPhase, timeSeconds);
    const fieldOfView = Math.PI * 70 / 180;
    const forward = normalize([Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]);
    const right = normalize([Math.cos(yaw), 0, Math.sin(yaw)]);
    const up = cross(right, forward);
    const target = eye.map((value, i) => value + forward[i]);
    const viewProjection = multiply(perspective(renderWidth / renderHeight, fieldOfView, 0.08, 360), lookAt(eye, target));
    const sun = normalize([Math.cos(normalizedPhase * TAU) * 0.75, Math.sin(normalizedPhase * TAU), -Math.cos(normalizedPhase * TAU) * 0.45]);
    const sunY = sun[1];
    const keyDirection = sunY >= 0 ? sun : sun.map(value => -value);
    const continuousLightDirection = normalize([keyDirection[0], Math.max(keyDirection[1], 0.10), keyDirection[2]]);
    const daylight = smoothstep(-0.10, 0.22, sunY);
    const warm = 1 - smoothstep(0.08, 0.65, Math.max(sunY, 0));
    const lightColor = sunY >= 0 ? [1, 0.96 - warm * 0.28, 0.85 - warm * 0.42] : [0.42, 0.57, 0.89];

    frameData.set(viewProjection, 0);
    frameData.set(lightViewProjection, 16);
    frameData.set([...eye, timeSeconds], 32);
    frameData.set([...continuousLightDirection, daylight], 36);
    frameData.set([...lightColor, normalizedPhase], 40);
    frameData.set([...right, Math.tan(fieldOfView / 2) * renderWidth / renderHeight], 44);
    frameData.set([...up, Math.tan(fieldOfView / 2)], 48);
    frameData.set([...forward, 0], 52);
    frameData.set([18, 240, 0.000013 + (1 - daylight) * 0.000010, 1], 56);
    frameData.set([renderWidth, renderHeight, preset.id, 0], 60);
    device.queue.writeBuffer(frameBuffer, 0, frameData);
    device.queue.writeBuffer(postBuffer, 0, new Float32Array([1.10 + (1 - daylight) * 0.35, preset.bloom, 0, 0]));

    const planes = frustumPlanes(viewProjection);
    const visible = [];
    for (const chunk of chunks.values()) if (intersectsFrustum(chunk.bounds, planes)) visible.push(chunk);
    visibleChunks = visible.length;
    drawCalls = 0;
    renderedVertices = 0;
    shadowDrawCalls = 0;
    const hasWater = visible.some(chunk => chunk.waterCount > 0);
    const timingSlot = timingSlots.find(slot => !slot.busy);
    if (timingSlot) timingSlot.busy = true;
    const encoder = device.createCommandEncoder({ label: `Pomme frame ${frameCount}` });
    const timestampBegin = timingSlot ? { querySet, beginningOfPassWriteIndex: 0 } : undefined;
    const timestampEnd = timingSlot ? { querySet, endOfPassWriteIndex: 1 } : undefined;

    if (skyUpdated) {
      const skyStart = performance.now();
      const environmentPass = encoder.beginRenderPass({
        label: `Sky cache update: ${lastSkyReason}`,
        colorAttachments: [{ view: environmentTarget.view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        ...(timestampBegin ? { timestampWrites: timestampBegin } : {}),
      });
      environmentPass.setPipeline(pipelines.environment);
      environmentPass.setBindGroup(0, environmentGroup);
      environmentPass.draw(3);
      environmentPass.end();
      skyCpuMs = performance.now() - skyStart;
      drawCalls++;
    } else skyCpuMs = 0;

    if (shadowUpdated) {
      const shadowStart = performance.now();
      const shadowPass = encoder.beginRenderPass({
        label: `Shadow cache update: ${lastShadowReason}`,
        colorAttachments: [],
        depthStencilAttachment: { view: shadowTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
        ...(!skyUpdated && timestampBegin ? { timestampWrites: timestampBegin } : {}),
      });
      shadowPass.setPipeline(pipelines.shadow);
      shadowPass.setBindGroup(0, shadowGroup);
      const shadowPlanes = frustumPlanes(lightViewProjection);
      for (const chunk of chunks.values()) {
        if (chunk.opaqueCount && intersectsFrustum(chunk.bounds, shadowPlanes)) {
          shadowPass.setVertexBuffer(0, chunk.opaqueBuffer);
          shadowPass.draw(chunk.opaqueCount);
          shadowDrawCalls++;
        }
      }
      shadowPass.end();
      shadowCpuMs = performance.now() - shadowStart;
    } else shadowCpuMs = 0;

    const opaquePass = encoder.beginRenderPass({
      label: 'Sky and visible opaque chunks',
      colorAttachments: [{ view: targets.opaque.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: targets.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(!shadowUpdated && !skyUpdated && timestampBegin ? { timestampWrites: timestampBegin } : {}),
    });
    opaquePass.setBindGroup(0, frameGroup);
    opaquePass.setPipeline(pipelines.sky);
    opaquePass.draw(3);
    drawCalls++;
    opaquePass.setPipeline(pipelines.world);
    for (const chunk of visible) {
      if (chunk.opaqueCount) {
        opaquePass.setVertexBuffer(0, chunk.opaqueBuffer);
        opaquePass.draw(chunk.opaqueCount);
        drawCalls++;
        renderedVertices += chunk.opaqueCount;
      }
    }
    opaquePass.end();

    if (hasWater) {
      // The water samples a completed opaque image, never its own attachment.
      // Only water-bearing frames need this HDR copy/composite pass.
      encoder.copyTextureToTexture({ texture: targets.opaque.texture }, { texture: targets.composite.texture }, [renderWidth, renderHeight]);
      const waterPass = encoder.beginRenderPass({
        label: 'Fresnel water and refracted scene',
        colorAttachments: [{ view: targets.composite.view, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: targets.depth.view, depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      waterPass.setPipeline(pipelines.water);
      waterPass.setBindGroup(0, frameGroup);
      waterPass.setBindGroup(1, targets.sceneGroup);
      for (const chunk of visible) {
        if (chunk.waterCount) {
          waterPass.setVertexBuffer(0, chunk.waterBuffer);
          waterPass.draw(chunk.waterCount);
          drawCalls++;
          renderedVertices += chunk.waterCount;
        }
      }
      waterPass.end();
    }

    if (preset.bloom > 0) {
      const bloomPass = (label, view, pipeline, bindGroup) => {
        const pass = encoder.beginRenderPass({ label, colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
        drawCalls++;
      };
      bloomPass('Bloom extraction', targets.bloomA.view, pipelines.bloomExtract, hasWater ? targets.bloomExtractWater : targets.bloomExtractOpaque);
      bloomPass('Bloom horizontal blur', targets.bloomB.view, pipelines.bloomBlur, targets.bloomHorizontal);
      bloomPass('Bloom vertical blur', targets.bloomA.view, pipelines.bloomBlur, targets.bloomVertical);
    }

    const postPass = encoder.beginRenderPass({
      label: 'Tone mapping to canvas',
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      ...(timestampEnd ? { timestampWrites: timestampEnd } : {}),
    });
    postPass.setPipeline(pipelines.post);
    const postGroupName = `post${hasWater ? 'Water' : 'Opaque'}${preset.bloom ? '' : 'Low'}`;
    postPass.setBindGroup(0, targets[postGroupName]);
    postPass.draw(3);
    postPass.end();
    drawCalls++;
    if (timingSlot) {
      encoder.resolveQuerySet(querySet, 0, 2, queryResolve, 0);
      encoder.copyBufferToBuffer(queryResolve, 0, timingSlot.buffer, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    if (timingSlot) {
      timingSlot.buffer.mapAsync(GPUMapMode.READ).then(() => {
        const timestamp = new BigUint64Array(timingSlot.buffer.getMappedRange());
        const elapsed = Number(timestamp[1] - timestamp[0]) / 1_000_000;
        if (elapsed >= 0 && elapsed < 10_000) {
          lastGpuMs = elapsed;
          gpuSampleCount++;
          gpuMs = gpuMs === null ? elapsed : gpuMs * 0.85 + elapsed * 0.15;
        }
        timingSlot.buffer.unmap();
        timingSlot.busy = false;
      }).catch(() => { timingSlot.busy = false; });
    }
    frameCount++;
    triangles = renderedVertices / 3;
    cpuMs = performance.now() - started;
    return { shadowUpdated, skyUpdated, visibleChunks, drawCalls, cpuMs, gpuMs };
  }

  function stats() {
    return {
      backend: 'WebGPU', adapterInfo, gpuTimingSupported, gpuMs, lastGpuMs, gpuSampleCount,
      cpuMs, cpuEncodeMs: cpuMs, shadowCpuMs, skyCpuMs,
      drawCalls, shadowDrawCalls, visibleChunks, totalChunks: chunks.size,
      vertices: renderedVertices, triangles, geometryBytes,
      meshUploadCount, meshUploadBytes, frameCount,
      shadowUpdates, shadowCachedFrames, shadowCached: shadowAgeFrames > 0,
      shadowAgeFrames, shadowResolution: shadowSize, lastShadowReason,
      skyCacheUpdates, skyCachedFrames, skyCached: skyAgeFrames > 0,
      skyAgeFrames, lastSkyReason, skyResolution: [environmentTarget.width, environmentTarget.height],
      skyCacheBytes: environmentTarget.width * environmentTarget.height * 8,
      quality: qualityName, scale, width, height, renderWidth, renderHeight,
      renderTargetBytes: renderWidth * renderHeight * 20 + Math.ceil(renderWidth / 4) * Math.ceil(renderHeight / 4) * 16 + shadowSize * shadowSize * 4 + environmentTarget.width * environmentTarget.height * 8,
      lastError: fatalError?.message || null,
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const chunk of chunks.values()) {
      chunk.opaqueBuffer?.destroy();
      chunk.waterBuffer?.destroy();
    }
    chunks.clear();
    destroyTargets();
    shadowTexture?.destroy();
    environmentTarget?.texture.destroy();
    frameBuffer.destroy();
    postBuffer.destroy();
    for (const buffer of bloomBuffers) buffer.destroy();
    for (const slot of timingSlots) slot.buffer.destroy();
    queryResolve?.destroy();
    querySet?.destroy();
    context.unconfigure();
    device.destroy();
  }

  createShadowTarget();
  createEnvironmentTarget();
  resize(1);
  onStatus(`WebGPU ready · ${adapterInfo.description}${gpuTimingSupported ? ' · GPU timestamps enabled' : ''}`);
  return { uploadChunk, removeChunk, render, resize, stats, destroy };
}
