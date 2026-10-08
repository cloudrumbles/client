export const GPU_PROFILE_STAGES = Object.freeze([
  'sky', 'staticShadow', 'dynamicShadow', 'opaque', 'actorLayers', 'breaking', 'transparent',
  'water', 'firstPerson', 'temporal', 'bloomExtract', 'bloomHorizontal', 'bloomVertical', 'post',
]);

const RING_SIZE = 3;
const QUERY_COUNT = GPU_PROFILE_STAGES.length * 2;
const QUERY_BYTES = QUERY_COUNT * 8;
const POST_INDEX = GPU_PROFILE_STAGES.indexOf('post');
const STAGE_INDEX = new Map(GPU_PROFILE_STAGES.map((stage, index) => [stage, index]));
const emptyPasses = value => Object.fromEntries(GPU_PROFILE_STAGES.map(stage => [stage, value]));

export function recordGpuBenchmarkSample(benchmark, sample) {
  if (!benchmark || sample.totalMs === null || !Number.isFinite(sample.totalMs) || sample.totalMs < 0 || sample.totalMs >= 10_000) return false;
  const routeSeconds = (sample.submittedAtMs - benchmark.start) / 1000;
  if (!Number.isFinite(routeSeconds) || routeSeconds < 2 || routeSeconds > 30) return false;
  benchmark.gpu.push(sample.totalMs);
  benchmark.gpuPasses.push({ frameId: sample.frameId, submittedAtMs: sample.submittedAtMs, routeSeconds, totalMs: sample.totalMs,
    passMs: { ...sample.passMs }, frameTimestamps: { ...sample.frameTimestamps },
    passTimestamps: Object.fromEntries(Object.entries(sample.passTimestamps).map(([stage, pair]) => [stage, pair && { ...pair }])),
  });
  return true;
}

function elapsedMs(begin, end) {
  if (end < begin) return null;
  const value = Number(end - begin) / 1_000_000;
  return Number.isFinite(value) && value >= 0 && value < 10_000 ? value : null;
}

/** Reuses timestamp resources; resolving a sample never waits in the render loop. */
export class GpuPassProfiler {
  constructor(device, { enabled = true, alpha = .15, onSample = null } = {}) {
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new Error('GPU timing alpha must be in (0, 1].');
    this.device = device; this.alpha = alpha; this.onSample = onSample;
    this.supported = Boolean(enabled && device.features?.has('timestamp-query'));
    this.destroyed = false; this.nextSequence = 0; this.nextPublish = 0; this.nextSlot = 0;
    this.gpuMs = null; this.lastGpuMs = null; this.gpuSampleCount = 0; this.lastGpuFrameId = null; this.lastGpuPassFrameId = null;
    this.lastGpuPassMs = emptyPasses(null); this.gpuPassMs = emptyPasses(null);
    this.gpuPassSampleCounts = emptyPasses(0); this.gpuPassLastSampleFrameIds = emptyPasses(null);
    this.skippedFrames = 0; this.invalidSamples = 0; this.readbackFailures = 0; this.abortedFrames = 0; this.publishedFrames = 0; this.callbackFailures = 0;
    this.querySet = null; this.resolveBuffer = null; this.slots = []; this.writes = [];
    if (!this.supported) return;
    try {
      this.querySet = device.createQuerySet({ label: 'Frame pass GPU timestamps', type: 'timestamp', count: QUERY_COUNT });
      this.resolveBuffer = device.createBuffer({ label: 'Frame pass GPU timestamp resolve', size: QUERY_BYTES, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      for (let index = 0; index < RING_SIZE; index++) this.slots.push({
        index, state: 'free', generation: -1, mask: 0, firstStage: -1, lastStage: -1, frameId: null,
        totalMs: null, outcome: null, submittedAtMs: null, passMs: new Float64Array(GPU_PROFILE_STAGES.length), timestamps: new BigUint64Array(QUERY_COUNT),
        buffer: device.createBuffer({ label: `Frame pass GPU timestamp readback ${index}`, size: QUERY_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
      });
      this.writes = GPU_PROFILE_STAGES.map((_, index) => Object.freeze({ querySet: this.querySet, beginningOfPassWriteIndex: index * 2, endOfPassWriteIndex: index * 2 + 1 }));
    } catch (error) { this.destroy(); throw error; }
  }

  beginFrame(frameId = this.nextSequence) {
    if (!this.supported || this.destroyed) return null;
    if (!Number.isSafeInteger(frameId) || frameId < 0) throw new Error('GPU timing frame ID must be a nonnegative safe integer.');
    let slot = null;
    for (let offset = 0; offset < RING_SIZE; offset++) {
      const candidate = this.slots[(this.nextSlot + offset) % RING_SIZE];
      if (candidate.state === 'free') { slot = candidate; break; }
    }
    if (!slot) { this.skippedFrames++; return null; }
    this.nextSlot = (slot.index + 1) % RING_SIZE;
    slot.state = 'encoding'; slot.generation = this.nextSequence++; slot.frameId = frameId;
    slot.mask = 0; slot.firstStage = -1; slot.lastStage = -1; slot.totalMs = null; slot.outcome = null; slot.submittedAtMs = null; slot.passMs.fill(NaN);
    return Object.freeze({ owner: this, index: slot.index, generation: slot.generation });
  }

  slotFor(ticket, state) {
    if (this.destroyed || ticket?.owner !== this) return null;
    const slot = this.slots[ticket.index];
    return slot && slot.generation === ticket.generation && (!state || slot.state === state) ? slot : null;
  }

  timestampWrites(ticket, stage) {
    if (!ticket) return undefined;
    const slot = this.slotFor(ticket, 'encoding');
    if (!slot) throw new Error('GPU timing frame is no longer encoding.');
    const index = STAGE_INDEX.get(stage);
    if (index === undefined) throw new Error(`Unknown GPU timing stage: ${stage}`);
    if (index <= slot.lastStage) throw new Error('GPU timing stages must be unique and follow render order.');
    slot.mask |= 1 << index;
    if (slot.firstStage < 0) slot.firstStage = index;
    slot.lastStage = index;
    return this.writes[index];
  }

  resolve(encoder, ticket) {
    const slot = this.slotFor(ticket, 'encoding');
    if (!slot) return false;
    if (!slot.mask) { this.cancel(ticket); return false; }
    try {
      encoder.resolveQuerySet(this.querySet, 0, QUERY_COUNT, this.resolveBuffer, 0);
      encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, QUERY_BYTES);
      slot.state = 'resolved'; return true;
    } catch (error) { this.cancel(ticket); throw error; }
  }

  submitted(ticket) {
    const slot = this.slotFor(ticket, 'resolved');
    if (!slot) return false;
    slot.state = 'pending'; slot.submittedAtMs = performance.now();
    let mapping;
    try { mapping = slot.buffer.mapAsync(GPUMapMode.READ); }
    catch { this.failReadback(slot); return false; }
    Promise.resolve(mapping).then(() => {
      if (!this.slotFor(ticket, 'pending')) return;
      try { this.readSample(slot, slot.buffer.getMappedRange()); }
      catch { slot.outcome = 'failed'; this.readbackFailures++; }
      finally {
        try { slot.buffer.unmap(); }
        catch { if (slot.outcome !== 'failed') { slot.outcome = 'failed'; this.readbackFailures++; } }
        slot.state = 'ready'; this.flush();
      }
    }, () => { if (this.slotFor(ticket, 'pending')) this.failReadback(slot); });
    return true;
  }

  failReadback(slot) { slot.outcome = 'failed'; slot.state = 'ready'; this.readbackFailures++; this.flush(); }

  readSample(slot, range) {
    const timestamps = new BigUint64Array(range);
    if (timestamps.length !== QUERY_COUNT) throw new Error('GPU timing readback has an unexpected length.');
    for (let index = 0; index < GPU_PROFILE_STAGES.length; index++) {
      if (!(slot.mask & 1 << index)) continue;
      const value = elapsedMs(timestamps[index * 2], timestamps[index * 2 + 1]);
      if (value === null) { slot.outcome = 'invalid'; this.invalidSamples++; return; }
      slot.passMs[index] = value;
    }
    if (slot.mask & 1 << POST_INDEX) {
      slot.totalMs = elapsedMs(timestamps[slot.firstStage * 2], timestamps[POST_INDEX * 2 + 1]);
      if (slot.totalMs === null) { slot.outcome = 'invalid'; this.invalidSamples++; return; }
    }
    slot.timestamps.set(timestamps); slot.outcome = 'valid';
  }

  flush() {
    for (;;) {
      const slot = this.slots.find(candidate => candidate.generation === this.nextPublish && candidate.state === 'ready');
      if (!slot) return;
      if (slot.outcome === 'valid') this.publish(slot);
      slot.state = 'free'; slot.outcome = null; this.nextPublish++;
    }
  }

  publish(slot) {
    this.lastGpuPassFrameId = slot.frameId; this.publishedFrames++;
    for (let index = 0; index < GPU_PROFILE_STAGES.length; index++) {
      const stage = GPU_PROFILE_STAGES[index], active = Boolean(slot.mask & 1 << index);
      this.lastGpuPassMs[stage] = active ? slot.passMs[index] : null;
      if (!active) continue;
      const value = slot.passMs[index], previous = this.gpuPassMs[stage];
      this.gpuPassMs[stage] = previous === null ? value : previous * (1 - this.alpha) + value * this.alpha;
      this.gpuPassSampleCounts[stage]++; this.gpuPassLastSampleFrameIds[stage] = slot.frameId;
    }
    if (slot.totalMs !== null) {
      this.lastGpuFrameId = slot.frameId; this.lastGpuMs = slot.totalMs; this.gpuSampleCount++;
      this.gpuMs = this.gpuMs === null ? slot.totalMs : this.gpuMs * (1 - this.alpha) + slot.totalMs * this.alpha;
    }
    if (this.onSample) {
      const pair = index => ({ beginNs: String(slot.timestamps[index * 2]), endNs: String(slot.timestamps[index * 2 + 1]) });
      const passTimestamps = Object.fromEntries(GPU_PROFILE_STAGES.map((stage, index) => [stage, slot.mask & 1 << index ? pair(index) : null]));
      const frameTimestamps = slot.totalMs === null ? null : { beginNs: String(slot.timestamps[slot.firstStage * 2]), endNs: String(slot.timestamps[POST_INDEX * 2 + 1]) };
      try { this.onSample({ frameId: slot.frameId, totalMs: slot.totalMs, passMs: { ...this.lastGpuPassMs }, passTimestamps, frameTimestamps, submittedAtMs: slot.submittedAtMs, gpuMs: this.gpuMs, sampleCount: this.gpuSampleCount }); }
      catch { this.callbackFailures++; }
    }
  }

  cancel(ticket) {
    const slot = this.slotFor(ticket);
    if (!slot || !['encoding', 'resolved'].includes(slot.state)) return false;
    slot.outcome = 'aborted'; slot.state = 'ready'; this.abortedFrames++; this.flush(); return true;
  }

  stats() {
    return {
      gpuTimingSupported: this.supported, gpuMs: this.gpuMs, lastGpuMs: this.lastGpuMs, gpuSampleCount: this.gpuSampleCount, lastGpuFrameId: this.lastGpuFrameId, lastGpuPassFrameId: this.lastGpuPassFrameId,
      lastGpuPassMs: { ...this.lastGpuPassMs }, gpuPassMs: { ...this.gpuPassMs }, gpuPassSampleCounts: { ...this.gpuPassSampleCounts }, gpuPassLastSampleFrameIds: { ...this.gpuPassLastSampleFrameIds },
      gpuProfiler: { ringSize: this.supported ? RING_SIZE : 0, queryCount: this.supported ? QUERY_COUNT : 0, inFlight: this.slots.filter(slot => slot.state !== 'free').length,
        skippedFrames: this.skippedFrames, invalidSamples: this.invalidSamples, readbackFailures: this.readbackFailures, abortedFrames: this.abortedFrames, publishedFrames: this.publishedFrames,
        callbackFailures: this.callbackFailures, bufferBytes: this.supported ? QUERY_BYTES * (RING_SIZE + 1) : 0, destroyed: this.destroyed },
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const slot of this.slots) { try { slot.buffer.unmap(); } catch {} slot.buffer.destroy(); slot.state = 'free'; }
    this.resolveBuffer?.destroy(); this.querySet?.destroy();
  }
}
