// ── Metric registry ─────────────────────────────────────────────────────────
//
// Plain JS metric snapshots. Effect's Metric module is genuinely powerful but
// its hot-path overhead (Effect.runSync on every record) is wrong for the
// reducer loop here. We keep counters and histograms in `Map<string, …>`
// keyed by `"<name>{tag=value,tag=value}"` and expose a snapshot accessor
// the dev panel and `window.__revv.metrics()` both read.

import { bumpVersion } from "./version";

export interface CounterValue {
  readonly count: number;
}

const counters = new Map<string, { count: number }>();
const histograms = new Map<
  string,
  {
    count: number;
    sum: number;
    min: number;
    max: number;
    /** Recency-weighted FIFO ring of the last `HISTOGRAM_SAMPLE_CAP` samples. */
    samples: number[];
    ringIdx: number;
  }
>();

// FIFO over reservoir for perf debugging: a current slowdown should show up
// in p50/p95 *now*, not be diluted by hours of history. Recent N samples is
// directly meaningful — "what's the p95 of the last 256 reducer events?".
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
  bumpVersion();
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
    h = { count: 0, sum: 0, min: value, max: value, samples: [], ringIdx: 0 };
    histograms.set(k, h);
  }
  h.count += 1;
  h.sum += value;
  if (value < h.min) h.min = value;
  if (value > h.max) h.max = value;
  if (h.samples.length < HISTOGRAM_SAMPLE_CAP) {
    h.samples.push(value);
  } else {
    h.samples[h.ringIdx] = value;
    h.ringIdx = (h.ringIdx + 1) % HISTOGRAM_SAMPLE_CAP;
  }
  bumpVersion();
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

// ── Top-N partial snapshot ──────────────────────────────────────────────────
//
// `snapshot()` sorts every histogram's 256-sample buffer to compute p50/p95.
// With per-PR / per-walkthrough tagging, histogram cardinality scales with
// active entries (50–200 keys is realistic). The dev panel only renders the
// top 20, so paying O(H × S log S) on every refresh is wasted work.
//
// `snapshotTop(n)` picks the top N histograms by `max` first (cheap — `max`
// is maintained on insert, no sort needed), then sorts only their samples.
// Drops worst-case work from O(H × S log S) to O(H + N × S log S).

export interface TopHistogramEntry {
  readonly key: string;
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
}

export interface TopCounterEntry {
  readonly key: string;
  readonly count: number;
}

export interface MetricsTopSnapshot {
  readonly counters: ReadonlyArray<TopCounterEntry>;
  readonly histograms: ReadonlyArray<TopHistogramEntry>;
}

export function snapshotTop(n: number): MetricsTopSnapshot {
  const topCounters: TopCounterEntry[] = [];
  for (const [key, v] of counters) topCounters.push({ key, count: v.count });
  topCounters.sort((a, b) => b.count - a.count);
  topCounters.length = Math.min(topCounters.length, n);

  const candidates: Array<{ key: string; max: number }> = [];
  for (const [key, v] of histograms) candidates.push({ key, max: v.max });
  candidates.sort((a, b) => b.max - a.max);
  if (candidates.length > n) candidates.length = n;

  const topHistograms: TopHistogramEntry[] = candidates.map(({ key }) => {
    // biome-ignore lint/style/noNonNullAssertion: key came from the histograms map a moment ago.
    const h = histograms.get(key)!;
    const sorted = [...h.samples].sort((a, b) => a - b);
    const len = sorted.length;
    return {
      key,
      count: h.count,
      min: h.min,
      max: h.max,
      p50: sorted[Math.floor(len * 0.5)] ?? 0,
      p95: sorted[Math.floor(len * 0.95)] ?? 0,
    };
  });

  return { counters: topCounters, histograms: topHistograms };
}
