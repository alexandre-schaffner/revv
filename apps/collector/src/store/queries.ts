// ── Read queries ─────────────────────────────────────────────────────────────
//
// Every query is windowed on `start_ms >= sinceMs` and optionally filtered by
// service. Time buckets are computed with integer arithmetic on the epoch-ms
// column rather than DuckDB's `time_bucket` so results cross the JSON boundary
// as plain numbers (no timestamp objects to normalize on the client).

import type { DuckDBConnection } from "@duckdb/node-api";
import type {
  Kpis,
  OperationSummary,
  ServiceFacet,
  ServiceTimeseriesPoint,
  SpanRecord,
  SpanStatusCode,
  TimeseriesPoint,
  TraceSummary,
} from "../shared/types";

type Row = Record<string, unknown>;

// ── Span triage (derived at query time, no schema coupling) ─────────────────
//
// Categorise spans into the buckets that matter for a code-review tool, and
// flag low-insight bookkeeping spans as "noise" so the per-operation views can
// surface real work by default. Kept as SQL so every query classifies
// identically. Coupled to span names by design (same spirit as the
// `WalkthroughJobs.generate` KPI) — the names are the contract.
const CATEGORY_SQL = `CASE
  WHEN service_name = 'revv-web' THEN 'rum'
  WHEN name LIKE 'GitHub.%' THEN 'github'
  WHEN name = 'WalkthroughJobs.generate' OR name LIKE 'Ai.%' OR name LIKE 'Chat.%'
       OR name LIKE 'ProjectRecapJobs.%' OR service_name = 'revv-opencode' THEN 'agent'
  WHEN name LIKE 'RepoClone.%' THEN 'git'
  WHEN name LIKE '%Scheduler.%' OR name LIKE 'PollScheduler%' THEN 'sync'
  WHEN name = 'http.request' THEN 'http'
  ELSE 'internal'
END`;

// Bookkeeping spans: correct to emit (the in-app debug ring buffer wants them)
// but near-zero-duration / high-volume, so they bury real operations in the
// summary table. Excluded by default; the dashboard can opt them back in.
const NOISE_SQL = `name IN (
  'WalkthroughJobs.emitEvent', 'WalkthroughJobs.setStatus', 'WalkthroughJobs.job',
  'OpencodeSupervisor.jobStarted', 'OpencodeSupervisor.jobEnded', 'OpencodeSupervisor.stopNow'
)`;

/** Read rows, coercing DuckDB BIGINTs (returned as JS bigint) to numbers. */
async function read(
  conn: DuckDBConnection,
  sql: string,
  params: (string | number)[] = [],
): Promise<Row[]> {
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjects().map((row) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v;
    return out;
  });
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : typeof v === "number" && Number.isFinite(v) ? v : null;
const s = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Build the trailing `AND service_name = ?` clause and its param, if filtering. */
function svcClause(service: string | undefined, params: (string | number)[]): string {
  if (!service) return "";
  params.push(service);
  return ` AND service_name = $${params.length}`;
}

// ── Span row projection (shared by slow / errors / trace) ────────────────────

const SPAN_SELECT = `
  trace_id, span_id, parent_span_id, name, service_name, start_ms, duration_ms,
  status_code, status_message, attributes::VARCHAR AS attributes,
  walkthrough_id, pr_id, model, provider, tool_call_count, input_tokens,
  output_tokens, http_method, http_path, http_status
`;

function toSpanRecord(r: Row): SpanRecord {
  let attributes: Record<string, unknown> = {};
  if (typeof r.attributes === "string") {
    try {
      attributes = JSON.parse(r.attributes) as Record<string, unknown>;
    } catch {
      attributes = {};
    }
  }
  return {
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    parentSpanId: s(r.parent_span_id),
    name: String(r.name),
    serviceName: String(r.service_name),
    startMs: n(r.start_ms),
    durationMs: n(r.duration_ms),
    statusCode: n(r.status_code) as SpanStatusCode,
    statusMessage: s(r.status_message),
    attributes,
    walkthroughId: s(r.walkthrough_id),
    prId: s(r.pr_id),
    model: s(r.model),
    provider: s(r.provider),
    toolCallCount: numOrNull(r.tool_call_count),
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    httpMethod: s(r.http_method),
    httpPath: s(r.http_path),
    httpStatus: numOrNull(r.http_status),
  };
}

// ── Public queries ───────────────────────────────────────────────────────────

export async function operationSummary(
  conn: DuckDBConnection,
  opts: { sinceMs: number; service?: string | undefined; includeNoise?: boolean },
): Promise<OperationSummary[]> {
  const params: (string | number)[] = [opts.sinceMs];
  const noiseClause = opts.includeNoise ? "" : ` AND NOT (${NOISE_SQL})`;
  const sql = `
    SELECT name, any_value(service_name) AS service_name,
           any_value(${CATEGORY_SQL}) AS category,
           count(*) AS count,
           quantile_cont(duration_ms, 0.5) AS p50,
           quantile_cont(duration_ms, 0.95) AS p95,
           max(duration_ms) AS max,
           avg(duration_ms) AS avg_ms,
           count(*) FILTER (WHERE status_code = 2) AS error_count
    FROM spans
    WHERE start_ms >= $1${svcClause(opts.service, params)}${noiseClause}
    GROUP BY name
    ORDER BY count DESC, p95 DESC`;
  const rows = await read(conn, sql, params);
  return rows.map((r) => {
    const count = n(r.count);
    const errorCount = n(r.error_count);
    return {
      name: String(r.name),
      serviceName: String(r.service_name),
      category: String(r.category),
      count,
      p50: n(r.p50),
      p95: n(r.p95),
      max: n(r.max),
      avgMs: n(r.avg_ms),
      errorCount,
      errorRate: count > 0 ? errorCount / count : 0,
    };
  });
}

export async function categories(
  conn: DuckDBConnection,
  opts: { sinceMs: number },
): Promise<{ category: string; count: number }[]> {
  const sql = `SELECT ${CATEGORY_SQL} AS category, count(*) AS count
    FROM spans WHERE start_ms >= $1 GROUP BY category ORDER BY count DESC`;
  const rows = await read(conn, sql, [opts.sinceMs]);
  return rows.map((r) => ({ category: String(r.category), count: n(r.count) }));
}

export async function timeseries(
  conn: DuckDBConnection,
  opts: { sinceMs: number; bucketMs: number; service?: string | undefined },
): Promise<TimeseriesPoint[]> {
  const bucket = Math.max(1000, Math.round(opts.bucketMs));
  const params: (string | number)[] = [opts.sinceMs];
  const sql = `
    SELECT (start_ms // ${bucket}) * ${bucket} AS bucket_ms,
           count(*) AS count,
           count(*) FILTER (WHERE status_code = 2) AS error_count,
           quantile_cont(duration_ms, 0.5) AS p50,
           quantile_cont(duration_ms, 0.95) AS p95
    FROM spans
    WHERE start_ms >= $1${svcClause(opts.service, params)}
    GROUP BY bucket_ms
    ORDER BY bucket_ms`;
  const rows = await read(conn, sql, params);
  return rows.map((r) => ({
    bucketMs: n(r.bucket_ms),
    count: n(r.count),
    errorCount: n(r.error_count),
    p50: n(r.p50),
    p95: n(r.p95),
  }));
}

export async function serviceTimeseries(
  conn: DuckDBConnection,
  opts: { sinceMs: number; bucketMs: number },
): Promise<ServiceTimeseriesPoint[]> {
  const bucket = Math.max(1000, Math.round(opts.bucketMs));
  // Deliberately unfiltered by service — this query *is* the per-service split.
  const sql = `
    SELECT (start_ms // ${bucket}) * ${bucket} AS bucket_ms,
           service_name,
           count(*) AS count
    FROM spans
    WHERE start_ms >= $1
    GROUP BY bucket_ms, service_name
    ORDER BY bucket_ms`;
  const rows = await read(conn, sql, [opts.sinceMs]);
  return rows.map((r) => ({
    bucketMs: n(r.bucket_ms),
    serviceName: String(r.service_name),
    count: n(r.count),
  }));
}

export async function slowestSpans(
  conn: DuckDBConnection,
  opts: { sinceMs: number; limit: number; service?: string | undefined },
): Promise<SpanRecord[]> {
  const params: (string | number)[] = [opts.sinceMs];
  const sql = `SELECT ${SPAN_SELECT} FROM spans
    WHERE start_ms >= $1 AND NOT (${NOISE_SQL})${svcClause(opts.service, params)}
    ORDER BY duration_ms DESC LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  return (await read(conn, sql, params)).map(toSpanRecord);
}

export async function errorSpans(
  conn: DuckDBConnection,
  opts: { sinceMs: number; limit: number; service?: string | undefined },
): Promise<SpanRecord[]> {
  const params: (string | number)[] = [opts.sinceMs];
  const sql = `SELECT ${SPAN_SELECT} FROM spans
    WHERE start_ms >= $1 AND status_code = 2${svcClause(opts.service, params)}
    ORDER BY start_ms DESC LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  return (await read(conn, sql, params)).map(toSpanRecord);
}

export async function traceSpans(conn: DuckDBConnection, traceId: string): Promise<SpanRecord[]> {
  const sql = `SELECT ${SPAN_SELECT} FROM spans WHERE trace_id = $1 ORDER BY start_ms ASC`;
  return (await read(conn, sql, [traceId])).map(toSpanRecord);
}

export async function recentTraces(
  conn: DuckDBConnection,
  opts: { sinceMs: number; limit: number; service?: string | undefined },
): Promise<TraceSummary[]> {
  const params: (string | number)[] = [opts.sinceMs];
  // Per trace: span count, error count, window span, and the name of the span
  // with the smallest start (the de-facto root for display).
  const sql = `
    WITH t AS (
      SELECT trace_id,
             min(start_ms) AS start_ms,
             max(start_ms + duration_ms) - min(start_ms) AS duration_ms,
             count(*) AS span_count,
             count(*) FILTER (WHERE status_code = 2) AS error_count,
             arg_min(name, start_ms) AS root_name,
             arg_min(service_name, start_ms) AS service_name
      FROM spans
      WHERE start_ms >= $1${svcClause(opts.service, params)}
      GROUP BY trace_id
    )
    SELECT * FROM t ORDER BY start_ms DESC LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  const rows = await read(conn, sql, params);
  return rows.map((r) => ({
    traceId: String(r.trace_id),
    rootName: String(r.root_name),
    serviceName: String(r.service_name),
    startMs: n(r.start_ms),
    durationMs: n(r.duration_ms),
    spanCount: n(r.span_count),
    errorCount: n(r.error_count),
  }));
}

export async function services(
  conn: DuckDBConnection,
  opts: { sinceMs: number },
): Promise<ServiceFacet[]> {
  const sql = `SELECT service_name, count(*) AS count FROM spans
    WHERE start_ms >= $1 GROUP BY service_name ORDER BY count DESC`;
  const rows = await read(conn, sql, [opts.sinceMs]);
  return rows.map((r) => ({ serviceName: String(r.service_name), count: n(r.count) }));
}

export async function kpis(
  conn: DuckDBConnection,
  opts: { sinceMs: number; service?: string | undefined },
): Promise<Kpis> {
  const params: (string | number)[] = [opts.sinceMs];
  const svc = svcClause(opts.service, params);
  const sql = `
    SELECT
      count(*) AS span_count,
      count(DISTINCT trace_id) AS trace_count,
      count(*) FILTER (WHERE status_code = 2) AS error_count,
      -- walkthrough generation: the dedicated generation span wraps the full
      -- run, so its duration is the real end-to-end generation time (the
      -- 'WalkthroughJobs.job' span forks and returns in ~0ms — excluded here).
      quantile_cont(duration_ms, 0.5) FILTER (
        WHERE name = 'WalkthroughJobs.generate'
      ) AS wt_median,
      avg(tool_call_count) FILTER (WHERE tool_call_count IS NOT NULL) AS avg_tool_calls,
      avg(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) FILTER (
        WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL
      ) AS avg_tokens,
      quantile_cont(duration_ms, 0.95) FILTER (
        WHERE name ILIKE 'github%' OR http_method IS NOT NULL
      ) AS github_p95,
      -- median time-to-first-token across the generation spans that carry it
      median(TRY_CAST(attributes->>'ttft_ms' AS DOUBLE)) FILTER (
        WHERE attributes->>'ttft_ms' IS NOT NULL
      ) AS ttft_median
    FROM spans
    WHERE start_ms >= $1${svc}`;
  const [r] = await read(conn, sql, params);
  const spanCount = n(r?.span_count);
  const errorCount = n(r?.error_count);
  return {
    walkthroughGenMedianMs: numOrNull(r?.wt_median),
    avgToolCallsPerWalkthrough: numOrNull(r?.avg_tool_calls),
    avgTokensPerWalkthrough: numOrNull(r?.avg_tokens),
    githubP95Ms: numOrNull(r?.github_p95),
    ttftMedianMs: numOrNull(r?.ttft_median),
    errorRate: spanCount > 0 ? errorCount / spanCount : null,
    spanCount,
    traceCount: n(r?.trace_count),
    windowMs: Date.now() - opts.sinceMs,
  };
}
