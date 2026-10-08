export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

export function summarizeFrames(frames) {
  if (!frames.length) return null;
  const total = frames.reduce((a, b) => a + b, 0);
  return { samples: frames.length, averageFps: frames.length * 1000 / total, p50Ms: percentile(frames, 0.5), p95Ms: percentile(frames, 0.95), p99Ms: percentile(frames, 0.99), budgetMs: 1000 / 60, overBudgetPercent: 100 * frames.filter(x => x > 1000 / 60).length / frames.length };
}

export function summarizeGpuTimes(times) {
  if (!times.length) return null;
  return { samples: times.length, meanMs: times.reduce((a, b) => a + b, 0) / times.length, p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), p99Ms: percentile(times, 0.99) };
}

export class ResolutionController {
  constructor(scale = 0.85) { this.scale = scale; this.samples = []; this.lastChange = 0; }
  update(frameMs, now, maxScale = 1) {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250) return this.scale;
    this.samples.push(frameMs);
    if (this.samples.length < 90 || now - this.lastChange < 2000) return this.scale;
    const p90 = percentile(this.samples, 0.9);
    this.samples = [];
    if (p90 > 19) this.scale = Math.max(0.5, this.scale - 0.05);
    else if (p90 < 17.3) this.scale = Math.min(maxScale, this.scale + 0.025);
    this.lastChange = now;
    return this.scale;
  }
}
