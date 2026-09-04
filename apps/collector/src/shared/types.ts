// ── Shared contract types ────────────────────────────────────────────────────
//
// The single source of truth for the shapes that cross the collector → dashboard
// boundary. Imported by both the Elysia service (src/**) and the dashboard SPA
// (web/src/**). Kept local to apps/collector; nothing here belongs in
// @revv/shared, which is for cross-app (server ↔ web ↔ desktop) contracts.

/** OTel status: 0 = unset, 1 = ok, 2 = error. */
export type SpanStatusCode = 0 | 1 | 2;

/** One flattened span, as stored and as returned by span-list endpoints. */
export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly serviceName: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly statusCode: SpanStatusCode;
  readonly statusMessage: string | null;
  readonly attributes: Record<string, unknown>;
  // ── Extracted hot columns (null when the source span didn't carry them) ──
  readonly walkthroughId: string | null;
  readonly prId: string | null;
  readonly model: string | null;
  readonly provider: string | null;
  readonly toolCallCount: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly httpMethod: string | null;
  readonly httpPath: string | null;
  readonly httpStatus: number | null;
}

/** Per-operation rollup for the summary table. */
export interface OperationSummary {
  readonly name: string;
  readonly serviceName: string;
  readonly category: string;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly avgMs: number;
  readonly errorCount: number;
  readonly errorRate: number; // 0..1
}

/** One time bucket for throughput / error-rate / latency-band charts. */
export interface TimeseriesPoint {
  readonly bucketMs: number;
  readonly count: number;
  readonly errorCount: number;
  readonly p50: number;
  readonly p95: number;
}

/** Headline KPI rollup. Any metric is null when no spans fed it in the window. */
export interface Kpis {
  readonly walkthroughGenMedianMs: number | null;
  readonly avgToolCallsPerWalkthrough: number | null;
  readonly avgTokensPerWalkthrough: number | null;
  readonly githubP95Ms: number | null;
  /** Median time-to-first-token (ms) across walkthrough/recap/chat generations. */
  readonly ttftMedianMs: number | null;
  readonly errorRate: number | null; // 0..1
  readonly spanCount: number;
  readonly traceCount: number;
  readonly windowMs: number;
}

/** One bucket of throughput for a single service (for the stacked by-service chart). */
export interface ServiceTimeseriesPoint {
  readonly bucketMs: number;
  readonly serviceName: string;
  readonly count: number;
}

/** A trace, summarized for the trace list that feeds the waterfall. */
export interface TraceSummary {
  readonly traceId: string;
  readonly rootName: string;
  readonly serviceName: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly spanCount: number;
  readonly errorCount: number;
}

/** A service that has reported spans in the window, with its span count. */
export interface ServiceFacet {
  readonly serviceName: string;
  readonly count: number;
}

/** A triage category present in the window, with its span count. */
export interface CategoryFacet {
  readonly category: string;
  readonly count: number;
}

/** SSE envelope pushed on the /events stream. Signal only; reconnect re-reads. */
export interface PerfUpdatedEvent {
  readonly type: "perf:updated";
  readonly data: {
    /** Spans accepted in the batch that triggered this push. */
    readonly ingested: number;
    /** Wall-clock ms of the newest span in the batch. */
    readonly latestMs: number;
  };
}
