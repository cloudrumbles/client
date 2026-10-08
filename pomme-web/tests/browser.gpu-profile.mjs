import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/world.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { GpuPassProfiler, GPU_PROFILE_STAGES } = await import('/src/gpu-profile.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    check(adapter?.features.has('timestamp-query'), 'The GPU profiler proof requires native timestamp-query support.');
    const device = await adapter.requestDevice({ requiredFeatures: ['timestamp-query'] }), validation = [];
    device.addEventListener('uncapturederror', event => validation.push(event.error.message));
    const shader = device.createShaderModule({ code: `
      @vertex fn vertex(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
        let xy = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
        return vec4f(xy[index],0,1);
      }
      @fragment fn fragment()->@location(0) vec4f { return vec4f(.25,.5,.75,1); }
    ` });
    const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vertex' }, fragment: { module: shader, entryPoint: 'fragment', targets: [{ format: 'rgba8unorm' }] } });
    const texture = device.createTexture({ size: [128,128], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }), view = texture.createView();
    const pixels = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const samples = [], profiler = new GpuPassProfiler(device, { onSample: sample => samples.push(sample) }); let standalone;
    const waitFor = async predicate => {
      const until = performance.now() + 5000;
      while (!predicate()) { if (performance.now() > until) throw new Error('GPU timestamp readback did not complete.'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    const render = (frameId, stages, measured = true) => {
      const ticket = measured ? profiler.beginFrame(frameId) : null, encoder = device.createCommandEncoder();
      check(!measured || ticket !== null, 'A completed readback slot must be reusable.');
      for (const stage of stages) {
        const pass = encoder.beginRenderPass({ label: stage, colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }], timestampWrites: profiler.timestampWrites(ticket, stage) });
        pass.setPipeline(pipeline); pass.draw(3); pass.end();
      }
      profiler.resolve(encoder, ticket); device.queue.submit([encoder.finish()]); profiler.submitted(ticket);
    };
    const pixel = async () => {
      const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer: pixels, bytesPerRow: 256 }, [1,1]); device.queue.submit([encoder.finish()]);
      await pixels.mapAsync(GPUMapMode.READ); const value = Array.from(new Uint8Array(pixels.getMappedRange()).subarray(0,4)); pixels.unmap(); return value;
    };
    try {
      device.pushErrorScope('validation');
      render(10, GPU_PROFILE_STAGES); render(11, ['opaque','temporal','post']); render(12, ['opaque','water','post']);
      check(profiler.beginFrame(99) === null, 'Three pending mappings must cause profiling to skip without blocking.');
      check(profiler.stats().gpuProfiler.inFlight === 3, 'Readback resources must be bounded at three.');
      await waitFor(() => profiler.stats().gpuSampleCount === 3);
      check(samples.map(sample => sample.frameId).join(',') === '10,11,12', 'Native readbacks must publish in frame order.');
      const completed = profiler.stats();
      check(completed.gpuPassSampleCounts.sky === 1 && completed.gpuPassSampleCounts.water === 2 && completed.gpuPassSampleCounts.opaque === 3, 'Only active queries may be accumulated.');
      check(completed.lastGpuPassMs.sky === null && completed.lastGpuPassMs.temporal === null, 'Skipped cached passes must have null raw timings.');
      check(completed.gpuProfiler.bufferBytes === 832 && completed.gpuProfiler.queryCount === 26, 'GPU profiler resources must remain fixed.');
      for (const sample of samples) {
        check(Number.isFinite(sample.totalMs) && sample.totalMs >= 0 && sample.totalMs < 10000, 'Frame duration must be a finite native GPU sample.');
        for (const value of Object.values(sample.passMs)) check(value === null || Number.isFinite(value) && value >= 0 && value < 10000, 'Pass durations must be valid or inactive.');
      }
      const measuredPixel = await pixel(); render(13, ['post']); await waitFor(() => profiler.stats().gpuSampleCount === 4);
      render(14, ['post'], false); const directPixel = await pixel();
      check(measuredPixel.join(',') === directPixel.join(','), 'Profiling must preserve rendered output.');
      const last = profiler.stats(); check(last.gpuProfiler.inFlight === 0 && last.gpuProfiler.skippedFrames === 1, 'Completed slots must return to the ring.');
      const abort = profiler.beginFrame(20); profiler.timestampWrites(abort, 'post'); check(profiler.cancel(abort), 'An aborted encoder must release its timing slot.');
      render(21, ['opaque','post']); profiler.destroy();
      await new Promise(resolve => setTimeout(resolve, 30));
      check(profiler.stats().gpuSampleCount === 4 && profiler.stats().gpuProfiler.inFlight === 0, 'Destroy must suppress pending samples and release readbacks.');
      const scoped = await device.popErrorScope(); if (scoped) validation.push(scoped.message);
      check(validation.length === 0, validation.join('\n'));
      standalone = { adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description }, stages: GPU_PROFILE_STAGES, samples, completed: last, afterDestroy: profiler.stats(), measuredPixel, directPixel, validation };
    } finally { profiler.destroy(); pixels.destroy(); texture.destroy(); device.destroy(); }

    const { createRenderer } = await import('/src/renderer.js'), { FULLBRIGHT, EYES_TRANSLUCENT } = await import('/src/actor-layers.js');
    document.body.replaceChildren();
    const groundPoints = [[-4,-.5,-4],[-4,-.5,4],[4,-.5,4],[-4,-.5,-4],[4,-.5,4],[4,-.5,-4]];
    const waterPoints = groundPoints.map(([x,,z]) => [x * .8,0,z * .8]);
    const wall = (x, y, z, size = 1) => [[x,y,z],[x+size,y,z],[x+size,y+size,z],[x,y,z],[x+size,y+size,z],[x,y+size,z]];
    const quad = (positions, normal, color, flags = 0, tile = 0) => new Float32Array(positions.flatMap((position, i) => [...position,...normal,...color,1,i % 2,i % 3,tile,flags | 512 | 15 << 10]));
    const concat = (...arrays) => { const result = new Float32Array(arrays.reduce((length, array) => length + array.length, 0)); let offset = 0; for (const array of arrays) { result.set(array, offset); offset += array.length; } return result; };
    const worldBounds = { min: [-8,-4,-8], max: [8,8,8] }, wallBounds = { min: [-1,0,-2], max: [1,2,-1] };
    const frame = { eye: [0,2,4], yaw: 0, pitch: -.35, timeSeconds: 10, dayPhase: .22, quality: 'balanced', scale: 1 };
    const runs = [];
    for (const enabled of [true, false]) {
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
      const nativeSamples = [], renderer = await createRenderer(canvas, { gpuProfiling: enabled, onGpuSample: sample => nativeSamples.push(sample) });
      const captures = [];
      const capture = async options => {
        renderer.render({ ...frame, ...options });
        const hdr = await renderer.readPixels(), depth = await renderer.readPixels({ source: 'depth' });
        if (enabled) await waitFor(() => nativeSamples.length === captures.length + 1);
        check(renderer.stats().lastError === null, renderer.stats().lastError);
        captures.push({ hdr: Array.from(hdr.pixels), depth: Array.from(depth.pixels), stats: renderer.stats(), sample: nativeSamples.at(-1) ?? null });
      };
      try {
        renderer.setTextureAtlas({ pixelsRGBA: new Uint8Array([255,255,255,255,255,255,255,128]), width: 2, height: 1,
          tiles: [{ id: 0,x: 0,y: 0,width: 1,height: 1 },{ id: 1,x: 1,y: 0,width: 1,height: 1 }] });
        renderer.configureWorld(worldBounds);
        renderer.uploadChunk('ground', quad(groundPoints,[0,1,0],[.2,.6,.2]), [], worldBounds, { stride: 14 });
        renderer.uploadChunk('water', [], quad(waterPoints,[0,1,0],[.1,.3,.5],4), worldBounds, { stride: 14 });
        renderer.uploadChunk('glass', quad(wall(-1,.2,-1,1.5),[0,0,1],[.4,.7,.9],64,1), [], wallBounds, { stride: 14 });
        renderer.uploadDynamicMesh('mob', concat(quad(wall(-.5,0,-2),[0,0,1],[.8,.2,.1]),quad(wall(-.4,.6,-1.99,.3),[0,0,1],[.2,.2,.4],FULLBRIGHT | EYES_TRANSLUCENT,1)), [], wallBounds, { stride: 14 });
        renderer.uploadFirstPersonMesh(quad(wall(.15,1.3,3,.2),[0,0,1],[.7,.5,.3],FULLBRIGHT), [], { min: [.15,1.3,3], max: [.35,1.5,3] });
        await capture(); await capture();
        if (enabled) {
          check(GPU_PROFILE_STAGES.every(stage => captures[0].sample.passMs[stage] !== null), 'The actual first renderer frame must exercise all 13 native stage pairs.');
          for (const stage of ['sky','staticShadow','dynamicShadow']) check(captures[1].sample.passMs[stage] === null && captures[1].sample.passTimestamps[stage] === null, `${stage} must be omitted after cache reuse.`);
          check(captures[1].stats.gpuProfile.gpuPassSampleCounts.staticShadow === 1, 'Cached static shadow queries must not increment their count.');
        }
        renderer.removeChunk('water'); renderer.removeChunk('glass'); renderer.removeMesh('mob'); renderer.clearFirstPersonMesh();
        await capture({ quality: 'low' });
        if (enabled) for (const stage of ['actorLayers','transparent','water','firstPerson','temporal','bloomExtract','bloomHorizontal','bloomVertical']) check(captures[2].sample.passMs[stage] === null, `${stage} must be omitted when disabled or absent.`);
        check(captures.every(value => value.depth.some(depth => depth < .999)), 'The actual renderer proof must draw depth-writing world geometry.');
        runs.push({ enabled, captures, stats: renderer.stats() });
      } finally { renderer.destroy(); canvas.remove(); }
    }
    const mismatch = (a, b) => { check(a.length === b.length, 'Image sizes must match.'); return a.reduce((count, value, index) => count + (value !== b[index] ? 1 : 0), 0); };
    const comparisons = runs[0].captures.map((capture, index) => ({ frame: index, hdrMismatches: mismatch(capture.hdr, runs[1].captures[index].hdr), depthMismatches: mismatch(capture.depth, runs[1].captures[index].depth) }));
    check(comparisons.every(value => value.hdrMismatches === 0 && value.depthMismatches === 0), 'Actual renderer HDR and depth must be identical with profiling enabled and disabled.');
    check(runs[1].stats.gpuProfile.gpuProfiler.bufferBytes === 0, 'Disabled instrumentation must allocate no timing resources.');
    return { ...standalone, renderer: { samples: runs[0].captures.map(value => value.sample), profiledStats: runs[0].stats, directStats: runs[1].stats, comparisons } };
  });
  assert.deepEqual(errors, []); assert.equal(proof.samples.length, 4);
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/gpu-profile.json', JSON.stringify({ softwareSmoke: software, proof, errors }, null, 2));
  console.log(JSON.stringify({ softwareSmoke: software, proof, errors }, null, 2));
} finally { await browser.close(); }
