// ── Read queries ─────────────────────────────────────────────────────────────
//
// Every query is windowed on `start_ms >= sinceMs` and optionally filtered by
// service. Time buckets are computed with integer arithmetic on the epoch-ms
// column rather than DuckDB's `time_bucket` so results cross the JSON boundary
// as plain numbers (no timestamp objects to normalize on the client).

import type { DuckDBConnection } from "@duckdb/node-api";
import type {
  GenerationRun,
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
  -- The agent's own tool calls (Read/Grep/Bash in our worktree) are broken out
  -- from 'agent' on purpose: they are OUR latency, not the model's, and lumping
  -- them together is what made "the agent is slow" unactionable.
  WHEN name LIKE 'Agent.%' OR name LIKE 'claude_code.tool%' THEN 'agent-tools'
  WHEN name LIKE 'Mcp.%' THEN 'mcp'
  WHEN name = 'WalkthroughJobs.generate' OR name LIKE 'Ai.%' OR name LIKE 'Chat.%'
       OR name LIKE 'Acp.%' OR name LIKE 'Walkthrough.%' OR name LIKE 'claude_code.%'
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
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    service?: string | undefined;
    includeNoise?: boolean;
  },
): Promise<OperationSummary[]> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
  const noiseClause = opts.includeNoise ? "" : ` AND NOT (${NOISE_SQL})`;
  const sql = `
    SELECT name, service_name,
           any_value(${CATEGORY_SQL}) AS category,
           count(*) AS count,
           quantile_cont(duration_ms, 0.5) AS p50,
           quantile_cont(duration_ms, 0.95) AS p95,
           max(duration_ms) AS max,
           avg(duration_ms) AS avg_ms,
           count(*) FILTER (WHERE status_code = 2) AS error_count
    FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2${svcClause(opts.service, params)}${noiseClause}
    GROUP BY name, service_name
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
  opts: { sinceMs: number; untilMs?: number | undefined },
): Promise<{ category: string; count: number }[]> {
  const sql = `SELECT ${CATEGORY_SQL} AS category, count(*) AS count
    FROM spans WHERE start_ms >= $1 AND start_ms <= $2 GROUP BY category ORDER BY count DESC`;
  const rows = await read(conn, sql, [opts.sinceMs, opts.untilMs ?? Date.now()]);
  return rows.map((r) => ({ category: String(r.category), count: n(r.count) }));
}

export async function timeseries(
  conn: DuckDBConnection,
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    bucketMs: number;
    service?: string | undefined;
  },
): Promise<TimeseriesPoint[]> {
  const bucket = Math.max(1000, Math.round(opts.bucketMs));
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
  const sql = `
    SELECT (start_ms // ${bucket}) * ${bucket} AS bucket_ms,
           count(*) AS count,
           count(*) FILTER (WHERE status_code = 2) AS error_count,
           quantile_cont(duration_ms, 0.5) AS p50,
           quantile_cont(duration_ms, 0.95) AS p95
    FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2${svcClause(opts.service, params)}
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
  opts: { sinceMs: number; untilMs?: number | undefined; bucketMs: number },
): Promise<ServiceTimeseriesPoint[]> {
  const bucket = Math.max(1000, Math.round(opts.bucketMs));
  // Deliberately unfiltered by service — this query *is* the per-service split.
  const sql = `
    SELECT (start_ms // ${bucket}) * ${bucket} AS bucket_ms,
           service_name,
           count(*) AS count
    FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2
    GROUP BY bucket_ms, service_name
    ORDER BY bucket_ms`;
  const rows = await read(conn, sql, [opts.sinceMs, opts.untilMs ?? Date.now()]);
  return rows.map((r) => ({
    bucketMs: n(r.bucket_ms),
    serviceName: String(r.service_name),
    count: n(r.count),
  }));
}

export async function slowestSpans(
  conn: DuckDBConnection,
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  },
): Promise<SpanRecord[]> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
  const sql = `SELECT ${SPAN_SELECT} FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2 AND NOT (${NOISE_SQL})${svcClause(opts.service, params)}
    ORDER BY duration_ms DESC LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  return (await read(conn, sql, params)).map(toSpanRecord);
}

export async function errorSpans(
  conn: DuckDBConnection,
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  },
): Promise<SpanRecord[]> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
  const sql = `SELECT ${SPAN_SELECT} FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2 AND status_code = 2${svcClause(opts.service, params)}
    ORDER BY start_ms DESC LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  return (await read(conn, sql, params)).map(toSpanRecord);
}

export async function traceSpans(conn: DuckDBConnection, traceId: string): Promise<SpanRecord[]> {
  const sql = `SELECT ${SPAN_SELECT} FROM spans WHERE trace_id = $1 ORDER BY start_ms ASC`;
  const spans = (await read(conn, sql, [traceId])).map(toSpanRecord);
  const seen = new Set(spans.map((span) => `${span.traceId}/${span.spanId}`));
  // ACP pools subprocesses across turns, so a process-wide TRACEPARENT would
  // eventually point at an ended turn. Correlate native spans by session AND
  // turn window instead. This is a display edge, never a rewrite of stored IDs.
  for (const prompt of [...spans]) {
    const session = prompt.attributes["gen_ai.conversation.id"];
    if (prompt.name !== "Acp.prompt" || typeof session !== "string") continue;
    const native = (
      await read(
        conn,
        `SELECT ${SPAN_SELECT} FROM spans
         WHERE name LIKE 'claude_code.%' AND start_ms >= $1 AND start_ms < $2
           AND coalesce(json_extract_string(attributes, '$."session.id"'),
                        json_extract_string(attributes, '$."gen_ai.conversation.id"')) = $3
         ORDER BY start_ms ASC`,
        [prompt.startMs, prompt.startMs + prompt.durationMs, session],
      )
    ).map(toSpanRecord);
    const nativeIds = new Set(native.map((span) => span.spanId));
    for (const span of native) {
      const key = `${span.traceId}/${span.spanId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      spans.push({
        ...span,
        parentSpanId:
          span.parentSpanId && nativeIds.has(span.parentSpanId) ? span.parentSpanId : prompt.spanId,
        attributes: {
          ...span.attributes,
          "revv.correlation": "session-and-turn-window",
          "revv.original_parent_span_id": span.parentSpanId,
        },
      });
    }
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

export async function recentTraces(
  conn: DuckDBConnection,
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  },
): Promise<TraceSummary[]> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
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
      WHERE start_ms >= $1 AND start_ms <= $2${svcClause(opts.service, params)}
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

/**
 * Recent agent generation runs, newest first.
 *
 * `span_count` is the size of the whole trace, not of the generate subtree.
 * That is the more useful number here: it says how much of the run we managed
 * to instrument, and a run that shows 3 spans instead of 40 is itself the
 * finding (a blind spot, not a fast run).
 */
export async function generations(
  conn: DuckDBConnection,
  opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  },
): Promise<GenerationRun[]> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
  const service = svcClause(opts.service, params);
  const sql = `
    WITH counts AS (
      SELECT trace_id, count(*) AS span_count FROM spans GROUP BY trace_id
    )
    SELECT g.trace_id, g.span_id, g.name, g.start_ms, g.duration_ms, g.status_code,
           g.walkthrough_id, g.pr_id, g.model,
           g.input_tokens, g.output_tokens, g.tool_call_count,
           g.attributes->>'trigger' AS trigger,
           g.attributes->>'recapId' AS recap_id,
           COALESCE(c.span_count, 1) AS span_count
    FROM spans g
    LEFT JOIN counts c ON c.trace_id = g.trace_id
    WHERE g.start_ms >= $1 AND g.start_ms <= $2
      AND g.name IN ('WalkthroughJobs.generate', 'ProjectRecapJobs.generate')${service}
    ORDER BY g.start_ms DESC
    LIMIT ${Math.max(1, Math.round(opts.limit))}`;
  const rows = await read(conn, sql, params);
  return rows.map((r) => ({
    traceId: String(r.trace_id),
    spanId: String(r.span_id),
    kind: String(r.name).startsWith("ProjectRecap") ? ("recap" as const) : ("walkthrough" as const),
    startMs: n(r.start_ms),
    durationMs: n(r.duration_ms),
    statusCode: n(r.status_code) as SpanStatusCode,
    walkthroughId: s(r.walkthrough_id) ?? s(r.recap_id),
    prId: s(r.pr_id),
    model: s(r.model),
    trigger: s(r.trigger),
    inputTokens: numOrNull(r.input_tokens),
    outputTokens: numOrNull(r.output_tokens),
    toolCallCount: numOrNull(r.tool_call_count),
    spanCount: n(r.span_count),
  }));
}

export async function services(
  conn: DuckDBConnection,
  opts: { sinceMs: number; untilMs?: number | undefined },
): Promise<ServiceFacet[]> {
  const sql = `SELECT service_name, count(*) AS count FROM spans
    WHERE start_ms >= $1 AND start_ms <= $2 GROUP BY service_name ORDER BY count DESC`;
  const rows = await read(conn, sql, [opts.sinceMs, opts.untilMs ?? Date.now()]);
  return rows.map((r) => ({ serviceName: String(r.service_name), count: n(r.count) }));
}

export async function kpis(
  conn: DuckDBConnection,
  opts: { sinceMs: number; untilMs?: number | undefined; service?: string | undefined },
): Promise<Kpis> {
  const params: (string | number)[] = [opts.sinceMs, opts.untilMs ?? Date.now()];
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
    WHERE start_ms >= $1 AND start_ms <= $2${svc}`;
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
    windowMs: (opts.untilMs ?? Date.now()) - opts.sinceMs,
  };
}
