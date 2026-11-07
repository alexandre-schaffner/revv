// Shapes served to Grafana and weekly analysis clients. Kept out of @revv/shared,
// which is for server ↔ web ↔ desktop contracts.

/** OTel status: 0 = unset, 1 = ok, 2 = error. */
export type SpanStatusCode = 0 | 1 | 2;

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

export interface TimeseriesPoint {
  readonly bucketMs: number;
  readonly count: number;
  readonly errorCount: number;
  readonly p50: number;
  readonly p95: number;
}

/** Each metric is null when no spans fed it in the window. */
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

export interface ServiceTimeseriesPoint {
  readonly bucketMs: number;
  readonly serviceName: string;
  readonly count: number;
}

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
 * Sourced from the `*Jobs.generate` spans, which wrap the forked job body and so
 * measure end-to-end generation time.
 */
export interface GenerationRun {
  readonly traceId: string;
  readonly spanId: string;
  readonly kind: "walkthrough" | "recap";
  readonly startMs: number;
  readonly durationMs: number;
  readonly statusCode: SpanStatusCode;
  readonly walkthroughId: string | null;
  readonly prId: string | null;
  readonly model: string | null;
  /** The job's `trigger` attribute: a `WalkthroughStartTrigger` from `@revv/shared`. */
  readonly trigger: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCallCount: number | null;
  /** Spans in the whole trace, not just the generate subtree. */
  readonly spanCount: number;
}

export interface ServiceFacet {
  readonly serviceName: string;
  readonly count: number;
}

export interface CategoryFacet {
  readonly category: string;
  readonly count: number;
}
