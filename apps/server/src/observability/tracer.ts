// ── Server-side observability ───────────────────────────────────────────────
//
// In-memory span ring buffer backed by an OpenTelemetry SpanExporter.
// Provides both a custom ring-buffer exporter (always active) and an
// optional ConsoleSpanExporter gated on REV_DEBUG=1.
//
// Why not use Effect's built-in Tracer directly? We do — via
// @effect/opentelemetry's NodeSdk.layer, which wires Effect's Tracer to
// the OTel SDK. Our SpanExporter sits at the OTel SDK boundary and
// receives every span that Effect.withSpan creates, plus any manual OTel
// spans from non-Effect code (e.g. chat-opencode.ts).

import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { serverEnv } from "../config";

// ── Ring-buffer types ───────────────────────────────────────────────────────

export interface CompletedSpan {
  /** Monotonic id, useful as a key in dev panels. */
  readonly id: number;
  /** Span operation name, e.g. "WalkthroughJobs.resumePending". */
  readonly name: string;
  /** OTel trace id (hex string). */
  readonly traceId: string;
  /** OTel span id (hex string). */
  readonly spanId: string;
  /** Parent span id, or null if root. */
  readonly parentSpanId: string | null;
  readonly startMs: number;
  readonly durationMs: number;
  readonly attrs: Readonly<Record<string, unknown>>;
  /** Captured Error if the span ended with error status. */
  readonly error: { name: string; message: string } | null;
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

// ── Ring buffer implementation ──────────────────────────────────────────────

const RING_CAPACITY = 500;
const ring: CompletedSpan[] = [];
let ringIdx = 0;
let nextSpanId = 1;

function push(span: CompletedSpan): void {
  if (ring.length < RING_CAPACITY) {
    ring.push(span);
  } else {
    ring[ringIdx] = span;
    ringIdx = (ringIdx + 1) % RING_CAPACITY;
  }
}

/** Push one manually-constructed span into the ring. Used by non-Effect
 *  instrumentation (e.g. Elysia HTTP hooks) that can't use Effect.withSpan. */
export function recordSpan(
  name: string,
  startMs: number,
  durationMs: number,
  attrs: Readonly<Record<string, unknown>>,
  error?: { name: string; message: string } | null,
): void {
  push({
    id: nextSpanId++,
    name,
    traceId: "manual",
    spanId: `manual-${nextSpanId}`,
    parentSpanId: null,
    startMs,
    durationMs,
    attrs,
    error: error ?? null,
  });
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

/** Group spans by name and compute per-name summary stats. */
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

// ── OTel → ring buffer converter ────────────────────────────────────────────

function extractError(span: ReadableSpan): { name: string; message: string } | null {
  // OTel SpanStatusCode: 0 = UNSET, 1 = OK, 2 = ERROR
  if (span.status.code === 2) {
    const msg = span.status.message ?? "span error";
    // Try to find an exception event for richer info
    const ev = span.events.find((e) => e.name === "exception");
    if (ev) {
      const type = ev.attributes?.["exception.type"] ?? "Error";
      const message = ev.attributes?.["exception.message"] ?? msg;
      return { name: String(type), message: String(message) };
    }
    return { name: "Error", message: msg };
  }
  return null;
}

function readableSpanToCompleted(span: ReadableSpan): CompletedSpan {
  const sc = span.spanContext();
  const parent = span.parentSpanContext;
  return {
    id: nextSpanId++,
    name: span.name,
    traceId: sc.traceId,
    spanId: sc.spanId,
    parentSpanId: parent ? parent.spanId : null,
    startMs: hrTimeToMilliseconds(span.startTime),
    durationMs: hrTimeToMilliseconds(span.duration),
    attrs: { ...span.attributes },
    error: extractError(span),
  };
}

// ── Custom SpanExporter ─────────────────────────────────────────────────────

class RevSpanExporter implements SpanExporter {
  export(spans: readonly ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    for (const span of spans) {
      push(readableSpanToCompleted(span));
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush?(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Effect TracingLive layer ────────────────────────────────────────────────

const processors = [new BatchSpanProcessor(new RevSpanExporter())];

if (serverEnv.revDebug) {
  processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
}

export const TracingLive = NodeSdk.layer(() => ({
  resource: { serviceName: "revv-server" },
  spanProcessor: processors,
}));
