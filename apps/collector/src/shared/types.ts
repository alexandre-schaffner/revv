// ── Shared contract types ────────────────────────────────────────────────────
//
// The single source of truth for the shapes that cross the collector → dashboard
// boundary. Served to Grafana and weekly analysis clients. Kept local to
// apps/collector; @revv/shared is for server ↔ web ↔ desktop contracts.

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

/**
 * One agent generation run — the unit the generation timeline analyses.
 *
 * Sourced from the `*Jobs.generate` spans, which by construction wrap the
 * forked job body and therefore measure real end-to-end generation time (the
 * sibling `*Jobs.job` span forks and returns in ~0 ms).
 */
export interface GenerationRun {
  readonly traceId: string;
  /** The generate span itself — the subtree root the timeline analyses. */
  readonly spanId: string;
  readonly kind: "walkthrough" | "recap";
  readonly startMs: number;
  readonly durationMs: number;
  readonly statusCode: SpanStatusCode;
  readonly walkthroughId: string | null;
  readonly prId: string | null;
  readonly model: string | null;
  /** `manual` / `regenerate` / … from the job's `trigger` attribute. */
  readonly trigger: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCallCount: number | null;
  /** Spans in the whole trace — a rough "how much did we see" indicator. */
  readonly spanCount: number;
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
