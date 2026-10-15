// ── Grafting out-of-band spans onto a live trace ─────────────────────────────
//
// A walkthrough generation is a four-minute span with almost nothing inside it,
// because the work that fills those four minutes happens *outside* the fiber
// that owns the span:
//
//   • MCP tool handlers. The agent calls them over HTTP from its own
//     subprocess, so OTel starts each one in a brand-new trace with no
//     relationship to the generation that provoked it.
//   • ACP session-update listeners. They fire on the connection's read loop —
//     a plain callback, no Effect fiber, so no ambient span to nest under.
//
// Both know the walkthrough id. The generation fiber publishes its span context
// under that key ("anchors" it); these helpers rebuild the context as a remote
// parent so those spans land inside the generation trace. Without this the
// waterfall stops at the fiber boundary and every question worth asking —
// how much of the wall clock was inference? how much was our own DB writes? —
// is unanswerable.
//
// Anchors are ephemeral, in-memory, and best-effort by construction: they only
// affect where a span is *filed*, never whether work happens. A missing anchor
// degrades to an unparented span, never an error.

import {
  type Attributes,
  context as otelContext,
  type Span,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { Effect } from "effect";

/** The two ids needed to re-create a span context as a remote parent. */
export interface TraceAnchor {
  readonly traceId: string;
  readonly spanId: string;
}

const tracer = trace.getTracer("revv-server");

/**
 * Live anchors, keyed by whatever the out-of-band producers can see — the
 * walkthrough id for generation, the recap id for recaps. Bounded by the number
 * of concurrent jobs (`MAX_CONCURRENT_JOBS`), and every publisher registers a
 * finalizer, so this map drains on every exit path including `kill -9` (process
 * death takes the map with it — nothing here is authoritative state).
 */
const anchors = new Map<string, TraceAnchor>();

/**
 * Publish `anchor` as the parent for out-of-band spans keyed on `key`.
 *
 * Returns a restore function that puts the previous anchor back, so nesting
 * composes: the driver anchors the generation span, then re-anchors the agent
 * turn inside it, and unwinding in reverse leaves the map exactly as it was.
 * Callers MUST wire the restore into a finalizer.
 */
export function publishTraceAnchor(key: string, anchor: TraceAnchor): () => void {
  const previous = anchors.get(key);
  anchors.set(key, anchor);
  return (): void => {
    if (previous) anchors.set(key, previous);
    else anchors.delete(key);
  };
}

/** Read the anchor currently in force for `key`, if any. */
export function currentTraceAnchor(key: string | null | undefined): TraceAnchor | null {
  if (!key) return null;
  return anchors.get(key) ?? null;
}

/** A grafted span, plus the anchor needed to nest further spans beneath it. */
export interface GraftedSpan {
  /** This span's own context — publish it to nest children under this span. */
  readonly anchor: TraceAnchor;
  readonly setAttributes: (attrs: Attributes) => void;
  /** Mark the span failed. Does not end it. */
  readonly fail: (error: unknown) => void;
  /** End the span. Idempotent; extra calls are ignored by the OTel SDK. */
  readonly end: (endTimeMs?: number) => void;
}

export interface GraftedSpanOptions {
  readonly attributes?: Attributes;
  /**
   * Epoch-ms start time. Pass this when the span's start is already in the past
   * — an ACP tool call, say, whose duration is only knowable once the matching
   * result arrives.
   */
  readonly startTimeMs?: number;
}

/**
 * Start a span parented to `key`'s current anchor.
 *
 * With no anchor the span is still created, just unparented — a standalone
 * trace. That is deliberate: an MCP tool call from the chat surface has no
 * generation to nest under, but its p95 still belongs in the operations table.
 */
export function graftedSpan(
  key: string | null | undefined,
  name: string,
  options: GraftedSpanOptions = {},
): GraftedSpan {
  const anchor = currentTraceAnchor(key);
  const parent = anchor
    ? trace.setSpanContext(otelContext.active(), {
        traceId: anchor.traceId,
        spanId: anchor.spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      })
    : otelContext.active();

  const span = tracer.startSpan(
    name,
    {
      ...(options.attributes ? { attributes: options.attributes } : {}),
      ...(options.startTimeMs !== undefined ? { startTime: options.startTimeMs } : {}),
    },
    parent,
  );
  return wrap(span);
}

function wrap(span: Span): GraftedSpan {
  const ctx = span.spanContext();
  return {
    anchor: { traceId: ctx.traceId, spanId: ctx.spanId },
    setAttributes: (attrs) => {
      span.setAttributes(attrs);
    },
    fail: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (error instanceof Error) span.recordException(error);
    },
    end: (endTimeMs) => {
      span.end(endTimeMs);
    },
  };
}

/**
 * Run `fn` inside a grafted span, ending it on both paths and marking failures.
 * The sync/async-agnostic shape callers want for a one-shot operation.
 */
export async function withGraftedSpan<T>(
  key: string | null | undefined,
  name: string,
  options: GraftedSpanOptions,
  fn: (span: GraftedSpan) => Promise<T>,
): Promise<T> {
  const span = graftedSpan(key, name, options);
  try {
    return await fn(span);
  } catch (error) {
    span.fail(error);
    throw error;
  } finally {
    span.end();
  }
}

// ── Effect bridge ────────────────────────────────────────────────────────────

/**
 * The current Effect span's ids, as an anchor — `null` when tracing is off or
 * the effect isn't inside a span.
 *
 * Safe because `@effect/opentelemetry` builds Effect spans on real OTel spans
 * and copies `spanContext()` verbatim, so these ids address the same span an
 * OTel-native parent lookup would.
 */
export const anchorOfCurrentSpan: Effect.Effect<TraceAnchor | null> = Effect.map(
  Effect.orElseSucceed(Effect.currentSpan, () => null),
  (span) => (span ? { traceId: span.traceId, spanId: span.spanId } : null),
);

/**
 * Publish the current Effect span as `key`'s anchor for the duration of
 * `effect`, restoring the previous anchor on every exit path.
 *
 * Apply it INSIDE the `Effect.withSpan` whose context you want grafted onto —
 * in a `.pipe(...)` chain that means listing it before the `withSpan`, since
 * pipe applies outward:
 *
 *   body.pipe(withTraceAnchor(id), …, Effect.withSpan("Job.generate"))
 *
 * A no-op when tracing is disabled (no current span to publish).
 */
export const withTraceAnchor =
  (key: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const anchor = yield* anchorOfCurrentSpan;
      if (!anchor) return yield* effect;
      const restore = publishTraceAnchor(key, anchor);
      return yield* Effect.ensuring(effect, Effect.sync(restore));
    });
