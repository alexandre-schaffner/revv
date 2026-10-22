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

import * as OtelTracer from "@effect/opentelemetry/OtelTracer";
import * as OtelResource from "@effect/opentelemetry/Resource";
import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import { ExportResultCode, hrTimeToMilliseconds } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { Effect, Layer } from "effect";
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

const manualTracer = trace.getTracer("revv-server");

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

/** Keep only what OTel accepts as an attribute value; drop the rest. */
function toOtelAttributes(attrs: Readonly<Record<string, unknown>>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** Record a span through OTel; the exporter writes it to the debug ring once.
 * `startMs` uses performance.now(), shifted to epoch time for every exporter. */
export function recordSpan(
  name: string,
  startMs: number,
  durationMs: number,
  attrs: Readonly<Record<string, unknown>>,
  error?: { name: string; message: string } | null,
): void {
  const startEpochMs = performance.timeOrigin + startMs;
  const span = manualTracer.startSpan(name, {
    startTime: startEpochMs,
    attributes: toOtelAttributes(attrs),
  });
  if (error) {
    span.recordException({ name: error.name, message: error.message });
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  span.end(startEpochMs + durationMs);
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

const SERVICE_NAME = "revv-server";

// The ring buffer is an in-memory array write, so batching it buys nothing and
// costs visibility: batched, a span takes up to the processor's delay to appear
// in the in-app debug panel, and a flush has to be forced before any read.
// Simple = synchronous = the ring always reflects reality.
const processors: (SimpleSpanProcessor | BatchSpanProcessor)[] = [
  new SimpleSpanProcessor(new RevSpanExporter()),
];

if (serverEnv.revDebug) {
  processors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
}

if (serverEnv.otlpEndpoint) {
  processors.push(
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${serverEnv.otlpEndpoint}/v1/traces` })),
  );
}

/**
 * We build the provider ourselves instead of letting `NodeSdk.layer` do it,
 * for one reason: `NodeSdk.layer` hands its provider to Effect through the
 * Effect context and never registers it on the OpenTelemetry global API. Under
 * that setup `trace.getTracer(...)` returns a *no-op* tracer — verified: the
 * span it hands back reports `isRecording() === false` and a zeroed span
 * context, and nothing reaches an exporter.
 *
 * That silently discards every span created outside an Effect fiber, which is
 * most of the interesting instrumentation: the MCP tool handlers (separate
 * inbound HTTP requests), the ACP session-update listeners (plain callbacks on
 * the connection read loop), the Elysia HTTP hook, and the chat turn's token
 * stream. Registering the provider globally makes one provider serve both, so
 * `Effect.withSpan` and `trace.getTracer` land in the same trace.
 *
 * `setGlobalTracerProvider` rather than `provider.register()`: we only need the
 * tracer to resolve. `register()` would additionally install a global context
 * manager and propagator, and nothing here relies on ambient context — every
 * out-of-band span passes its parent explicitly (see span-graft.ts).
 */
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    "deployment.environment.name": serverEnv.channel,
  }),
  spanProcessors: processors,
});
trace.setGlobalTracerProvider(provider);

/**
 * Flush when the layer's scope closes. Spans sit in a `BatchSpanProcessor` for
 * up to its delay, so without this the tail of a run — including the terminal
 * spans that say how it ended — is lost exactly when you most want it.
 *
 * Deliberately flush-only, no `provider.shutdown()`. The provider is a
 * module-level singleton registered on the global OTel API, so shutting it down
 * on scope close would permanently disable tracing for the whole process the
 * first time any scope holding this layer closes — fine for the one runtime the
 * server disposes at exit, silently fatal for a second build (tests, scripts,
 * anything that provides the layer per-run). Flushing is all we need: at process
 * exit the process is going away regardless.
 *
 * The deadline is enforced on the PROMISE, not with `Effect.timeoutOption`,
 * because `Effect.promise` is uninterruptible — a timeout wrapper around it
 * still waits for the underlying promise to settle. That matters here: the
 * common case is an OTLP endpoint configured but not running (the collector is
 * dev-only, and `.env.example` ships an endpoint), and `forceFlush` then sits
 * through the exporter's whole connect-and-retry schedule. Wrapped in an Effect
 * timeout that stall lands squarely on `AppRuntime.dispose()`; raced at the
 * promise level it cannot.
 */
const FLUSH_DEADLINE_MS = 1_000;

function flushWithDeadline(): Promise<void> {
  const flushed = provider.forceFlush().catch(() => {
    /* a dead exporter must not surface as an unhandled rejection */
  });
  return Promise.race([
    flushed,
    new Promise<void>((resolve) => {
      setTimeout(resolve, FLUSH_DEADLINE_MS).unref?.();
    }),
  ]);
}

const FlushSpansOnClose = Layer.effectDiscard(
  Effect.addFinalizer(() => Effect.promise(flushWithDeadline).pipe(Effect.ignore)),
);

export const TracingLive = OtelTracer.layerGlobal.pipe(
  Layer.provide(OtelResource.layer({ serviceName: SERVICE_NAME })),
  Layer.merge(FlushSpansOnClose),
);
