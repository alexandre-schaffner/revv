// ── Metric registry ─────────────────────────────────────────────────────────
//
// Plain JS metric snapshots. Effect's Metric module is genuinely powerful but
// its hot-path overhead (Effect.runSync on every record) is wrong for the
// reducer loop here. We keep counters and histograms in `Map<string, …>`
// keyed by `"<name>{tag=value,tag=value}"` and expose a snapshot accessor
// the dev panel and `window.__revv.metrics()` both read.

export interface CounterValue {
  readonly count: number;
}

const counters = new Map<string, { count: number }>();
const histograms = new Map<
  string,
  { count: number; sum: number; min: number; max: number; samples: number[] }
>();

const HISTOGRAM_SAMPLE_CAP = 256;

function key(name: string, tags?: Record<string, unknown>): string {
  if (!tags) return name;
  const parts: string[] = [];
  for (const k of Object.keys(tags).sort()) {
    parts.push(`${k}=${String(tags[k])}`);
  }
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

export function recordCounter(
  name: string,
  tags: Record<string, unknown> | undefined,
  delta = 1,
): void {
  const k = key(name, tags);
  let c = counters.get(k);
  if (!c) {
    c = { count: 0 };
    counters.set(k, c);
  }
  c.count += delta;
}

export function recordHistogram(
  name: string,
  tags: Record<string, unknown> | undefined,
  value: number,
): void {
  if (!Number.isFinite(value)) return;
  const k = key(name, tags);
  let h = histograms.get(k);
  if (!h) {
    h = { count: 0, sum: 0, min: value, max: value, samples: [] };
    histograms.set(k, h);
  }
  h.count += 1;
  h.sum += value;
  if (value < h.min) h.min = value;
  if (value > h.max) h.max = value;
  if (h.samples.length < HISTOGRAM_SAMPLE_CAP) {
    h.samples.push(value);
  } else {
    // Reservoir sampling so older samples don't dominate forever.
    const idx = Math.floor(Math.random() * h.count);
    if (idx < HISTOGRAM_SAMPLE_CAP) h.samples[idx] = value;
  }
}

export interface MetricsSnapshot {
  readonly counters: Record<string, CounterValue>;
  readonly histograms: Record<
    string,
    { count: number; sum: number; avg: number; min: number; max: number; p50: number; p95: number }
  >;
}

export function snapshot(): MetricsSnapshot {
  const c: Record<string, CounterValue> = {};
  for (const [k, v] of counters) c[k] = { count: v.count };

  const h: MetricsSnapshot["histograms"] = {};
  for (const [k, v] of histograms) {
    const sorted = [...v.samples].sort((a, b) => a - b);
    const len = sorted.length;
    h[k] = {
      count: v.count,
      sum: v.sum,
      avg: v.sum / v.count,
      min: v.min,
      max: v.max,
      p50: sorted[Math.floor(len * 0.5)] ?? 0,
      p95: sorted[Math.floor(len * 0.95)] ?? 0,
    };
  }

  return { counters: c, histograms: h };
}

export function clearMetrics(): void {
  counters.clear();
  histograms.clear();
}
