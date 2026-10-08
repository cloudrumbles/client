import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Exercise production pipelines and retained buffers. Generated admission
// textures make exact source-encoded blend and alpha thresholds inspectable.
const software = process.env.POMME_SOFTWARE_GPU === '1', errors = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(software ? ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'] : [])] });
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/src/shaders/breaking.wgsl', process.env.POMME_URL ?? 'http://127.0.0.1:5173').href);
  const proof = await page.evaluate(async () => {
    const { createRenderer } = await import('/src/renderer.js');
    const { crumblingRenderState } = await import('/src/breaking-overlay.js');
    const { FULLBRIGHT } = await import('/src/actor-layers.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const deadline = async (promise, label) => {
      let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15000); })]); }
      finally { clearTimeout(timer); }
    };
    const half = bits => { const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, mantissa = bits & 1023;
      return sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24); };
    const pixel = (image, x = Math.floor(image.width / 2), y = Math.floor(image.height / 2)) => Array.from(image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4), half);
    const near = (actual, expected, label, tolerance = .0015) => check(actual.every((value, axis) => Math.abs(value - expected[axis]) < tolerance), `${label}: ${JSON.stringify({ actual, expected })}`);
    const exact = (actual, expected, label) => {
      if (actual.length === expected.length && actual.every((value, index) => value === expected[index])) return;
      const mismatches = actual.reduce((count,value,index) => count + (value !== expected[index] ? 1 : 0),0);
      const maximum = actual.reduce((value,item,index) => Math.max(value,Math.abs(item-expected[index])),0);
      throw new Error(`${label}: ${JSON.stringify({ mismatches,maximum })}`);
    };
    const translatedDepth = (actual,expected,label) => {
      let maximum = 0, mismatches = 0;
      check(actual.length === expected.length,`${label} image sizes differ`);
      for (let index = 0; index < actual.length; index++) {
        check((actual[index] < .999999) === (expected[index] < .999999),`${label} changed raster coverage`);
        maximum = Math.max(maximum,Math.abs(actual[index]-expected[index])); mismatches += actual[index] !== expected[index] ? 1 : 0;
      }
      // The existing terrain VP is Float32. A retained anchor translation can
      // alter the final depth rounding while preserving every covered pixel.
      // Keep this separate from the exact depth-write checks for crack stages.
      check(maximum <= .000002,`${label}: ${JSON.stringify({ maximum,mismatches })}`);
      return { maximum,mismatches,exact:mismatches === 0,bound:.000002,exactRasterCoverage:true };
    };
    const positions = [[.125,.125,0],[.875,.125,0],[.875,.875,0],[.125,.125,0],[.875,.875,0],[.125,.875,0]];
    const uv = [[0,1],[1,1],[1,0],[0,1],[1,0],[0,0]];
    const mesh = (tile, { color = [1,1,1], flags = 0, points = positions, repeats = 1, reversed = false } = {}) => {
      const indices = reversed ? [0,2,1,3,5,4] : [0,1,2,3,4,5];
      return new Float32Array(indices.flatMap(index => [...points[index],0,0,1,...color,1,...uv[index].map(value => value * repeats),tile,flags]));
    };
    const localBounds = { min: [.125,.125,0], max: [.875,.875,0] }, baseColor = [.4,.2,.1];
    const atlasPixels = [[255,255,255,255],[128,128,128,255],[64,64,64,255],[32,128,224,255],[64,64,64,25],[64,64,64,26],[64,64,64,255],[192,192,192,255],[255,255,255,128]];
    const atlas = { pixelsRGBA: new Uint8Array(atlasPixels.flat()), width: 9, height: 1,
      tiles: [...atlasPixels.slice(0,6).map((_, id) => ({ id,x:id,y:0,width:1,height:1 })),{ id:6,x:6,y:0,width:2,height:1 },{ id:7,x:8,y:0,width:1,height:1 }] };
    const frame = { eye: [.5,.5,2], yaw: 0, pitch: 0, timeSeconds: 10, dayPhase: .22, quality: 'low', scale: 1 };
    document.body.replaceChildren();
    const make = async () => {
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:128px;height:128px'; document.body.append(canvas);
      const samples = [], renderer = await createRenderer(canvas, { onGpuSample: sample => samples.push(sample) }); renderer.setTextureAtlas(atlas);
      return { renderer, samples, close() { renderer.destroy(); canvas.remove(); } };
    };
    const setup = (renderer, origin = [0,0,0], fogDensity = 0, windowOffset = [0,0,0]) => {
      renderer.configureWorld({ min: origin.map((value, axis) => value + windowOffset[axis] - 8), max: origin.map((value, axis) => value + windowOffset[axis] + 8), fogDensity });
      renderer.uploadChunk('base', mesh(0, { color: baseColor, flags: FULLBRIGHT }), [], { min: origin.map((value, axis) => value + localBounds.min[axis]), max: origin.map((value, axis) => value + localBounds.max[axis] + .0001) }, { stride: 14, origin });
    };
    const draw = async (run, options = {}) => {
      run.renderer.render({ ...frame,...options });
      const [hdr, depth] = await deadline(Promise.all([run.renderer.readPixels(),run.renderer.readPixels({ source: 'depth' })]), 'Production breaking HDR/depth readback');
      check(run.renderer.stats().lastError === null, run.renderer.stats().lastError);
      return { hdr,depth,stats:run.renderer.stats() };
    };
    const update = (renderer, tile, { origin = [0,0,0], stage = tile, version = '1.20.4', ...options } = {}) => renderer.uploadBreakingMesh('native-block', mesh(tile,options), localBounds, { origin,stage,renderState:crumblingRenderState(version) });
    const cacheFields = ['meshUploadCount','meshUploadBytes','dynamicMeshUploads','dynamicGeometryBytes','shadowUpdates','dynamicShadowUpdates','skyCacheUpdates','terrainBundleEncodes','shadowBundleEncodes','renderBundleInvalidations'];
    const run = await make(), cases = [], captures = {};
    let baseline, cache;
    try {
      setup(run.renderer); baseline = await draw(run); await draw(run); cache = run.renderer.stats();
      near(pixel(baseline.hdr).slice(0,3),baseColor,'Known fullbright production base');
      check(baseline.depth.pixels.some(value => value < .999), 'Blend assertions require actual depth-writing base geometry.');
      for (let tile = 1; tile <= 5; tile++) {
        update(run.renderer,tile); const capture = await draw(run), source = atlasPixels[tile];
        const expected = source[3] / 255 < .1 ? pixel(baseline.hdr).slice(0,3) : pixel(baseline.hdr).slice(0,3).map((value, axis) => value * source[axis] * 2 / 255);
        near(pixel(capture.hdr).slice(0,3),expected,`Native source-unorm modulation tile${tile}`);
        if (tile === 5) near(pixel(capture.hdr).slice(3),[26 / 255],'Native one/zero alpha blend');
        exact(capture.depth.pixels,baseline.depth.pixels,`Stage${tile} must preserve every depth pixel`);
        for (const field of cacheFields) check(capture.stats[field] === cache[field], `Stage${tile} altered ${field}.`);
        check(capture.stats.breaking.allocations === 1 && capture.stats.breaking.drawCalls === 1, 'Stage changes must reuse one dedicated buffer.');
        cases.push({ tile, source, expected, actual:pixel(capture.hdr), depthMismatches:0, retainedAllocations:capture.stats.breaking.allocations });
      }
      update(run.renderer,2,{ reversed:true }); const back = await draw(run);
      exact(back.hdr.pixels,baseline.hdr.pixels,'Native breaking back faces must be culled.'); exact(back.depth.pixels,baseline.depth.pixels,'Back faces preserve depth.');
      // UV repetition is independent of atlas tiles and source sRGB decoding.
      update(run.renderer,6,{ stage:6,repeats:2 }); const repeat = await draw(run);
      const row = Math.floor(repeat.hdr.height / 2), samples = [];
      for (let x = 40; x < 88; x++) {
        const before = pixel(baseline.hdr,x,row), after = pixel(repeat.hdr,x,row);
        if (before[0] > .3) samples.push({ x,ratio:after[0] / before[0] });
      }
      check(samples.some(value => Math.abs(value.ratio - 128/255) < .004) && samples.some(value => Math.abs(value.ratio - 384/255) < .004), 'Repeated UVs must reach both encoded source texels.');
      let transitions = 0; for (let index = 1; index < samples.length; index++) if (Math.abs(samples[index].ratio - samples[index-1].ratio) > .2) transitions++;
      check(transitions >= 2, `Native UV fract repetition must repeat the two source texels (${transitions}).`);
      const stable = run.renderer.stats(); for (let index = 0; index < 3; index++) await draw(run);
      check(run.renderer.stats().breaking.uploads === stable.breaking.uploads && run.renderer.stats().breaking.allocations === stable.breaking.allocations, 'Stable frames must not upload or allocate breaking buffers.');
      const retained = run.renderer.stats().breaking.bufferBytes; check(run.renderer.removeBreakingMesh('native-block'), 'Native removal must retire the active mesh.');
      const pending = run.renderer.stats().breaking; check(pending.meshes === 0 && pending.pendingRemovals === 1 && pending.bufferBytes === retained, 'Removal footprint must retain its buffer until submission.');
      const removed = await draw(run); exact(removed.hdr.pixels,baseline.hdr.pixels,'Removal restores production HDR'); exact(removed.depth.pixels,baseline.depth.pixels,'Removal preserves depth');
      check(removed.stats.breaking.pendingRemovals === 0 && removed.stats.breaking.bufferBytes === 0 && removed.stats.breaking.drawCalls === 1, 'Submitted removal footprint must release its buffer.');
      await draw(run); check(run.renderer.stats().breaking.drawCalls === 0, 'Removal footprint must run for exactly one frame.');
      captures.uvRepeat = { transitions, samples }; captures.cache = Object.fromEntries(cacheFields.map(field => [field,cache[field]]));

      // Native1.20.4 omits overlay fog; the modern pipeline admits it. The
      // renderer base is held fixed while only that source-derived bit changes.
      run.renderer.configureWorld({ min:[-8,-8,-8],max:[8,8,8],fogDensity:.12 }); const fogBase = await draw(run);
      update(run.renderer,2,{ version:'1.20.4' }); const legacy = await draw(run);
      near(pixel(legacy.hdr).slice(0,3),pixel(fogBase.hdr).slice(0,3).map(value => value * 128/255),'Legacy native overlay omits fog');
      update(run.renderer,2,{ version:'1.21.11' }); const modern = await draw(run);
      check(pixel(modern.hdr).slice(0,3).some((value,axis) => Math.abs(value-pixel(legacy.hdr)[axis]) > .01), 'Modern source fog must affect actual production overlay pixels.');
      exact(modern.depth.pixels,fogBase.depth.pixels,'Fog cannot alter depth'); captures.fog = { legacy:pixel(legacy.hdr),modern:pixel(modern.hdr),base:pixel(fogBase.hdr) };
    } finally { run.close(); }

    // Accumulate history with crack stages, then remove without resetting the
    // whole world. A second renderer keeps the identical jitter/frame schedule.
    const temporal = await make(), control = await make();
    try {
      setup(temporal.renderer); setup(control.renderer);
      // A later transparent pass must preserve the breaking rejection channel
      // underneath it rather than overwrite that channel with a shader's zero.
      const glass = mesh(7,{ color:[.1,.35,.7],flags:64 | 512 | 15 << 10,points:positions.map(([x,y]) => [x,y,.2]) });
      for (const renderer of [temporal.renderer,control.renderer]) renderer.uploadChunk('glass',glass,[],{ min:[.125,.125,.2],max:[.875,.875,.201] },{ stride:14 });
      for (let index = 0; index < 3; index++) { await draw(temporal,{quality:'balanced'}); await draw(control,{quality:'balanced'}); }
      const before = temporal.renderer.stats(); check(before.historyUsed,'The temporal proof must start with valid accumulated history.');
      const cleanCenter = pixel(await deadline(control.renderer.readPixels(),'Clean temporal center'));
      const baseFraction = 1 - 128 / 255 * .45;
      for (let stage = 0; stage < 3; stage++) {
        update(temporal.renderer,stage % 2 ? 1 : 2,{stage}); const cracked = await draw(temporal,{quality:'balanced'}); await draw(control,{quality:'balanced'});
        check(cracked.stats.historyUsed && cracked.stats.temporalResets === before.temporalResets,'Native progress must preserve global temporal history.');
        near(pixel(cracked.hdr).slice(0,3),baseColor.map((value,axis) => cleanCenter[axis] + value * baseFraction * ((stage % 2 ? 256 : 128)/255-1)),'Reactive crack stages under glass reject old colors',.002);
      }
      temporal.renderer.removeBreakingMesh('native-block'); const removal = await draw(temporal,{quality:'balanced'}), clean = await draw(control,{quality:'balanced'});
      check(removal.stats.historyUsed && removal.stats.temporalResets === before.temporalResets,'Removing native cracks must preserve global temporal history.');
      let interiorPixels = 0;
      for (let y = 54; y < 74; y++) for (let x = 54; x < 74; x++) { near(pixel(removal.hdr,x,y),pixel(clean.hdr,x,y),'Removal reactive footprint clears history',.0006); interiorPixels++; }
      exact(removal.depth.pixels,clean.depth.pixels,'Temporal removal cannot alter world depth');
      check(removal.stats.breaking.pendingRemovals === 0 && removal.stats.breaking.bufferBytes === 0,'Temporal removal buffer must release after submission.');
      const after = await draw(temporal,{quality:'balanced'}); await draw(control,{quality:'balanced'});
      check(after.stats.breaking.drawCalls === 0 && after.stats.historyUsed && after.stats.temporalResets === before.temporalResets,'Removed overlay must stop drawing without resetting history.');
      captures.temporal = { interiorPixels, laterTransparentPass:true, historyUsed:removal.stats.historyUsed, resetsBefore:before.temporalResets,resetsAfter:after.stats.temporalResets,removed:removal.stats.breaking };
    } finally { temporal.close(); control.close(); }

    // Every coordinate axis is native Float64. Local fractions must survive
    // admission at +/-2b and subsequent retained-buffer render-origin changes.
    const dimensions = [], precise = await make(); let originCapture;
    try {
      for (const origin of [[0,0,0],[2000000000,2000000000,2000000000],[-2000000000,-2000000000,-2000000000],[2000000123,-1999999877,2000000123]]) {
        setup(precise.renderer,origin); update(precise.renderer,2,{origin,stage:9}); const camera = origin.map((value,axis) => value + frame.eye[axis]);
        const image = await draw(precise,{eye:camera}); if (!originCapture) originCapture = image;
        exact(image.hdr.pixels,originCapture.hdr.pixels,`Extreme origin${origin} must preserve exact HDR`);
        const nativeDepth = translatedDepth(image.depth.pixels,originCapture.depth.pixels,`Extreme origin${origin} depth`);
        const before = image.stats.breaking;
        precise.renderer.configureWorld({ min:origin.map(value => value+256-8),max:origin.map(value => value+256+8),fogDensity:0 });
        const rebased = await draw(precise,{eye:camera}); exact(rebased.hdr.pixels,image.hdr.pixels,'All-axis retained origin rebase must preserve HDR');
        const rebasedDepth = translatedDepth(rebased.depth.pixels,image.depth.pixels,'All-axis retained origin rebase depth');
        check(rebased.stats.breaking.allocations === before.allocations && rebased.stats.breaking.rebases === before.rebases+1,'Render-origin changes must rewrite the retained buffer once without allocating.');
        dimensions.push({ origin,renderOrigin:rebased.stats.renderOrigin,exactHdr:true,nativeDepth,rebasedDepth,allocations:rebased.stats.breaking.allocations,rebases:rebased.stats.breaking.rebases });
      }
      captures.adapter = precise.renderer.stats().adapterInfo;
    } finally { precise.close(); }
    return { productionRenderer:true,sourceEncodedBlend:'2 * src * dst',alphaThreshold:{discard:25,retain:26,divisor:255},depthWrite:false,cases,captures,dimensions };
  });
  assert.deepEqual(errors, []); await mkdir('test-results', { recursive:true });
  await writeFile('test-results/breaking-renderer.json',JSON.stringify({ softwareSmoke:software,proof,errors },null,2));
  console.log(JSON.stringify({ softwareSmoke:software,proof,errors },null,2));
} finally { await browser.close(); }
