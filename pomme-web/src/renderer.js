// A browser-native WebGPU renderer. This is its own lighting pipeline, not an
// Iris/Photon compatibility layer. Stable chunk meshes stay on the GPU, while a
// bounded shadow cache avoids redrawing unchanged terrain every frame. A small
// HDR environment cache shares slowly changing sky/cloud work with water.

const VERTEX_FLOATS = 14;
const VERTEX_BYTES = VERTEX_FLOATS * 4;
const FRAME_BYTES = 336;
const TEMPORAL_BYTES = 208;
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
  temporal: new URL('./shaders/temporal.wgsl', import.meta.url),
  material: new URL('./shaders/material.wgsl', import.meta.url),
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

function inverse(matrix) {
  const rows = Array.from({ length: 4 }, (_, row) => [
    ...Array.from({ length: 4 }, (_, column) => matrix[column * 4 + row]),
    ...Array.from({ length: 4 }, (_, column) => Number(row === column)),
  ]);
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    if (Math.abs(divisor) < 1e-12) throw new Error('The camera projection cannot be inverted.');
    rows[column] = rows[column].map(value => value / divisor);
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      rows[row] = rows[row].map((value, index) => value - factor * rows[column][index]);
    }
  }
  return new Float32Array(Array.from({ length: 16 }, (_, index) => rows[index % 4][4 + Math.floor(index / 4)]));
}

function halton(index, base) {
  let result = 0, factor = 1;
  while (index > 0) { factor /= base; result += factor * (index % base); index = Math.floor(index / base); }
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
    for (let vertex = 0; vertex < data.length; vertex += VERTEX_FLOATS) {
      for (let axis = 0; axis < 3; axis++) {
        bounds.min[axis] = Math.min(bounds.min[axis], data[vertex + axis]);
        bounds.max[axis] = Math.max(bounds.max[axis], data[vertex + axis]);
      }
    }
  }
  return bounds;
}

function meshData(value, stride = 10) {
  if (!value) return new Float32Array(0);
  const data = value instanceof Float32Array ? value : new Float32Array(value);
  if (![10, 14].includes(stride) || data.length % (stride * 3) !== 0) throw new Error('A chunk mesh must contain complete triangles of 10- or 14-float vertices.');
  if (stride === 14) return data;
  const expanded = new Float32Array(data.length / 10 * VERTEX_FLOATS);
  for (let source = 0, target = 0; source < data.length; source += 10, target += VERTEX_FLOATS) {
    expanded.set(data.subarray(source, source + 10), target);
    const normalY = Math.abs(data[source + 4]), normalX = Math.abs(data[source + 3]);
    expanded[target + 10] = normalX > 0.5 ? data[source + 2] : data[source];
    expanded[target + 11] = normalY > 0.5 ? data[source + 2] : data[source + 1];
    expanded[target + 12] = -1;
  }
  return expanded;
}

function relativeVertices(data, sourceOrigin, renderOrigin) {
  const result = new Float32Array(data);
  const offset = sourceOrigin.map((value, axis) => value - renderOrigin[axis]);
  for (let vertex = 0; vertex < result.length; vertex += VERTEX_FLOATS) {
    for (let axis = 0; axis < 3; axis++) result[vertex + axis] = data[vertex + axis] + offset[axis];
  }
  return result;
}

function relativeBounds(bounds, renderOrigin) {
  return { min: bounds.min.map((value, axis) => value - renderOrigin[axis]), max: bounds.max.map((value, axis) => value - renderOrigin[axis]) };
}

function partitionTransparency(data) {
  const triangleFloats = VERTEX_FLOATS * 3;
  let alphaFloats = 0;
  const isAlpha = vertex => (Math.round(data[vertex + 13]) & 64) !== 0 && (Math.round(data[vertex + 13]) & 4) === 0;
  for (let vertex = 0; vertex < data.length; vertex += triangleFloats) if (isAlpha(vertex)) alphaFloats += triangleFloats;
  if (!alphaFloats) return { opaque: data, transparent: new Float32Array(0) };
  if (alphaFloats === data.length) return { opaque: new Float32Array(0), transparent: data };
  const opaque = new Float32Array(data.length - alphaFloats), transparent = new Float32Array(alphaFloats);
  let opaqueAt = 0, alphaAt = 0;
  for (let vertex = 0; vertex < data.length; vertex += triangleFloats) {
    const triangle = data.subarray(vertex, vertex + triangleFloats);
    if (isAlpha(vertex)) { transparent.set(triangle, alphaAt); alphaAt += triangleFloats; }
    else { opaque.set(triangle, opaqueAt); opaqueAt += triangleFloats; }
  }
  return { opaque, transparent };
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
  for (const name of ['world', 'sky', 'environment', 'water', 'shadow', 'bloom', 'post', 'temporal']) {
    const shared = ['world', 'sky', 'environment', 'water'].includes(name) ? shaderText.common + '\n' : '';
    const material = ['world', 'shadow'].includes(name) ? shaderText.material + '\n' : (name === 'water' ? shaderText.material.replaceAll('@group(1)', '@group(2)') + '\n' : '');
    const module = device.createShaderModule({ label: `${name}.wgsl`, code: shared + material + shaderText[name] });
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
  const temporalBuffer = device.createBuffer({ label: 'Temporal reprojection settings', size: TEMPORAL_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const temporalData = new Float32Array(TEMPORAL_BYTES / 4);
  const bloomBuffers = Array.from({ length: 3 }, (_, index) => device.createBuffer({ label: `Bloom settings ${index}`, size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const linearSampler = device.createSampler({ label: 'Linear clamp sampler', minFilter: 'linear', magFilter: 'linear' });
  const shadowSampler = device.createSampler({ label: 'Shadow comparison sampler', compare: 'less-equal', minFilter: 'linear', magFilter: 'linear' });
  const environmentSampler = device.createSampler({ label: 'Wrapping sky environment sampler', addressModeU: 'repeat', addressModeV: 'clamp-to-edge', minFilter: 'linear', magFilter: 'linear' });
  const atlasSampler = device.createSampler({ label: 'Pixel art block atlas sampler', minFilter: 'nearest', magFilter: 'nearest' });
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
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
  ] });
  const materialLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage', minBindingSize: 32 } },
  ] });
  const temporalLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: TEMPORAL_BYTES } },
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
      { shaderLocation: 4, offset: 40, format: 'float32x2' },
      { shaderLocation: 5, offset: 48, format: 'float32' },
      { shaderLocation: 6, offset: 52, format: 'float32' },
    ],
  };
  const worldPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, materialLayout] });
  const skyPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout] });
  const waterPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, sceneLayout, materialLayout] });
  const bloomPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bloomLayout] });
  const postPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [postLayout] });
  device.pushErrorScope('validation');
  let pipelines;
  try {
    const pipelineList = await Promise.all([
      device.createRenderPipelineAsync({
        label: 'HDR opaque terrain', layout: worldPipelineLayout,
        vertex: { module: modules.world, entryPoint: 'vs_terrain', buffers: [vertexLayout] },
        fragment: { module: modules.world, entryPoint: 'fs_terrain', targets: [{ format: HDR_FORMAT }, { format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        label: 'Sorted translucent materials', layout: worldPipelineLayout,
        vertex: { module: modules.world, entryPoint: 'vs_terrain', buffers: [vertexLayout] },
        fragment: { module: modules.world, entryPoint: 'fs_terrain', targets: [
          { format: HDR_FORMAT, blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } },
          { format: 'rgba8unorm' },
        ] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' },
      }),
      device.createRenderPipelineAsync({
        label: 'Procedural atmosphere', layout: skyPipelineLayout,
        vertex: { module: modules.sky, entryPoint: 'vs_sky' },
        fragment: { module: modules.sky, entryPoint: 'fs_sky', targets: [{ format: HDR_FORMAT }, { format: 'rgba8unorm' }] },
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
        fragment: { module: modules.water, entryPoint: 'fs_water', targets: [{ format: HDR_FORMAT }, { format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less-equal' },
      }),
      device.createRenderPipelineAsync({
        label: 'Cached directional shadow', layout: device.createPipelineLayout({ bindGroupLayouts: [shadowLayout, materialLayout] }),
        vertex: { module: modules.shadow, entryPoint: 'vs_shadow', buffers: [vertexLayout] },
        fragment: { module: modules.shadow, entryPoint: 'fs_shadow', targets: [] },
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
        label: 'Temporal HDR resolve and upscaling', layout: device.createPipelineLayout({ bindGroupLayouts: [temporalLayout] }),
        vertex: { module: modules.temporal, entryPoint: 'vs_temporal' },
        fragment: { module: modules.temporal, entryPoint: 'fs_temporal', targets: [{ format: HDR_FORMAT }, { format: 'r32float' }] },
        primitive: { topology: 'triangle-list' },
      }),
      device.createRenderPipelineAsync({
        label: 'ACES tone mapping and presentation', layout: postPipelineLayout,
        vertex: { module: modules.post, entryPoint: 'vs_fullscreen' },
        fragment: { module: modules.post, entryPoint: 'fs_post', targets: [{ format: canvasFormat }] },
        primitive: { topology: 'triangle-list' },
      }),
    ]);
    pipelines = Object.fromEntries(['world', 'transparent', 'sky', 'environment', 'water', 'shadow', 'bloomExtract', 'bloomBlur', 'temporal', 'post'].map((name, i) => [name, pipelineList[i]]));
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
  const dynamicMeshes = new Map();
  let dynamicGeometryBytes = 0, dynamicMeshUploads = 0, entityTriangles = 0;
  let dynamicGeometryRevision = 0;
  let geometryRevision = 0;
  let geometryBytes = 0;
  let meshUploadCount = 0;
  let meshUploadBytes = 0;
  let qualityName = 'balanced';
  let scale = 1;
  let width = 0, height = 0, renderWidth = 0, renderHeight = 0;
  let targets = null;
  let lastSceneSource = null, lastSceneWidth = 0, lastSceneHeight = 0;
  let lastShadowSource = null;
  let shadowTexture = null;
  let dynamicShadowTexture = null, dynamicFrameGroup = null;
  let dynamicShadowValid = false, dynamicShadowUpdates = 0, dynamicShadowDrawCalls = 0;
  let dynamicShadowRevision = -1, dynamicShadowAt = -Infinity;
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
  let shadowCasterRevision = 0;
  let cachedShadowPlanes = null;
  let lightViewProjection = new Float32Array(16);
  let shadowDepthSpan = 320;
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
  let atlasTexture = null, tileBuffer = null, materialGroup = null;
  let atlasBytes = 0, atlasTileCount = 0;
  let atlasAnimations = [], animationUpdates = 0, animationUploadBytes = 0, animationCPUBytes = 0;
  let worldConfig = { min: [0, 0, 0], max: [128, 64, 128], farPlane: 360, fogDensity: 0.000013, renderOrigin: [0, 0, 0], hasSkylight: true };
  let geometryRebases = 0;
  let historyIndex = 0, historyValid = false, historyUsed = false;
  let temporalResets = 0, lastTemporalReset = 'initial', previousFrame = null;
  let jitterSequence = 0, temporalCpuMs = 0;
  let reflectionsEnabled = true;
  let translucentTriangles = 0;

  function invalidateTemporal(reason) {
    historyValid = false;
    historyUsed = false;
    previousFrame = null;
    jitterSequence = 0;
    temporalResets++;
    lastTemporalReset = reason;
  }

  function configureWorld({ min, max, farPlane, fogDensity, hasSkylight = true } = {}) {
    ensureAlive();
    if (!min?.length || !max?.length || min.length !== 3 || max.length !== 3 || ![...min, ...max].every(Number.isFinite) || min.some((value, axis) => value >= max[axis])) {
      throw new Error('World bounds require finite min/max vectors with a positive size on all axes.');
    }
    const extent = Math.hypot(max[0] - min[0], max[2] - min[2]);
    const far = clamp(farPlane ?? extent * 1.5 + (max[1] - min[1]), 128, 2048);
    const renderOrigin = [Math.floor((min[0] + max[0]) / 512) * 256, 0, Math.floor((min[2] + max[2]) / 512) * 256];
    const originChanged = renderOrigin.some((value, axis) => value !== worldConfig.renderOrigin[axis]);
    worldConfig = { min: Array.from(min), max: Array.from(max), farPlane: far, fogDensity: Math.max(0, fogDensity ?? 1.6 / (far * far)), renderOrigin, hasSkylight: Boolean(hasSkylight) };
    if (originChanged) {
      // Rare world-window changes rewrite retained local meshes once. Ordinary
      // camera movement keeps buffers and all positions relative to this anchor.
      for (const mesh of [...chunks.values(), ...dynamicMeshes.values()]) {
        for (const kind of ['opaque', 'water', 'transparent']) {
          const source = mesh[`source${kind[0].toUpperCase()}${kind.slice(1)}`];
          if (source?.length) {
            const relative = relativeVertices(source, mesh.sourceOrigin, renderOrigin);
            if (mesh.dynamic) for (let vertex = 13; vertex < relative.length; vertex += VERTEX_FLOATS) relative[vertex] = (Math.round(relative[vertex]) | 2097152) >>> 0;
            device.queue.writeBuffer(mesh[`${kind}Buffer`], 0, relative);
          }
        }
        mesh.renderBounds = relativeBounds(mesh.bounds, renderOrigin);
      }
      geometryRebases++;
    }
    shadowKey = null;
    skyKey = null;
    invalidateTemporal('world bounds');
    return { ...worldConfig, min: [...worldConfig.min], max: [...worldConfig.max] };
  }

  function setTextureAtlas({ pixels, pixelsRGBA, width: atlasWidth, height: atlasHeight, tiles = [], animations = [] } = {}) {
    ensureAlive();
    const data = pixelsRGBA || pixels;
    if (!(data instanceof Uint8Array) || !Number.isInteger(atlasWidth) || !Number.isInteger(atlasHeight) || atlasWidth <= 0 || atlasHeight <= 0 || data.byteLength !== atlasWidth * atlasHeight * 4) {
      throw new Error('The texture atlas requires tightly packed RGBA bytes and positive integer dimensions.');
    }
    if (Math.max(atlasWidth, atlasHeight) > device.limits.maxTextureDimension2D) throw new Error('The texture atlas exceeds this adapter’s texture-size limit.');
    const tileCount = Math.max(1, ...tiles.map((tile, index) => (tile.id ?? index) + 1));
    if (!Number.isInteger(tileCount) || tileCount > 65536) throw new Error('The texture atlas tile IDs must be integers in 0…65535.');
    const rectangles = new Float32Array(tileCount * 8);
    const rectangleMap = new Map();
    for (let i = 0; i < tileCount; i++) rectangles.set([0, 0, 1 / atlasWidth, 1 / atlasHeight], i * 8);
    for (let index = 0; index < tiles.length; index++) {
      const tile = tiles[index], id = tile.id ?? index;
      const values = [tile.x, tile.y, tile.width, tile.height];
      if (!Number.isInteger(id) || id < 0 || !values.every(Number.isFinite) || tile.x < 0 || tile.y < 0 || tile.width <= 0 || tile.height <= 0 || tile.x + tile.width > atlasWidth || tile.y + tile.height > atlasHeight) throw new Error(`Invalid atlas rectangle for tile ${id}.`);
      rectangles.set([tile.x / atlasWidth, tile.y / atlasHeight, tile.width / atlasWidth, tile.height / atlasHeight], id * 8);
      rectangleMap.set(id, tile);
    }
    const uniqueFrames = new Set();
    const nextAnimations = animations.map(animation => {
      const rectangle = rectangleMap.get(animation.tile);
      if (!rectangle || rectangle.width !== animation.width || rectangle.height !== animation.height || !animation.frames?.length || animation.frames.length !== animation.durationsTicks?.length) throw new Error(`Invalid texture animation for tile ${animation.tile}.`);
      for (const frame of animation.frames) {
        if (!(frame instanceof Uint8Array) || frame.byteLength !== animation.width * animation.height * 4) throw new Error(`Invalid animation frame for tile ${animation.tile}.`);
        uniqueFrames.add(frame);
      }
      if (!animation.durationsTicks.every(ticks => Number.isInteger(ticks) && ticks > 0)) throw new Error(`Invalid texture animation timing for tile ${animation.tile}.`);
      rectangles[animation.tile * 8 + 4] = 1;
      return { ...animation, rectangle, cycleTicks: animation.durationsTicks.reduce((sum, value) => sum + value, 0), interpolate: Boolean(animation.interpolate) && animation.frames.length > 1, lastTick: -Infinity, lastFrame: null, blend: null };
    });
    const frameBytes = [...uniqueFrames].reduce((sum, frame) => sum + frame.byteLength, 0);
    if (frameBytes > 64 * 1024 * 1024) throw new Error('Animated texture frames exceed the 64 MB CPU cache budget.');
    const newTexture = device.createTexture({ label: 'Minecraft block texture atlas', size: [atlasWidth, atlasHeight], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const newTileBuffer = device.createBuffer({ label: 'Block atlas tile rectangles', size: rectangles.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeTexture({ texture: newTexture }, data, { bytesPerRow: atlasWidth * 4 }, [atlasWidth, atlasHeight]);
    device.queue.writeBuffer(newTileBuffer, 0, rectangles);
    atlasTexture?.destroy();
    tileBuffer?.destroy();
    atlasTexture = newTexture;
    tileBuffer = newTileBuffer;
    materialGroup = device.createBindGroup({ layout: materialLayout, entries: [
      { binding: 0, resource: atlasSampler }, { binding: 1, resource: atlasTexture.createView() }, { binding: 2, resource: { buffer: tileBuffer } },
    ] });
    atlasBytes = data.byteLength + rectangles.byteLength;
    atlasTileCount = tileCount;
    atlasAnimations = nextAnimations;
    animationCPUBytes = frameBytes;
    shadowKey = null;
    invalidateTemporal('texture atlas');
    return { width: atlasWidth, height: atlasHeight, tileCount, bytes: atlasBytes };
  }

  function updateTextureAnimations(timeSeconds) {
    const tick = Math.floor(timeSeconds * 20);
    for (const animation of atlasAnimations) {
      if (animation.lastTick === tick) continue;
      animation.lastTick = tick;
      const cycleTick = ((tick % animation.cycleTicks) + animation.cycleTicks) % animation.cycleTicks;
      let frameIndex = 0, frameStart = 0;
      while (frameIndex < animation.frames.length - 1 && cycleTick >= frameStart + animation.durationsTicks[frameIndex]) frameStart += animation.durationsTicks[frameIndex++];
      let frame = animation.frames[frameIndex];
      const next = animation.frames[(frameIndex + 1) % animation.frames.length];
      const fraction = (cycleTick - frameStart) / animation.durationsTicks[frameIndex];
      if (animation.interpolate && fraction > 0 && frame !== next) {
        if (!animation.blend) { animation.blend = new Uint8Array(frame.byteLength); animationCPUBytes += frame.byteLength; }
        for (let index = 0; index < frame.length; index++) animation.blend[index] = Math.round(frame[index] + (next[index] - frame[index]) * fraction);
        frame = animation.blend;
      } else if (animation.lastFrame === frame) continue;
      const rectangle = animation.rectangle;
      device.queue.writeTexture({ texture: atlasTexture, origin: [rectangle.x, rectangle.y] }, frame, { bytesPerRow: animation.width * 4 }, [animation.width, animation.height]);
      animation.lastFrame = frame;
      animationUpdates++;
      animationUploadBytes += frame.byteLength;
    }
  }

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
    const makeGroup = texture => device.createBindGroup({
      layout: frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: shadowSampler },
        { binding: 3, resource: environmentTarget.view },
        { binding: 4, resource: environmentSampler },
      ],
    });
    frameGroup = makeGroup(shadowTexture);
    dynamicFrameGroup = makeGroup(dynamicShadowTexture);
  }

  function createShadowTarget() {
    const desiredSize = Math.min(QUALITY[qualityName].shadowSize, device.limits.maxTextureDimension2D);
    if (shadowSize === desiredSize) return;
    shadowTexture?.destroy();
    dynamicShadowTexture?.destroy();
    shadowSize = desiredSize;
    shadowTexture = device.createTexture({ label: 'Persistent cached directional shadow map', size: [shadowSize, shadowSize], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    dynamicShadowTexture = device.createTexture({ label: 'Static depth plus dynamic entity shadows', size: [shadowSize, shadowSize], format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    dynamicShadowValid = false;
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
    lastSceneSource = null;
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
    if (targets && renderWidth === nextRenderWidth && renderHeight === nextRenderHeight && targets.outputWidth === width && targets.outputHeight === height) {
      return { width, height, renderWidth, renderHeight, scale };
    }
    renderWidth = nextRenderWidth;
    renderHeight = nextRenderHeight;
    destroyTargets();
    invalidateTemporal('resolution');
    historyIndex = 0;
    const hdrUsage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const opaque = makeTexture('Opaque HDR scene', renderWidth, renderHeight, HDR_FORMAT, hdrUsage);
    const composite = makeTexture('HDR scene with water', renderWidth, renderHeight, HDR_FORMAT, hdrUsage);
    const depth = makeTexture('World depth', renderWidth, renderHeight, DEPTH_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC);
    const opaqueDepth = makeTexture('Opaque depth snapshot for SSR', renderWidth, renderHeight, DEPTH_FORMAT, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const reactive = makeTexture('Moving-water temporal reactivity', renderWidth, renderHeight, 'rgba8unorm', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const historyColor = Array.from({ length: 2 }, (_, index) => makeTexture(`Temporal HDR history ${index}`, width, height, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC));
    const historyDepth = Array.from({ length: 2 }, (_, index) => makeTexture(`Temporal linear depth ${index}`, width, height, 'r32float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING));
    const bloomWidth = Math.max(1, Math.ceil(width / 4));
    const bloomHeight = Math.max(1, Math.ceil(height / 4));
    const bloomA = makeTexture('Quarter-resolution bloom A', bloomWidth, bloomHeight, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const bloomB = makeTexture('Quarter-resolution bloom B', bloomWidth, bloomHeight, HDR_FORMAT, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING);
    const emptyBloom = makeTexture('Black bloom fallback', 1, 1, HDR_FORMAT, GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: emptyBloom.texture }, new Uint16Array(4), { bytesPerRow: 8 }, [1, 1]);
    const sceneGroup = device.createBindGroup({ layout: sceneLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: opaque.view }, { binding: 2, resource: opaqueDepth.view },
    ] });
    const bloomGroup = (source, buffer) => device.createBindGroup({ layout: bloomLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: source }, { binding: 2, resource: { buffer } },
    ] });
    const postGroup = (source, bloomSource) => device.createBindGroup({ layout: postLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: source }, { binding: 2, resource: bloomSource }, { binding: 3, resource: { buffer: postBuffer } },
    ] });
    const temporalGroup = (source, index) => device.createBindGroup({ layout: temporalLayout, entries: [
      { binding: 0, resource: linearSampler }, { binding: 1, resource: source },
      { binding: 2, resource: depth.view }, { binding: 3, resource: reactive.view },
      { binding: 4, resource: historyColor[index].view }, { binding: 5, resource: historyDepth[index].view },
      { binding: 6, resource: { buffer: temporalBuffer } },
    ] });
    targets = {
      opaque, composite, depth, opaqueDepth, reactive, historyColor, historyDepth, bloomA, bloomB, emptyBloom,
      outputWidth: width, outputHeight: height,
      sceneGroup,
      bloomExtractOpaque: bloomGroup(opaque.view, bloomBuffers[0]),
      bloomExtractWater: bloomGroup(composite.view, bloomBuffers[0]),
      bloomHorizontal: bloomGroup(bloomA.view, bloomBuffers[1]),
      bloomVertical: bloomGroup(bloomB.view, bloomBuffers[2]),
      temporalOpaque: historyColor.map((_, index) => temporalGroup(opaque.view, index)),
      temporalWater: historyColor.map((_, index) => temporalGroup(composite.view, index)),
      bloomExtractHistory: historyColor.map(history => bloomGroup(history.view, bloomBuffers[0])),
      postHistory: historyColor.map(history => postGroup(history.view, bloomA.view)),
      postOpaque: postGroup(opaque.view, bloomA.view),
      postWater: postGroup(composite.view, bloomA.view),
      postOpaqueLow: postGroup(opaque.view, emptyBloom.view),
      postWaterLow: postGroup(composite.view, emptyBloom.view),
      textures: [opaque.texture, composite.texture, depth.texture, opaqueDepth.texture, reactive.texture, ...historyColor.map(history => history.texture), ...historyDepth.map(history => history.texture), bloomA.texture, bloomB.texture, emptyBloom.texture],
    };
    device.queue.writeBuffer(bloomBuffers[0], 0, new Float32Array([1 / width, 1 / height, 0, 0, 0.95, 0, 0, 0]));
    device.queue.writeBuffer(bloomBuffers[1], 0, new Float32Array([1 / bloomWidth, 1 / bloomHeight, 1, 0, 0, 0, 0, 0]));
    device.queue.writeBuffer(bloomBuffers[2], 0, new Float32Array([1 / bloomWidth, 1 / bloomHeight, 0, 1, 0, 0, 0, 0]));
    return { width, height, renderWidth, renderHeight, scale };
  }

  function uploadChunk(index, opaqueInput, waterInput, boundsInput, { stride = 10, origin = [0, 0, 0] } = {}) {
    ensureAlive();
    const allOpaque = meshData(opaqueInput, stride);
    const { opaque, transparent } = partitionTransparency(allOpaque);
    const water = meshData(waterInput, stride);
    if (!allOpaque.length && !water.length) {
      removeChunk(index);
      return;
    }
    const bounds = meshBounds(boundsInput, allOpaque, water);
    if (origin.length !== 3 || !origin.every(Number.isFinite)) throw new Error(`Chunk ${index} has an invalid source origin.`);
    if (!boundsInput) {
      bounds.min = bounds.min.map((value, axis) => value + origin[axis]);
      bounds.max = bounds.max.map((value, axis) => value + origin[axis]);
    }
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error(`Chunk ${index} has invalid bounds.`);
    const createMeshBuffer = (data, kind) => {
      if (!data.byteLength) return null;
      if (data.byteLength > device.limits.maxBufferSize) throw new Error(`Chunk ${index} exceeds the GPU buffer-size limit.`);
      const buffer = device.createBuffer({ label: `Chunk ${index} ${kind}`, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
      return buffer;
    };
    const opaqueBuffer = createMeshBuffer(relativeVertices(opaque, origin, worldConfig.renderOrigin), 'opaque');
    let waterBuffer, transparentBuffer;
    try {
      waterBuffer = createMeshBuffer(relativeVertices(water, origin, worldConfig.renderOrigin), 'water');
      transparentBuffer = createMeshBuffer(relativeVertices(transparent, origin, worldConfig.renderOrigin), 'transparent');
    } catch (error) {
      opaqueBuffer?.destroy();
      waterBuffer?.destroy();
      throw error;
    }
    removeChunk(index);
    const bytes = allOpaque.byteLength + water.byteLength;
    const chunk = { bounds, renderBounds: relativeBounds(bounds, worldConfig.renderOrigin), sourceOpaque: opaque, sourceWater: water, sourceTransparent: transparent, sourceOrigin: [...origin], opaqueBuffer, waterBuffer, transparentBuffer, opaqueCount: opaque.length / VERTEX_FLOATS, waterCount: water.length / VERTEX_FLOATS, transparentCount: transparent.length / VERTEX_FLOATS, bytes };
    chunks.set(index, chunk);
    invalidateShadowCaster(chunk);
    geometryBytes += bytes;
    meshUploadBytes += bytes;
    meshUploadCount++;
    geometryRevision++;
  }

  function removeChunk(index) {
    ensureAlive();
    const chunk = chunks.get(index);
    if (!chunk) return;
    invalidateShadowCaster(chunk);
    chunk.opaqueBuffer?.destroy();
    chunk.waterBuffer?.destroy();
    chunk.transparentBuffer?.destroy();
    geometryBytes -= chunk.bytes;
    chunks.delete(index);
    geometryRevision++;
  }

  function invalidateShadowCaster(chunk) {
    // Camera visibility is insufficient: offscreen terrain can still cast into
    // the light map. Test the same cached light frustum used by the shadow pass.
    // Coverage, sun, atlas, and world-origin changes rebuild independently, so
    // meshes outside this coverage can stream without redrawing cached depth.
    if (shadowKey !== null && worldConfig.hasSkylight && chunk.opaqueCount && cachedShadowPlanes && intersectsFrustum(chunk.renderBounds, cachedShadowPlanes)) {
      shadowCasterRevision++;
    }
  }

  function uploadDynamicMesh(key, opaqueInput, waterInput, boundsInput, { stride = 14, origin = [0, 0, 0] } = {}) {
    ensureAlive();
    const allOpaque = meshData(opaqueInput, stride), water = meshData(waterInput, stride);
    const { opaque, transparent } = partitionTransparency(allOpaque);
    if (!allOpaque.length && !water.length) { removeMesh(key); return; }
    const bounds = meshBounds(boundsInput, allOpaque, water);
    if (origin.length !== 3 || !origin.every(Number.isFinite)) throw new Error(`Dynamic mesh ${key} has an invalid source origin.`);
    if (!boundsInput) {
      bounds.min = bounds.min.map((value, axis) => value + origin[axis]);
      bounds.max = bounds.max.map((value, axis) => value + origin[axis]);
    }
    if (![...bounds.min, ...bounds.max].every(Number.isFinite)) throw new Error(`Dynamic mesh ${key} has invalid bounds.`);
    const previous = dynamicMeshes.get(key) || { opaqueCapacity: 0, waterCapacity: 0, transparentCapacity: 0, bytes: 0 };
    const updateBuffer = (input, kind) => {
      if (!input.length) return;
      // Moving geometry has no per-vertex motion vectors yet. Mark it reactive
      // so temporal history cannot smear an entity across the background.
      const data = relativeVertices(input, origin, worldConfig.renderOrigin);
      for (let vertex = 13; vertex < data.length; vertex += VERTEX_FLOATS) data[vertex] = (Math.round(data[vertex]) | 2097152) >>> 0;
      const capacityName = `${kind}Capacity`, bufferName = `${kind}Buffer`;
      if (previous[capacityName] < data.byteLength) {
        const capacity = 2 ** Math.ceil(Math.log2(Math.max(data.byteLength, 256)));
        if (capacity > device.limits.maxBufferSize) throw new Error(`Dynamic mesh ${key} exceeds the GPU buffer-size limit.`);
        previous[bufferName]?.destroy();
        previous[bufferName] = device.createBuffer({ label: `Dynamic ${key} ${kind}`, size: capacity, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        previous[capacityName] = capacity;
      }
      device.queue.writeBuffer(previous[bufferName], 0, data);
    };
    dynamicGeometryBytes -= previous.bytes;
    updateBuffer(opaque, 'opaque');
    updateBuffer(water, 'water');
    updateBuffer(transparent, 'transparent');
    previous.bounds = bounds;
    previous.renderBounds = relativeBounds(bounds, worldConfig.renderOrigin);
    previous.sourceOpaque = opaque;
    previous.sourceWater = water;
    previous.sourceTransparent = transparent;
    previous.sourceOrigin = [...origin];
    previous.opaqueCount = opaque.length / VERTEX_FLOATS;
    previous.waterCount = water.length / VERTEX_FLOATS;
    previous.transparentCount = transparent.length / VERTEX_FLOATS;
    previous.bytes = previous.opaqueCapacity + previous.waterCapacity + previous.transparentCapacity;
    previous.dynamic = true;
    dynamicMeshes.set(key, previous);
    dynamicGeometryBytes += previous.bytes;
    dynamicMeshUploads++;
    dynamicGeometryRevision++;
  }

  function removeMesh(key) {
    ensureAlive();
    const mesh = dynamicMeshes.get(key);
    if (!mesh) return;
    mesh.opaqueBuffer?.destroy();
    mesh.waterBuffer?.destroy();
    mesh.transparentBuffer?.destroy();
    dynamicGeometryBytes -= mesh.bytes;
    dynamicMeshes.delete(key);
    dynamicGeometryRevision++;
  }

  function updateShadowCache(eye, dayPhase) {
    const bucket = worldConfig.hasSkylight ? Math.floor(dayPhase * 240) % 240 : 0;
    const axisCenter = axis => {
      const size = worldConfig.max[axis] - worldConfig.min[axis];
      const margin = Math.min(20, size / 2);
      return clamp(Math.floor(eye[axis] / 32) * 32 + 16, worldConfig.min[axis] + margin, worldConfig.max[axis] - margin);
    };
    const centerX = axisCenter(0), centerZ = axisCenter(2);
    const centerY = clamp(Math.floor((eye[1] - 8) / 32) * 32 + 16, worldConfig.min[1], worldConfig.max[1]);
    const key = `${shadowCasterRevision}:${bucket}:${centerX}:${centerZ}:${centerY}:${qualityName}`;
    if (key === shadowKey) {
      shadowCachedFrames++;
      shadowAgeFrames++;
      return false;
    }
    if (!shadowKey) lastShadowReason = 'initial / quality';
    else {
      const oldParts = shadowKey.split(':');
      if (oldParts[0] !== String(shadowCasterRevision)) lastShadowReason = 'world edit';
      else if (oldParts[1] !== String(bucket)) lastShadowReason = 'sun angle';
      else lastShadowReason = 'camera region';
    }
    shadowKey = key;
    const angle = (bucket + 0.5) / 240 * TAU;
    const sun = normalize([Math.cos(angle) * 0.75, Math.sin(angle), -Math.cos(angle) * 0.45]);
    const direction = sun[1] >= 0 ? sun : sun.map(value => -value);
    // Very low sun angles produce huge shadow footprints. Keep the cached
    // directional light above a small elevation and soften its dusk intensity.
    shadowLightDirection = normalize([direction[0], Math.max(direction[1], 0.10), direction[2]]);
    const focus = [centerX, centerY, centerZ];
    const radius = Math.min(QUALITY[qualityName].shadowRadius, Math.max(worldConfig.max[0] - worldConfig.min[0], worldConfig.max[2] - worldConfig.min[2]) / 2 + 16);
    const lightDistance = Math.max(150, (worldConfig.max[1] - worldConfig.min[1]) * 0.8 + radius);
    shadowDepthSpan = lightDistance * 2 + 20;
    const relativeFocus = focus.map((value, axis) => value - worldConfig.renderOrigin[axis]);
    const lightEye = relativeFocus.map((value, i) => value + shadowLightDirection[i] * lightDistance);
    const up = Math.abs(shadowLightDirection[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    lightViewProjection = multiply(orthographic(radius, 0.1, shadowDepthSpan), lookAt(lightEye, relativeFocus, up));
    cachedShadowPlanes = frustumPlanes(lightViewProjection);
    shadowUpdates++;
    shadowAgeFrames = 0;
    return true;
  }

  function updateSkyCache(eye, dayPhase, timeSeconds) {
    const sunBucket = worldConfig.hasSkylight ? Math.floor(dayPhase * 240) % 240 : 0;
    const cloudBucket = worldConfig.hasSkylight ? Math.floor(timeSeconds / QUALITY[qualityName].cloudInterval) : 0;
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

  function render({ eye = [64, 38, 100], yaw = 0, pitch = 0, timeSeconds = 0, dayPhase = 0.22, revision = 0, quality = qualityName, scale: requestedScale = scale, reflections = true } = {}) {
    ensureAlive();
    const started = performance.now();
    if (reflectionsEnabled !== Boolean(reflections)) { reflectionsEnabled = Boolean(reflections); invalidateTemporal('reflections'); }
    if (quality !== qualityName && QUALITY[quality]) {
      qualityName = quality;
      createShadowTarget();
      createEnvironmentTarget();
      shadowKey = null;
      invalidateTemporal('quality');
    }
    if (!targets || Math.abs(requestedScale - scale) > 0.005) resize(requestedScale);
    updateTextureAnimations(timeSeconds);
    const preset = QUALITY[qualityName];
    const normalizedPhase = ((dayPhase % 1) + 1) % 1;
    if (previousFrame) {
      const phaseDelta = Math.abs(normalizedPhase - previousFrame.phase);
      const yawDelta = Math.abs(Math.atan2(Math.sin(yaw - previousFrame.yaw), Math.cos(yaw - previousFrame.yaw)));
      if (previousFrame.geometryRevision !== geometryRevision || previousFrame.revision !== revision) invalidateTemporal('world edit');
      else if (Math.hypot(...eye.map((value, axis) => value - previousFrame.eye[axis])) > 8 || yawDelta > 0.55 || Math.abs(pitch - previousFrame.pitch) > 0.35) invalidateTemporal('camera cut');
      else if (Math.min(phaseDelta, 1 - phaseDelta) > 0.025) invalidateTemporal('day phase jump');
      else if (Math.abs(timeSeconds - previousFrame.time) > 0.75) invalidateTemporal('frame gap');
    }
    const temporalEnabled = preset.id > 0;
    historyUsed = temporalEnabled && historyValid && previousFrame !== null;
    const shadowUpdated = updateShadowCache(eye, normalizedPhase);
    const skyUpdated = updateSkyCache(eye, normalizedPhase, timeSeconds);
    const fieldOfView = Math.PI * 70 / 180;
    const forward = normalize([Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)]);
    const renderEye = eye.map((value, axis) => value - worldConfig.renderOrigin[axis]);
    const right = normalize([Math.cos(yaw), 0, Math.sin(yaw)]);
    const up = cross(right, forward);
    const target = renderEye.map((value, i) => value + forward[i]);
    const jitterIndex = (jitterSequence % 8) + 1;
    const jitter = temporalEnabled ? [halton(jitterIndex, 2) - 0.5, halton(jitterIndex, 3) - 0.5] : [0, 0];
    const projection = perspective(renderWidth / renderHeight, fieldOfView, 0.08, worldConfig.farPlane);
    projection[8] = -2 * jitter[0] / renderWidth;
    projection[9] = 2 * jitter[1] / renderHeight;
    const viewProjection = multiply(projection, lookAt(renderEye, target));
    const inverseViewProjection = inverse(viewProjection);
    const sun = normalize([Math.cos(normalizedPhase * TAU) * 0.75, Math.sin(normalizedPhase * TAU), -Math.cos(normalizedPhase * TAU) * 0.45]);
    const sunY = sun[1];
    const keyDirection = sunY >= 0 ? sun : sun.map(value => -value);
    const continuousLightDirection = normalize([keyDirection[0], Math.max(keyDirection[1], 0.10), keyDirection[2]]);
    const daylight = worldConfig.hasSkylight ? smoothstep(-0.10, 0.22, sunY) : 0;
    const warm = 1 - smoothstep(0.08, 0.65, Math.max(sunY, 0));
    const lightColor = sunY >= 0 ? [1, 0.96 - warm * 0.28, 0.85 - warm * 0.42] : [0.42, 0.57, 0.89];

    frameData.set(viewProjection, 0);
    frameData.set(lightViewProjection, 16);
    frameData.set([...renderEye, timeSeconds], 32);
    frameData.set([...continuousLightDirection, daylight], 36);
    frameData.set([...lightColor, normalizedPhase], 40);
    frameData.set([...right, Math.tan(fieldOfView / 2) * renderWidth / renderHeight], 44);
    frameData.set([...up, Math.tan(fieldOfView / 2)], 48);
    frameData.set([...forward, worldConfig.hasSkylight ? 1 : 0], 52);
    frameData.set([eye[1] - 15, worldConfig.farPlane, worldConfig.fogDensity * (1 + (1 - daylight) * 0.77), 320 / shadowDepthSpan], 56);
    frameData.set([renderWidth, renderHeight, preset.id, reflectionsEnabled ? 1 : 0], 60);
    frameData.set(inverseViewProjection, 64);
    frameData.set([2 * jitter[0] / renderWidth, -2 * jitter[1] / renderHeight, ((worldConfig.renderOrigin[0] % 4096) + 4096) % 4096, ((worldConfig.renderOrigin[2] % 4096) + 4096) % 4096], 80);
    device.queue.writeBuffer(frameBuffer, 0, frameData);
    device.queue.writeBuffer(postBuffer, 0, new Float32Array([1.10 + (1 - daylight) * 0.35, preset.bloom, 0, 0]));
    if (temporalEnabled) {
      temporalData.set(inverseViewProjection, 0);
      temporalData.set(previousFrame?.viewProjection || viewProjection, 16);
      temporalData.set([...renderEye, 0], 32);
      temporalData.set([...(previousFrame?.renderEye || renderEye), 0], 36);
      temporalData.set([renderWidth, renderHeight, width, height], 40);
      temporalData.set([historyUsed ? 1 : 0, preset.id > 1 ? 0.92 : 0.88, worldConfig.farPlane, preset.id], 44);
      temporalData.set([...jitter, ...(previousFrame?.jitter || jitter)], 48);
      device.queue.writeBuffer(temporalBuffer, 0, temporalData);
    }

    const planes = frustumPlanes(viewProjection);
    const visible = [];
    for (const chunk of chunks.values()) if (intersectsFrustum(chunk.renderBounds, planes)) visible.push(chunk);
    visibleChunks = visible.length;
    for (const mesh of dynamicMeshes.values()) if (intersectsFrustum(mesh.renderBounds, planes)) visible.push(mesh);
    entityTriangles = visible.filter(mesh => mesh.dynamic).reduce((count, mesh) => count + (mesh.opaqueCount + mesh.waterCount + mesh.transparentCount) / 3, 0);
    drawCalls = 0;
    renderedVertices = 0;
    shadowDrawCalls = 0;
    const hasWater = visible.some(chunk => chunk.waterCount > 0);
    const transparentMeshes = visible.filter(mesh => mesh.transparentCount > 0).sort((a, b) => {
      const distance = mesh => mesh.bounds.min.reduce((sum, value, axis) => sum + ((value + mesh.bounds.max[axis]) / 2 - eye[axis]) ** 2, 0);
      return distance(b) - distance(a);
    });
    const hasComposite = hasWater || transparentMeshes.length > 0;
    translucentTriangles = transparentMeshes.reduce((sum, mesh) => sum + mesh.transparentCount / 3, 0);
    const lightPlanes = frustumPlanes(lightViewProjection);
    const dynamicCasters = worldConfig.hasSkylight ? [...dynamicMeshes.values()].filter(mesh => mesh.opaqueCount && intersectsFrustum(mesh.renderBounds, lightPlanes)) : [];
    const dynamicShadowUpdated = dynamicCasters.length > 0 && (shadowUpdated || !dynamicShadowValid || (dynamicShadowRevision !== dynamicGeometryRevision && started - dynamicShadowAt >= 1000 / 30));
    if (!dynamicCasters.length) dynamicShadowValid = false;
    dynamicShadowDrawCalls = 0;
    const activeFrameGroup = dynamicCasters.length ? dynamicFrameGroup : frameGroup;
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
      shadowPass.setBindGroup(1, materialGroup);
      for (const chunk of chunks.values()) {
        if (worldConfig.hasSkylight && chunk.opaqueCount && intersectsFrustum(chunk.renderBounds, cachedShadowPlanes)) {
          shadowPass.setVertexBuffer(0, chunk.opaqueBuffer);
          shadowPass.draw(chunk.opaqueCount);
          shadowDrawCalls++;
        }
      }
      shadowPass.end();
      shadowCpuMs = performance.now() - shadowStart;
    } else shadowCpuMs = 0;

    if (dynamicShadowUpdated) {
      // Restore cached terrain depth first, which also removes an entity's old
      // silhouette. Only moving casters are redrawn, capped at 30 Hz; terrain
      // cache invalidation remains independent of entity animation.
      encoder.copyTextureToTexture({ texture: shadowTexture, aspect: 'depth-only' }, { texture: dynamicShadowTexture, aspect: 'depth-only' }, [shadowSize, shadowSize]);
      const pass = encoder.beginRenderPass({
        label: 'Dynamic shadows over cached static depth', colorAttachments: [],
        depthStencilAttachment: { view: dynamicShadowTexture.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
        ...(!skyUpdated && !shadowUpdated && timestampBegin ? { timestampWrites: timestampBegin } : {}),
      });
      pass.setPipeline(pipelines.shadow);
      pass.setBindGroup(0, shadowGroup);
      pass.setBindGroup(1, materialGroup);
      for (const mesh of dynamicCasters) { pass.setVertexBuffer(0, mesh.opaqueBuffer); pass.draw(mesh.opaqueCount); dynamicShadowDrawCalls++; }
      pass.end();
      dynamicShadowValid = true;
      dynamicShadowRevision = dynamicGeometryRevision;
      dynamicShadowAt = started;
      dynamicShadowUpdates++;
    }

    const opaquePass = encoder.beginRenderPass({
      label: 'Sky and visible opaque chunks',
      colorAttachments: [
        { view: targets.opaque.view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        { view: targets.reactive.view, clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: { view: targets.depth.view, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
      ...(!shadowUpdated && !skyUpdated && !dynamicShadowUpdated && timestampBegin ? { timestampWrites: timestampBegin } : {}),
    });
    opaquePass.setBindGroup(0, activeFrameGroup);
    opaquePass.setPipeline(pipelines.sky);
    opaquePass.draw(3);
    drawCalls++;
    opaquePass.setPipeline(pipelines.world);
    opaquePass.setBindGroup(1, materialGroup);
    for (const chunk of visible) {
      if (chunk.opaqueCount) {
        opaquePass.setVertexBuffer(0, chunk.opaqueBuffer);
        opaquePass.draw(chunk.opaqueCount);
        drawCalls++;
        renderedVertices += chunk.opaqueCount;
      }
    }
    opaquePass.end();

    if (hasComposite) encoder.copyTextureToTexture({ texture: targets.opaque.texture }, { texture: targets.composite.texture }, [renderWidth, renderHeight]);
    if (hasWater) encoder.copyTextureToTexture({ texture: targets.depth.texture, aspect: 'depth-only' }, { texture: targets.opaqueDepth.texture, aspect: 'depth-only' }, [renderWidth, renderHeight]);
    if (transparentMeshes.length) {
      // Approximate back-to-front chunk sorting; translucent faces test opaque
      // depth but never write it. This preserves the terrain visible through
      // glass/ice without pretending to implement physical refraction or OIT.
      const pass = encoder.beginRenderPass({
        label: 'Sorted translucent terrain and entities',
        colorAttachments: [{ view: targets.composite.view, loadOp: 'load', storeOp: 'store' }, { view: targets.reactive.view, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: targets.depth.view, depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      pass.setPipeline(pipelines.transparent);
      pass.setBindGroup(0, activeFrameGroup);
      pass.setBindGroup(1, materialGroup);
      for (const mesh of transparentMeshes) { pass.setVertexBuffer(0, mesh.transparentBuffer); pass.draw(mesh.transparentCount); drawCalls++; renderedVertices += mesh.transparentCount; }
      pass.end();
      // Water reads the completed pre-water scene. Copying the glass composite
      // avoids sampling the same texture that its render pass writes.
      if (hasWater) encoder.copyTextureToTexture({ texture: targets.composite.texture }, { texture: targets.opaque.texture }, [renderWidth, renderHeight]);
    }

    if (hasWater) {
      // The water samples a completed opaque image, never its own attachment.
      // Only water-bearing frames need this HDR copy/composite pass.
      const waterPass = encoder.beginRenderPass({
        label: 'Fresnel water and refracted scene',
        colorAttachments: [{ view: targets.composite.view, loadOp: 'load', storeOp: 'store' }, { view: targets.reactive.view, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: targets.depth.view, depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      waterPass.setPipeline(pipelines.water);
      waterPass.setBindGroup(0, activeFrameGroup);
      waterPass.setBindGroup(1, targets.sceneGroup);
      waterPass.setBindGroup(2, materialGroup);
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

    if (temporalEnabled) {
      const temporalStart = performance.now();
      const writeIndex = 1 - historyIndex;
      const temporalPass = encoder.beginRenderPass({
        label: 'Depth-validated temporal upscaling',
        colorAttachments: [
          { view: targets.historyColor[writeIndex].view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } },
          { view: targets.historyDepth[writeIndex].view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      temporalPass.setPipeline(pipelines.temporal);
      temporalPass.setBindGroup(0, (hasComposite ? targets.temporalWater : targets.temporalOpaque)[historyIndex]);
      temporalPass.draw(3);
      temporalPass.end();
      historyIndex = writeIndex;
      historyValid = true;
      drawCalls++;
      temporalCpuMs = performance.now() - temporalStart;
    } else {
      historyValid = false;
      temporalCpuMs = 0;
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
      bloomPass('Bloom extraction', targets.bloomA.view, pipelines.bloomExtract, temporalEnabled ? targets.bloomExtractHistory[historyIndex] : (hasComposite ? targets.bloomExtractWater : targets.bloomExtractOpaque));
      bloomPass('Bloom horizontal blur', targets.bloomB.view, pipelines.bloomBlur, targets.bloomHorizontal);
      bloomPass('Bloom vertical blur', targets.bloomA.view, pipelines.bloomBlur, targets.bloomVertical);
    }

    const postPass = encoder.beginRenderPass({
      label: 'Tone mapping to canvas',
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      ...(timestampEnd ? { timestampWrites: timestampEnd } : {}),
    });
    postPass.setPipeline(pipelines.post);
    const postGroupName = `post${hasComposite ? 'Water' : 'Opaque'}${preset.bloom ? '' : 'Low'}`;
    postPass.setBindGroup(0, temporalEnabled ? targets.postHistory[historyIndex] : targets[postGroupName]);
    postPass.draw(3);
    postPass.end();
    drawCalls++;
    if (timingSlot) {
      encoder.resolveQuerySet(querySet, 0, 2, queryResolve, 0);
      encoder.copyBufferToBuffer(queryResolve, 0, timingSlot.buffer, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    lastSceneSource = temporalEnabled ? targets.historyColor[historyIndex].texture : (hasComposite ? targets.composite.texture : targets.opaque.texture);
    lastSceneWidth = temporalEnabled ? width : renderWidth;
    lastSceneHeight = temporalEnabled ? height : renderHeight;
    lastShadowSource = dynamicCasters.length ? dynamicShadowTexture : shadowTexture;
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
    jitterSequence++;
    previousFrame = { eye: [...eye], renderEye, yaw, pitch, phase: normalizedPhase, geometryRevision, revision, time: timeSeconds, viewProjection, jitter };
    triangles = renderedVertices / 3;
    cpuMs = performance.now() - started;
    return { shadowUpdated, skyUpdated, visibleChunks, drawCalls, cpuMs, gpuMs, historyUsed };
  }

  function stats() {
    return {
      backend: 'WebGPU', adapterInfo, gpuTimingSupported, gpuMs, lastGpuMs, gpuSampleCount,
      cpuMs, cpuEncodeMs: cpuMs, shadowCpuMs, skyCpuMs, temporalCpuMs,
      temporalEnabled: QUALITY[qualityName].id > 0, temporalUpscaling: QUALITY[qualityName].id > 0 && scale < 0.999,
      historyUsed, temporalResets, lastTemporalReset, historyResolution: [width, height],
      ssrEnabled: reflectionsEnabled && QUALITY[qualityName].id > 0, ssrMaxSteps: reflectionsEnabled ? (QUALITY[qualityName].id > 1 ? 30 : (QUALITY[qualityName].id > 0 ? 18 : 0)) : 0,
      volumetricCloudSteps: worldConfig.hasSkylight && QUALITY[qualityName].id > 1 ? 6 : 0,
      atlasTileCount, atlasBytes, worldBounds: { min: [...worldConfig.min], max: [...worldConfig.max] }, farPlane: worldConfig.farPlane,
      animatedTileCount: atlasAnimations.length, animationUpdates, animationUploadBytes, animationCPUBytes,
      renderOrigin: [...worldConfig.renderOrigin],
      hasSkylight: worldConfig.hasSkylight,
      drawCalls, shadowDrawCalls, visibleChunks, totalChunks: chunks.size,
      vertices: renderedVertices, triangles, geometryBytes,
      geometryRebases, cpuMeshCacheBytes: geometryBytes + [...dynamicMeshes.values()].reduce((sum, mesh) => sum + mesh.sourceOpaque.byteLength + mesh.sourceWater.byteLength + mesh.sourceTransparent.byteLength, 0),
      translucentTriangles, transparencySorting: 'chunk back-to-front',
      dynamicGeometryBytes, dynamicMeshUploads, dynamicMeshes: dynamicMeshes.size, entityTriangles, dynamicShadows: worldConfig.hasSkylight,
      dynamicShadowUpdates, dynamicShadowDrawCalls, dynamicShadowRateLimitHz: 30,
      meshUploadCount, meshUploadBytes, frameCount,
      shadowUpdates, shadowCachedFrames, shadowCached: shadowAgeFrames > 0,
      shadowAgeFrames, shadowResolution: shadowSize, lastShadowReason,
      skyCacheUpdates, skyCachedFrames, skyCached: skyAgeFrames > 0,
      skyAgeFrames, lastSkyReason, skyResolution: [environmentTarget.width, environmentTarget.height],
      skyCacheBytes: environmentTarget.width * environmentTarget.height * 8,
      quality: qualityName, scale, width, height, renderWidth, renderHeight,
      renderTargetBytes: renderWidth * renderHeight * 28 + width * height * 24 + Math.ceil(width / 4) * Math.ceil(height / 4) * 16 + shadowSize * shadowSize * 8 + environmentTarget.width * environmentTarget.height * 8,
      lastError: fatalError?.message || null,
    };
  }

  async function readPixels({ source = 'hdr' } = {}) {
    // Diagnostic linear-HDR readback. It deliberately waits for this GPU copy;
    // ordinary rendering and timestamp collection never wait for mapped data.
    ensureAlive();
    if (!['hdr', 'shadow'].includes(source)) throw new Error('Diagnostic pixel source must be hdr or shadow.');
    const isShadow = source === 'shadow';
    const texture = isShadow ? lastShadowSource : lastSceneSource;
    if (!texture) throw new Error('Render a frame before reading pixels.');
    const readWidth = isShadow ? shadowSize : lastSceneWidth, readHeight = isShadow ? shadowSize : lastSceneHeight;
    const rowBytes = readWidth * (isShadow ? 4 : 8);
    const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
    const buffer = device.createBuffer({ label: 'Diagnostic HDR pixel readback', size: bytesPerRow * readHeight, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture, ...(isShadow ? { aspect: 'depth-only' } : {}) }, { buffer, bytesPerRow, rowsPerImage: readHeight }, [readWidth, readHeight]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const ArrayType = isShadow ? Float32Array : Uint16Array;
      const mapped = new ArrayType(buffer.getMappedRange());
      const rowElements = readWidth * (isShadow ? 1 : 4);
      const strideElements = bytesPerRow / ArrayType.BYTES_PER_ELEMENT;
      const pixels = new ArrayType(rowElements * readHeight);
      for (let row = 0; row < readHeight; row++) pixels.set(mapped.subarray(row * strideElements, row * strideElements + rowElements), row * rowElements);
      buffer.unmap();
      return { pixels, width: readWidth, height: readHeight, format: isShadow ? DEPTH_FORMAT : HDR_FORMAT };
    } finally { buffer.destroy(); }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const chunk of chunks.values()) {
      chunk.opaqueBuffer?.destroy();
      chunk.waterBuffer?.destroy();
      chunk.transparentBuffer?.destroy();
    }
    chunks.clear();
    for (const mesh of dynamicMeshes.values()) { mesh.opaqueBuffer?.destroy(); mesh.waterBuffer?.destroy(); mesh.transparentBuffer?.destroy(); }
    dynamicMeshes.clear();
    destroyTargets();
    shadowTexture?.destroy();
    dynamicShadowTexture?.destroy();
    environmentTarget?.texture.destroy();
    frameBuffer.destroy();
    postBuffer.destroy();
    temporalBuffer.destroy();
    atlasTexture?.destroy();
    tileBuffer?.destroy();
    for (const buffer of bloomBuffers) buffer.destroy();
    for (const slot of timingSlots) slot.buffer.destroy();
    queryResolve?.destroy();
    querySet?.destroy();
    context.unconfigure();
    device.destroy();
  }

  createShadowTarget();
  createEnvironmentTarget();
  setTextureAtlas({ pixels: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 });
  resize(1);
  onStatus(`WebGPU ready · ${adapterInfo.description}${gpuTimingSupported ? ' · GPU timestamps enabled' : ''}`);
  return { uploadChunk, removeChunk, uploadDynamicMesh, removeMesh, render, resize, configureWorld, setTextureAtlas, readPixels, stats, destroy };
}
