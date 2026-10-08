import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuPassProfiler, GPU_PROFILE_STAGES, recordGpuBenchmarkSample } from '../src/gpu-profile.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, QUERY_RESOLVE: 512 };
globalThis.GPUMapMode ??= { READ: 1 };

const flush = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };
const first = () => GPU_PROFILE_STAGES[0];
const second = () => GPU_PROFILE_STAGES[1];
const post = () => GPU_PROFILE_STAGES.at(-1);

class FakeBuffer {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.bytes = new ArrayBuffer(descriptor.size);
    this.mapState = 'unmapped';
    this.mapCalls = 0;
    this.unmapCalls = 0;
    this.destroyCalls = 0;
    this.pending = null;
  }

  mapAsync(mode) {
    assert.equal(mode, GPUMapMode.READ);
    assert.equal(this.mapState, 'unmapped', 'a pending or mapped buffer cannot be submitted again');
    this.mapCalls++;
    if (this.throwOnMap) throw new Error('synchronous map failure');
    this.mapState = 'pending';
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  complete(values) {
    assert.ok(this.pending, 'only a submitted readback can complete');
    new BigUint64Array(this.bytes).set(values);
    this.mapState = this.destroyCalls ? 'unmapped' : 'mapped';
    const pending = this.pending;
    this.pending = null;
    pending.resolve();
  }

  fail() {
    assert.ok(this.pending);
    this.mapState = 'unmapped';
    const pending = this.pending;
    this.pending = null;
    pending.reject(new Error('asynchronous map failure'));
  }

  getMappedRange() {
    if (this.throwOnRead) throw new Error('mapped range unavailable');
    assert.equal(this.mapState, 'mapped');
    return this.bytes;
  }

  unmap() {
    this.unmapCalls++;
    this.mapState = 'unmapped';
    if (this.throwOnUnmap) throw new Error('unmap failure');
  }

  destroy() {
    this.destroyCalls++;
    this.mapState = 'unmapped';
  }
}

function harness({ enabled = true, supported = true, alpha = .15 } = {}) {
  const buffers = [], querySets = [], samples = [], encoders = [];
  const device = {
    features: new Set(supported ? ['timestamp-query'] : []),
    createQuerySet(descriptor) {
      const query = { descriptor, destroyCalls: 0, destroy() { this.destroyCalls++; } };
      querySets.push(query);
      return query;
    },
    createBuffer(descriptor) {
      const buffer = new FakeBuffer(descriptor);
      buffers.push(buffer);
      return buffer;
    },
    queue: {
      onSubmittedWorkDone() { throw new Error('profiling must never wait for the GPU queue'); },
    },
  };
  const profiler = new GpuPassProfiler(device, { enabled, alpha, onSample: sample => samples.push(sample) });
  const encoder = () => {
    const value = {
      resolves: [], copies: [],
      resolveQuerySet(...args) { this.resolves.push(args); },
      copyBufferToBuffer(...args) { this.copies.push(args); },
    };
    encoders.push(value);
    return value;
  };
  return { profiler, device, buffers, querySets, samples, encoders, encoder };
}

function timestamps(pairs) {
  const values = new BigUint64Array(GPU_PROFILE_STAGES.length * 2);
  // Unwritten query locations can contain timestamps from a previous frame.
  // Making every unused pair invalid catches accidental whole-array validation.
  for (let index = 0; index < values.length; index += 2) {
    values[index] = 9n;
    values[index + 1] = 1n;
  }
  for (const [stage, [start, end]] of Object.entries(pairs)) {
    const index = GPU_PROFILE_STAGES.indexOf(stage);
    assert.ok(index >= 0);
    values[index * 2] = BigInt(start);
    values[index * 2 + 1] = BigInt(end);
  }
  return values;
}

function frame(h, id, stages = [first(), post()]) {
  const mapCalls = new Map(h.buffers.map(buffer => [buffer, buffer.mapCalls]));
  const ticket = h.profiler.beginFrame(id);
  assert.ok(ticket);
  const writes = stages.map(stage => h.profiler.timestampWrites(ticket, stage));
  const encoder = h.encoder();
  assert.equal(h.profiler.resolve(encoder, ticket), true);
  const buffer = encoder.copies.at(-1)[2];
  assert.equal(buffer.mapCalls, mapCalls.get(buffer), 'mapping starts after the renderer submits the command buffer');
  const submittedBefore = performance.now();
  assert.equal(h.profiler.submitted(ticket), true);
  const submittedAfter = performance.now();
  return { ticket, writes, encoder, buffer, submittedBefore, submittedAfter };
}

function fullFrameValues(durationMs) {
  const end = BigInt(Math.round(durationMs * 1_000_000)) + 1_000_000n;
  return timestamps({
    [first()]: [1_000_000n, 1_000_000n],
    [post()]: [end, end],
  });
}

test('unsupported timestamps and an explicitly disabled profiler allocate no GPU resources', () => {
  for (const options of [{ supported: false }, { enabled: false }]) {
    const h = harness(options);
    assert.equal(h.profiler.beginFrame(1), null);
    assert.equal(h.buffers.length, 0);
    assert.equal(h.querySets.length, 0);
    assert.equal(h.profiler.stats().gpuMs, null);
    h.profiler.destroy();
    assert.equal(h.buffers.length, 0);
  }
});

test('three readbacks bound in-flight work and reuse a single query set and resolve buffer', async () => {
  const h = harness();
  assert.equal(GPU_PROFILE_STAGES.length, 14);
  assert.equal(new Set(GPU_PROFILE_STAGES).size, 14);
  assert.equal(post(), 'post');
  assert.equal(h.querySets.length, 1);
  assert.equal(h.querySets[0].descriptor.count, 28);
  assert.equal(h.buffers.length, 4, 'one persistent resolve buffer and three persistent readbacks');
  const pending = [1, 2, 3].map(id => frame(h, id));
  assert.equal(new Set(pending.map(value => value.buffer)).size, 3);
  assert.equal(h.profiler.beginFrame(4), null);
  assert.equal(h.profiler.stats().gpuProfiler.skippedFrames, 1);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 3);
  const source = pending[0].encoder.copies[0][0];
  for (const item of pending) {
    assert.deepEqual(item.encoder.resolves, [[h.querySets[0], 0, 28, source, 0]]);
    assert.deepEqual(item.encoder.copies, [[source, 0, item.buffer, 0, 224]]);
    assert.equal(item.writes[0].querySet, h.querySets[0]);
    assert.equal(item.writes[0].beginningOfPassWriteIndex, 0);
    assert.equal(item.writes[0].endOfPassWriteIndex, 1);
    assert.equal(item.writes[1].beginningOfPassWriteIndex, 26);
    assert.equal(item.writes[1].endOfPassWriteIndex, 27);
  }
  pending[0].buffer.complete(fullFrameValues(1));
  await flush();
  const reused = frame(h, 4);
  assert.equal(reused.buffer, pending[0].buffer);
  assert.equal(h.querySets.length, 1);
  assert.equal(h.buffers.length, 4);
  assert.equal(h.profiler.stats().gpuProfiler.bufferBytes, 896);
  for (const item of [...pending.slice(1), reused]) item.buffer.complete(fullFrameValues(1));
  await flush();
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  h.profiler.destroy();
});

test('out-of-order readbacks unmap promptly but publish every sample in submission order', async () => {
  const h = harness({ alpha: .25 });
  const a = frame(h, 100), b = frame(h, 101), c = frame(h, 102);
  b.buffer.complete(fullFrameValues(20));
  c.buffer.complete(fullFrameValues(36));
  await flush();
  assert.equal(b.buffer.unmapCalls, 1);
  assert.equal(c.buffer.unmapCalls, 1);
  new BigUint64Array(b.buffer.bytes).fill(0n);
  new BigUint64Array(c.buffer.bytes).fill(0n);
  assert.equal(h.samples.length, 0, 'later frames wait for the preceding sample, not the GPU');
  assert.equal(h.profiler.stats().gpuSampleCount, 0);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 3);
  assert.equal(h.profiler.beginFrame(103), null);
  a.buffer.complete(fullFrameValues(8));
  await flush();
  assert.deepEqual(h.samples.map(sample => sample.frameId), [100, 101, 102]);
  assert.deepEqual(h.samples.map(sample => sample.totalMs), [8, 20, 36]);
  assert.deepEqual(h.samples.map(sample => sample.frameTimestamps), [
    { beginNs: '1000000', endNs: '9000000' },
    { beginNs: '1000000', endNs: '21000000' },
    { beginNs: '1000000', endNs: '37000000' },
  ], 'FIFO timestamps are owned copies after the original mapped bytes are overwritten');
  assert.deepEqual(h.samples.map(sample => sample.sampleCount), [1, 2, 3]);
  assert.equal(h.profiler.stats().gpuMs, 17.25);
  assert.equal(h.profiler.stats().lastGpuMs, 36);
  assert.equal(h.profiler.stats().lastGpuFrameId, 102);
  assert.equal(h.profiler.stats().gpuProfiler.publishedFrames, 3);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  h.profiler.destroy();
});

test('a frame that reuses cached sky and shadow work starts its total at the first actual pass', async () => {
  const h = harness(), item = frame(h, 7, ['opaque', 'post']);
  item.buffer.complete(timestamps({ opaque: [10_000_000n, 12_000_000n], post: [15_000_000n, 17_000_000n] }));
  await flush();
  assert.equal(item.writes[0].beginningOfPassWriteIndex, 6);
  assert.equal(item.writes[0].endOfPassWriteIndex, 7);
  assert.equal(h.profiler.stats().lastGpuMs, 7);
  assert.equal(h.profiler.stats().lastGpuPassMs.sky, null);
  assert.equal(h.profiler.stats().lastGpuPassMs.staticShadow, null);
  assert.equal(h.profiler.stats().lastGpuPassMs.dynamicShadow, null);
  assert.equal(h.profiler.stats().lastGpuPassMs.opaque, 2);
  h.profiler.destroy();
});

test('only written pairs contribute and absent post passes keep valid stage timings', async () => {
  const h = harness();
  const a = frame(h, 1);
  a.buffer.complete(timestamps({ [first()]: [1_000_000n, 3_000_000n], [post()]: [8_000_000n, 9_000_000n] }));
  await flush();
  assert.equal(h.profiler.stats().lastGpuMs, 8, 'frame total includes inter-pass gaps');
  assert.equal(h.profiler.stats().lastGpuPassMs[first()], 2);
  assert.equal(h.profiler.stats().lastGpuPassMs[post()], 1);
  assert.equal(h.profiler.stats().gpuProfiler.invalidSamples, 0);
  const b = frame(h, 2, [first()]);
  b.buffer.complete(timestamps({ [first()]: [4_000_000n, 4_500_000n] }));
  await flush();
  const stats = h.profiler.stats();
  assert.equal(h.samples.at(-1).totalMs, null);
  assert.equal(h.samples.at(-1).frameTimestamps, null);
  assert.deepEqual(h.samples.at(-1).passTimestamps[first()], { beginNs: '4000000', endNs: '4500000' });
  assert.equal(h.samples.at(-1).passTimestamps[post()], null);
  assert.equal(stats.lastGpuPassMs[first()], .5);
  assert.equal(stats.lastGpuPassMs[post()], null, 'inactive raw stage timings clear on publication');
  assert.equal(stats.gpuPassMs[first()], 1.775);
  assert.equal(stats.gpuPassMs[post()], 1, 'stage averages retain earlier valid samples');
  assert.equal(stats.gpuPassSampleCounts[first()], 2);
  assert.equal(stats.gpuPassSampleCounts[post()], 1);
  assert.equal(stats.gpuPassLastSampleFrameIds[first()], 2);
  assert.equal(stats.gpuPassLastSampleFrameIds[post()], 1);
  assert.equal(stats.gpuSampleCount, 1, 'a stage-only sample cannot claim a whole-frame GPU duration');
  assert.equal(stats.lastGpuFrameId, 1, 'the raw frame duration and frame ID continue to describe the same total sample');
  assert.equal(stats.lastGpuPassFrameId, 2);
  assert.equal(stats.gpuProfiler.publishedFrames, 2);
  h.profiler.destroy();
});

test('zero and sub-ten-second samples are finite, while invalid stages or totals reject a whole sample', async t => {
  const cases = [
    { name: 'zero duration', values: fullFrameValues(0), valid: true },
    { name: 'one nanosecond below ten seconds', values: timestamps({ [first()]: [1n, 1n], [post()]: [9_999_999_999n, 10_000_000_000n] }), valid: true },
    { name: 'negative active pair', values: timestamps({ [first()]: [5n, 4n], [post()]: [6n, 7n] }), valid: false },
    { name: 'exactly ten seconds in an active pair', values: timestamps({ [first()]: [0n, 10_000_000_000n], [post()]: [10_000_000_000n, 10_000_000_000n] }), valid: false },
    { name: 'valid individual passes but oversized total', values: timestamps({ [first()]: [0n, 1_000_000n], [post()]: [11_000_000_000n, 11_001_000_000n] }), valid: false },
    { name: 'maximum Uint64 timestamp span', values: timestamps({ [first()]: [0n, 18_446_744_073_709_551_615n], [post()]: [0n, 0n] }), valid: false },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const h = harness(), item = frame(h, 1);
    item.buffer.complete(entry.values);
    await flush();
    const stats = h.profiler.stats();
    assert.equal(stats.gpuProfiler.invalidSamples, entry.valid ? 0 : 1);
    assert.equal(stats.gpuSampleCount, entry.valid ? 1 : 0);
    assert.equal(stats.gpuProfiler.publishedFrames, entry.valid ? 1 : 0);
    assert.equal(item.buffer.unmapCalls, 1);
    assert.equal(stats.gpuProfiler.inFlight, 0);
    if (entry.valid) assert.ok(Number.isFinite(stats.lastGpuMs) && stats.lastGpuMs >= 0 && stats.lastGpuMs < 10_000);
    else assert.equal(stats.gpuPassSampleCounts[first()], 0, 'invalid samples cannot partially update averages');
    h.profiler.destroy();
  });
});

test('synchronous map errors, rejected maps and failed mapped-range reads release reusable slots', async t => {
  for (const failure of ['throwOnMap', 'reject', 'throwOnRead', 'throwOnUnmap']) await t.test(failure, async () => {
    const h = harness();
    const ticket = h.profiler.beginFrame(1);
    h.profiler.timestampWrites(ticket, first());
    h.profiler.timestampWrites(ticket, post());
    const encoder = h.encoder();
    assert.equal(h.profiler.resolve(encoder, ticket), true);
    const buffer = encoder.copies[0][2];
    if (failure !== 'reject') buffer[failure] = true;
    assert.doesNotThrow(() => h.profiler.submitted(ticket));
    if (failure === 'reject') buffer.fail();
    else if (failure === 'throwOnRead' || failure === 'throwOnUnmap') buffer.complete(fullFrameValues(5));
    await flush();
    assert.equal(h.profiler.stats().gpuProfiler.readbackFailures, 1);
    assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
    assert.equal(h.profiler.stats().gpuSampleCount, 0);
    assert.equal(buffer.mapState, 'unmapped');
    if (failure === 'throwOnRead' || failure === 'throwOnUnmap') assert.equal(buffer.unmapCalls, 1, 'mapped read cleanup always attempts to unmap');
    buffer.throwOnMap = false;
    buffer.throwOnRead = false;
    buffer.throwOnUnmap = false;
    const retries = [];
    for (let id = 2; id <= 4; id++) {
      const retry = frame(h, id);
      retries.push(retry);
      retry.buffer.complete(fullFrameValues(2));
      await flush();
    }
    assert.ok(retries.some(retry => retry.buffer === buffer), 'the failed slot returns to the readback ring');
    assert.equal(h.profiler.stats().gpuSampleCount, 3);
    assert.equal(h.buffers.length, 4);
    h.profiler.destroy();
  });
});

test('a failed earlier readback unblocks already-completed later frames', async () => {
  const h = harness();
  const a = frame(h, 10), b = frame(h, 11);
  b.buffer.complete(fullFrameValues(4));
  await flush();
  assert.equal(h.samples.length, 0);
  a.buffer.fail();
  await flush();
  assert.deepEqual(h.samples.map(sample => sample.frameId), [11]);
  assert.equal(h.profiler.stats().gpuProfiler.readbackFailures, 1);
  assert.equal(h.profiler.stats().gpuSampleCount, 1);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  h.profiler.destroy();
});

test('encoding order guards prevent duplicate queries and cancelled frames reuse the ring', () => {
  const h = harness();
  const ticket = h.profiler.beginFrame(1);
  h.profiler.timestampWrites(ticket, second());
  assert.throws(() => h.profiler.timestampWrites(ticket, second()), /order|duplicate|written/i);
  assert.throws(() => h.profiler.timestampWrites(ticket, first()), /order/i);
  assert.throws(() => h.profiler.timestampWrites(ticket, 'missing-stage'), /stage|unknown/i);
  h.profiler.cancel(ticket);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  const resolved = h.profiler.beginFrame(2);
  h.profiler.timestampWrites(resolved, post());
  h.profiler.resolve(h.encoder(), resolved);
  h.profiler.cancel(resolved);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  assert.equal(h.profiler.stats().gpuProfiler.abortedFrames, 2);
  assert.ok(h.profiler.beginFrame(3));
  assert.equal(h.buffers.length, 4);
  h.profiler.destroy();
});

test('destroy releases all resources once and pending readbacks can never publish afterward', async () => {
  const h = harness();
  const a = frame(h, 1), b = frame(h, 2), c = frame(h, 3);
  b.buffer.complete(fullFrameValues(8));
  await flush();
  assert.equal(b.buffer.unmapCalls, 1);
  h.profiler.destroy();
  h.profiler.destroy();
  assert.equal(h.profiler.beginFrame(4), null);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  assert.ok(h.buffers.every(buffer => buffer.destroyCalls === 1));
  assert.equal(h.querySets[0].destroyCalls, 1);
  a.buffer.complete(fullFrameValues(5));
  c.buffer.fail();
  await flush();
  assert.equal(h.samples.length, 0);
  assert.equal(h.profiler.stats().gpuSampleCount, 0);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  assert.equal(h.buffers.length, 4);
});

test('an empty or failed command encoding does not strand the FIFO', async () => {
  const h = harness();
  const empty = h.profiler.beginFrame(1);
  assert.equal(h.profiler.resolve(h.encoder(), empty), false);
  const failed = h.profiler.beginFrame(2);
  h.profiler.timestampWrites(failed, 'opaque');
  assert.throws(() => h.profiler.resolve({ resolveQuerySet() { throw new Error('encoder failure'); } }, failed), /encoder failure/);
  assert.equal(h.profiler.stats().gpuProfiler.abortedFrames, 2);
  assert.equal(h.profiler.stats().gpuProfiler.inFlight, 0);
  const next = frame(h, 3);
  next.buffer.complete(fullFrameValues(1));
  await flush();
  assert.deepEqual(h.samples.map(sample => sample.frameId), [3]);
  assert.equal(h.profiler.stats().gpuProfiler.publishedFrames, 1);
  h.profiler.destroy();
});

test('a consumer callback failure cannot strand later samples or expose mutable profiler state', async () => {
  const h = harness();
  h.profiler.onSample = sample => {
    sample.passMs.opaque = -1;
    throw new Error('consumer failure');
  };
  const a = frame(h, 1, ['opaque', 'post']), b = frame(h, 2, ['opaque', 'post']);
  b.buffer.complete(timestamps({ opaque: [1n, 2_000_001n], post: [4_000_001n, 5_000_001n] }));
  a.buffer.complete(timestamps({ opaque: [1n, 1_000_001n], post: [2_000_001n, 3_000_001n] }));
  await flush();
  const stats = h.profiler.stats();
  assert.equal(stats.gpuProfiler.callbackFailures, 2);
  assert.equal(stats.gpuProfiler.publishedFrames, 2);
  assert.equal(stats.gpuProfiler.inFlight, 0);
  assert.equal(stats.lastGpuPassMs.opaque, 2);
  stats.lastGpuPassMs.opaque = -2;
  stats.gpuPassMs.opaque = -2;
  stats.gpuPassSampleCounts.opaque = -2;
  assert.equal(h.profiler.stats().lastGpuPassMs.opaque, 2);
  assert.equal(h.profiler.stats().gpuPassMs.opaque, 1.15);
  assert.equal(h.profiler.stats().gpuPassSampleCounts.opaque, 2);
  h.profiler.destroy();
});

test('partial resource allocation failures clean up every successfully created GPU object', async t => {
  for (let failingBuffer = 0; failingBuffer < 4; failingBuffer++) await t.test(`buffer ${failingBuffer}`, () => {
    const buffers = [];
    const query = { destroyCalls: 0, destroy() { this.destroyCalls++; } };
    const device = {
      features: new Set(['timestamp-query']),
      createQuerySet() { return query; },
      createBuffer(descriptor) {
        if (buffers.length === failingBuffer) throw new Error('allocation failure');
        const buffer = new FakeBuffer(descriptor);
        buffers.push(buffer);
        return buffer;
      },
    };
    assert.throws(() => new GpuPassProfiler(device), /allocation failure/);
    assert.equal(query.destroyCalls, 1);
    assert.equal(buffers.length, failingBuffer);
    assert.ok(buffers.every(buffer => buffer.destroyCalls === 1));
    assert.ok(buffers.every(buffer => buffer.mapState === 'unmapped'));
  });
});

test('native timestamp strings preserve Uint64 precision and use the host submission clock', async () => {
  const h = harness();
  const item = frame(h, 9, ['opaque', 'post']);
  const base = 9_223_372_036_854_775_001n;
  item.buffer.complete(timestamps({ opaque: [base, base + 1n], post: [base + 2n, base + 3n] }));
  await flush();
  const sample = h.samples[0];
  assert.ok(Number.isFinite(sample.submittedAtMs));
  assert.ok(sample.submittedAtMs >= item.submittedBefore && sample.submittedAtMs <= item.submittedAfter,
    'host submission time is captured when readback is scheduled, independently of GPU time');
  assert.equal(sample.totalMs, .000003);
  assert.equal(sample.passMs.opaque, .000001);
  assert.deepEqual(sample.frameTimestamps, { beginNs: base.toString(), endNs: (base + 3n).toString() });
  assert.deepEqual(sample.passTimestamps.opaque, { beginNs: base.toString(), endNs: (base + 1n).toString() });
  assert.deepEqual(sample.passTimestamps.post, { beginNs: (base + 2n).toString(), endNs: (base + 3n).toString() });
  for (const stage of GPU_PROFILE_STAGES.filter(stage => stage !== 'opaque' && stage !== 'post')) {
    assert.equal(sample.passTimestamps[stage], null, `${stage} has no timestamp pair in this frame`);
  }
  assert.equal(BigInt(sample.frameTimestamps.endNs) - BigInt(sample.frameTimestamps.beginNs), 3n);
  assert.deepEqual(JSON.parse(JSON.stringify(sample)).frameTimestamps, sample.frameTimestamps,
    'benchmark JSON encodes raw GPU timestamps without rounding or BigInt serialization errors');
  assert.equal(h.profiler.stats().gpuProfiler.bufferBytes, 896);
  assert.equal(h.buffers.length, 4);
  h.profiler.destroy();
});

test('mutating callback timestamp objects cannot alter subsequent samples or prior retained samples', async () => {
  const h = harness();
  const raw = [], mutated = [];
  h.profiler.onSample = sample => {
    raw.push(structuredClone(sample));
    sample.frameTimestamps.beginNs = 'broken';
    sample.passTimestamps.opaque.endNs = 'broken';
    sample.passTimestamps.post = null;
    mutated.push(sample);
  };
  const base = 9_007_199_254_740_993n;
  const readbacks = [];
  for (let id = 1; id <= 4; id++) {
    const item = frame(h, id, ['opaque', 'post']);
    readbacks.push(item.buffer);
    const start = base + BigInt(id) * 10_000_000n;
    item.buffer.complete(timestamps({ opaque: [start, start + 1_000_000n], post: [start + 2_000_000n, start + 3_000_000n] }));
    await flush();
    new BigUint64Array(item.buffer.bytes).fill(0n);
    assert.deepEqual(raw.at(-1).frameTimestamps, { beginNs: start.toString(), endNs: (start + 3_000_000n).toString() });
    assert.deepEqual(raw.at(-1).passTimestamps.opaque, { beginNs: start.toString(), endNs: (start + 1_000_000n).toString() });
    assert.deepEqual(raw.at(-1).passTimestamps.post, { beginNs: (start + 2_000_000n).toString(), endNs: (start + 3_000_000n).toString() });
  }
  assert.equal(readbacks[3], readbacks[0], 'the fourth sample exercises the reused first slot');
  assert.notEqual(mutated[0].frameTimestamps, mutated[3].frameTimestamps);
  assert.notEqual(mutated[0].passTimestamps, mutated[3].passTimestamps);
  assert.notEqual(mutated[0].passTimestamps.opaque, mutated[3].passTimestamps.opaque);
  assert.equal(mutated[0].frameTimestamps.beginNs, 'broken', 'later slot reuse cannot overwrite a retained callback object');
  assert.equal(h.profiler.stats().gpuProfiler.callbackFailures, 0);
  assert.equal(h.profiler.stats().gpuSampleCount, 4);
  assert.equal(h.querySets.length, 1);
  assert.equal(h.buffers.length, 4);
  h.profiler.destroy();
});

function benchmarkCapture(start = 100_000) {
  return { start, gpu: [], gpuPasses: [] };
}

function benchmarkSample(frameId, submittedAtMs) {
  const base = 9_007_199_254_740_993n + BigInt(frameId) * 10_000_000n;
  return {
    frameId, submittedAtMs, totalMs: 3,
    frameTimestamps: { beginNs: base.toString(), endNs: (base + 3_000_000n).toString() },
    passMs: Object.fromEntries(GPU_PROFILE_STAGES.map(stage => [stage, stage === 'opaque' || stage === 'post' ? 1 : null])),
    passTimestamps: Object.fromEntries(GPU_PROFILE_STAGES.map(stage => [stage,
      stage === 'opaque' ? { beginNs: base.toString(), endNs: (base + 1_000_000n).toString() }
        : stage === 'post' ? { beginNs: (base + 2_000_000n).toString(), endNs: (base + 3_000_000n).toString() } : null])),
  };
}

test('benchmark warmup excludes a delayed pre-warmup submission by its submission clock', () => {
  const capture = benchmarkCapture();
  const delayed = benchmarkSample(1, capture.start + 1_999);
  delayed.completedAtMs = capture.start + 20_000;
  assert.equal(recordGpuBenchmarkSample(capture, delayed), false);
  assert.equal(capture.gpu.length, 0);
  assert.equal(capture.gpuPasses.length, 0);
  assert.equal(recordGpuBenchmarkSample(capture, benchmarkSample(2, capture.start + 2_000)), true);
  assert.equal(capture.gpuPasses[0].routeSeconds, 2);
});

test('benchmark route boundaries use submission time independently of readback completion', () => {
  const capture = benchmarkCapture();
  const delayed = benchmarkSample(9, capture.start + 29_999);
  delayed.completedAtMs = capture.start + 40_000;
  assert.equal(recordGpuBenchmarkSample(capture, delayed), true);
  assert.equal(capture.gpuPasses[0].routeSeconds, 29.999);
  assert.equal(recordGpuBenchmarkSample(capture, benchmarkSample(10, capture.start + 30_000)), true);
  assert.equal(recordGpuBenchmarkSample(capture, benchmarkSample(11, capture.start + 30_001)), false);
  assert.deepEqual(capture.gpuPasses.map(sample => sample.frameId), [9, 10]);
});

test('benchmark capture rejects stage-only samples, invalid times and inactive benchmarks', () => {
  const capture = benchmarkCapture();
  const stageOnly = { ...benchmarkSample(1, capture.start + 5_000), totalMs: null, frameTimestamps: null };
  assert.equal(recordGpuBenchmarkSample(capture, stageOnly), false);
  for (const value of [NaN, Infinity, -1, 10_000]) {
    assert.equal(recordGpuBenchmarkSample(capture, { ...benchmarkSample(2, capture.start + 5_000), totalMs: value }), false);
  }
  assert.equal(recordGpuBenchmarkSample(capture, benchmarkSample(3, NaN)), false);
  assert.equal(recordGpuBenchmarkSample(null, benchmarkSample(4, capture.start + 5_000)), false);
  assert.equal(capture.gpu.length, 0);
  assert.equal(capture.gpuPasses.length, 0);
});

test('benchmark callback capture preserves every same-turn FIFO sample', async () => {
  const h = harness(), capture = benchmarkCapture(performance.now() - 5_000);
  h.profiler.onSample = sample => recordGpuBenchmarkSample(capture, sample);
  const a = frame(h, 10), b = frame(h, 11);
  b.buffer.complete(fullFrameValues(5));
  await flush();
  assert.equal(capture.gpu.length, 0);
  a.buffer.complete(fullFrameValues(3));
  await flush();
  assert.deepEqual(capture.gpu, [3, 5]);
  assert.deepEqual(capture.gpuPasses.map(sample => sample.frameId), [10, 11]);
  assert.deepEqual(capture.gpuPasses.map(sample => sample.frameTimestamps.endNs), ['4000000', '6000000']);
  h.profiler.destroy();
});

test('benchmark capture owns nested native timestamp pairs and durations', () => {
  const capture = benchmarkCapture(), source = benchmarkSample(5, capture.start + 7_500);
  const expected = structuredClone(source);
  assert.equal(recordGpuBenchmarkSample(capture, source), true);
  const stored = capture.gpuPasses[0];
  assert.notEqual(stored.passMs, source.passMs);
  assert.notEqual(stored.frameTimestamps, source.frameTimestamps);
  assert.notEqual(stored.passTimestamps, source.passTimestamps);
  assert.notEqual(stored.passTimestamps.opaque, source.passTimestamps.opaque);
  source.totalMs = -1;
  source.passMs.opaque = -1;
  source.frameTimestamps.beginNs = 'corrupted';
  source.passTimestamps.opaque.endNs = 'corrupted';
  source.passTimestamps.post = null;
  assert.deepEqual(capture.gpu, [3]);
  assert.equal(stored.routeSeconds, 7.5);
  assert.deepEqual(stored.passMs, expected.passMs);
  assert.deepEqual(stored.frameTimestamps, expected.frameTimestamps);
  assert.deepEqual(stored.passTimestamps, expected.passTimestamps);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)).frameTimestamps, expected.frameTimestamps);
});
