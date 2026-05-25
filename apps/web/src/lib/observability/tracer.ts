import { bumpVersion } from "./version";

// ── Span ring buffer ────────────────────────────────────────────────────────
//
// In-memory tracer: every completed span is pushed into a fixed-size ring
// buffer that lives for the lifetime of the page. The buffer is the only
// surface — no exporter, no IO. Users inspect it via `window.__revv.spans()`
// in DevTools, or via the dev panel toggled with Ctrl+Shift+O.
//
// Why a hand-rolled JS recorder instead of Effect's `Tracer` infra: the hot
// path here is the walkthrough event reducer, which can fire hundreds of
// times per frame during an SSE burst. `Effect.runSync(Effect.withSpan(...))`
// adds object allocations per call we cannot afford in that loop. The Effect
// `Logger` (debug/info/warn/error) remains genuinely Effect-based — it's a
// rare path. The two surfaces compose naturally because they only share the
// `attrs` shape.

export interface CompletedSpan {
  /** Monotonic id, useful as a key in dev panels. */
  readonly id: number;
  /** `<subsystem>.<operation>` convention, e.g. "walkthrough.event". */
  readonly name: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly attrs: Readonly<Record<string, unknown>>;
  /** Captured Error if `fn` threw; null on success. */
  readonly error: { name: string; message: string } | null;
}

const RING_CAPACITY = 500;
const ring: CompletedSpan[] = [];
let ringIdx = 0;
let nextSpanId = 1;

/** Push one completed span into the ring. O(1). */
export function recordSpan(
  name: string,
  startMs: number,
  durationMs: number,
  attrs: Readonly<Record<string, unknown>>,
  error: unknown,
): void {
  const span: CompletedSpan = {
    id: nextSpanId++,
    name,
    startMs,
    durationMs,
    attrs,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message }
        : error != null
          ? { name: "NonError", message: String(error) }
          : null,
  };
  if (ring.length < RING_CAPACITY) {
    ring.push(span);
  } else {
    ring[ringIdx] = span;
    ringIdx = (ringIdx + 1) % RING_CAPACITY;
  }
  bumpVersion();
  if (verbose) emitVerboseLine(span);
}

/** Read the ring in chronological order. Snapshot — safe to iterate. */
export function readSpans(filter?: {
  name?: string | RegExp;
  minDurationMs?: number;
}): CompletedSpan[] {
  const head = ring.slice(ringIdx);
  const tail = ring.slice(0, ringIdx);
  const all = [...head, ...tail];
  if (!filter) return all;
  return all.filter((s) => {
    if (filter.minDurationMs != null && s.durationMs < filter.minDurationMs) return false;
    if (filter.name) {
      if (typeof filter.name === "string") {
        if (!s.name.includes(filter.name)) return false;
      } else if (!filter.name.test(s.name)) return false;
    }
    return true;
  });
}

export interface SpanSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly errorCount: number;
}

/**
 * Group the ring by span name and produce per-name summary stats. This is
 * the "money function" — call it in DevTools after a slow interaction to
 * see which span dominates.
 */
export function summarizeSpans(): Record<string, SpanSummary> {
  const buckets = new Map<string, number[]>();
  const errors = new Map<string, number>();
  for (const s of readSpans()) {
    let arr = buckets.get(s.name);
    if (!arr) {
      arr = [];
      buckets.set(s.name, arr);
    }
    arr.push(s.durationMs);
    if (s.error) errors.set(s.name, (errors.get(s.name) ?? 0) + 1);
  }
  const out: Record<string, SpanSummary> = {};
  for (const [name, durs] of buckets) {
    durs.sort((a, b) => a - b);
    const count = durs.length;
    const totalMs = durs.reduce((a, b) => a + b, 0);
    out[name] = {
      count,
      totalMs,
      avgMs: totalMs / count,
      p50: durs[Math.floor(count * 0.5)] ?? 0,
      p95: durs[Math.floor(count * 0.95)] ?? 0,
      max: durs[count - 1] ?? 0,
      errorCount: errors.get(name) ?? 0,
    };
  }
  return out;
}

export function clearSpans(): void {
  ring.length = 0;
  ringIdx = 0;
  nextSpanId = 1;
}

// ── Verbose console mode ────────────────────────────────────────────────────
//
// Off by default — even with instrumentation everywhere, DevTools stays
// quiet. Flip via `__revv.setVerbose(true)` or
// `localStorage["revv:obs"]==="1"` (the latter persists across reloads).

let verbose: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("revv:obs") === "1";
  } catch {
    return false;
  }
})();

export function setVerbose(value: boolean): void {
  verbose = value;
  if (typeof window !== "undefined") {
    try {
      if (value) window.localStorage.setItem("revv:obs", "1");
      else window.localStorage.removeItem("revv:obs");
    } catch {
      /* incognito / disabled storage */
    }
  }
}

export function isVerbose(): boolean {
  return verbose;
}

function emitVerboseLine(span: CompletedSpan): void {
  const dur =
    span.durationMs < 1 ? `${span.durationMs.toFixed(2)}ms` : `${Math.round(span.durationMs)}ms`;
  const attrSummary = Object.entries(span.attrs)
    .map(([k, v]) => `${k}=${formatAttrValue(v)}`)
    .join(" ");
  const prefix = span.error ? "[span:err]" : "[span]";
  const msg = `${prefix} ${span.name} ${dur}${attrSummary ? ` ${attrSummary}` : ""}`;
  if (span.error) {
    console.warn(msg, span.error);
  } else {
    console.debug(msg);
  }
}

function formatAttrValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "[obj]";
}
