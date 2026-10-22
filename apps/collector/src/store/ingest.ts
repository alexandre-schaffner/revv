// ── OTLP parsing + idempotent writer ─────────────────────────────────────────
//
// We control every exporter feeding this collector, so we only accept OTLP/HTTP
// *JSON* (the `-http` exporter's default encoding). That lets us parse with
// `JSON.parse` and skip protobuf decoding entirely.
//
// The parse is intentionally defensive: a malformed batch drops the bad spans
// rather than rejecting the whole request, so one wrong field from one source
// never blinds the dashboard to everything else.

import type { DuckDBConnection } from "@duckdb/node-api";
import type { SpanStatusCode } from "../shared/types";
import { SPAN_COLUMNS } from "./schema";

/** A fully-flattened span ready to bind into the `spans` table. */
export interface SpanInsert {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  serviceName: string;
  startMs: number;
  durationMs: number;
  statusCode: SpanStatusCode;
  statusMessage: string | null;
  attributes: Record<string, unknown>;
  walkthroughId: string | null;
  prId: string | null;
  model: string | null;
  provider: string | null;
  toolCallCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  httpMethod: string | null;
  httpPath: string | null;
  httpStatus: number | null;
}

// ── OTLP anyValue decoding ───────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

function decodeAnyValue(value: unknown): unknown {
  const v = object(value);
  if (!v) return null;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.doubleValue === "number" && Number.isFinite(v.doubleValue)) return v.doubleValue;
  if (v.intValue !== undefined) return num(v.intValue);
  const array = object(v.arrayValue);
  if (array && Array.isArray(array.values)) return array.values.map(decodeAnyValue);
  const kvlist = object(v.kvlistValue);
  if (kvlist) return decodeAttributes(kvlist.values);
  return null;
}

function decodeAttributes(value: unknown): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  if (Array.isArray(value)) {
    for (const raw of value) {
      const kv = object(raw);
      if (kv && typeof kv.key === "string" && kv.key) {
        entries.push([kv.key, decodeAnyValue(kv.value)]);
      }
    }
  }
  return Object.fromEntries(entries);
}

// ── attribute → hot-column extraction ────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** First non-null value across a set of candidate attribute keys. */
function pick(attrs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// ── OTLP status decoding ─────────────────────────────────────────────────────

function decodeStatusCode(code: unknown): SpanStatusCode {
  // proto3 JSON may serialize the enum as a name or as its number.
  if (code === 2 || code === "STATUS_CODE_ERROR") return 2;
  if (code === 1 || code === "STATUS_CODE_OK") return 1;
  return 0;
}

/** nanosecond unix string (proto int64 → JSON string) → epoch ms. */
function nanoToMs(nano: unknown): number {
  if (typeof nano === "number") return nano / 1e6;
  if (typeof nano === "string" && nano !== "") {
    try {
      return Number(BigInt(nano) / 1_000_000n);
    } catch {
      return 0;
    }
  }
  return 0;
}

export class OtlpPayloadError extends Error {
  constructor() {
    super("Expected OTLP JSON resourceSpans, scopeSpans and spans arrays");
  }
}

/** Validate containers before accepting any writes. Individual malformed spans
 * are rejected without dropping their valid siblings. */
export function parseOtlpBatch(body: unknown): { spans: SpanInsert[]; rejectedSpans: number } {
  const root = object(body);
  if (!root || !Array.isArray(root.resourceSpans)) throw new OtlpPayloadError();
  const rows: SpanInsert[] = [];
  let rejectedSpans = 0;
  for (const rawResource of root.resourceSpans) {
    const rs = object(rawResource);
    if (!rs || (rs.scopeSpans !== undefined && !Array.isArray(rs.scopeSpans)))
      throw new OtlpPayloadError();
    const resourceAttrs = decodeAttributes(object(rs.resource)?.attributes);
    const serviceName = str(resourceAttrs["service.name"]) ?? "unknown";
    const scopeSpans = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    for (const rawScope of scopeSpans) {
      const ss = object(rawScope);
      if (!ss || (ss.spans !== undefined && !Array.isArray(ss.spans))) throw new OtlpPayloadError();
      const spans = Array.isArray(ss.spans) ? ss.spans : [];
      for (const raw of spans) {
        const s = object(raw);
        const traceId = str(s?.traceId);
        const spanId = str(s?.spanId);
        if (!s || !traceId || !spanId) {
          rejectedSpans++;
          continue;
        }
        const startMs = nanoToMs(s.startTimeUnixNano);
        const endMs = nanoToMs(s.endTimeUnixNano);
        if (
          !Number.isSafeInteger(Math.round(startMs)) ||
          startMs <= 0 ||
          !Number.isFinite(endMs) ||
          endMs < startMs
        ) {
          rejectedSpans++;
          continue;
        }
        const attrs = { ...resourceAttrs, ...decodeAttributes(s.attributes) };
        const status = object(s.status);
        rows.push({
          traceId,
          spanId,
          parentSpanId: str(s.parentSpanId),
          name: str(s.name) ?? "(anonymous)",
          serviceName,
          startMs,
          durationMs: Math.max(0, endMs - startMs),
          statusCode: decodeStatusCode(status?.code),
          statusMessage: str(status?.message),
          attributes: attrs,
          // Revv's Effect spans annotate camelCase keys; OTel semconv and our
          // new KPI annotations use snake_case. Accept both.
          walkthroughId: str(pick(attrs, "walkthrough_id", "walkthrough.id", "walkthroughId")),
          prId: str(pick(attrs, "pr_id", "pr.id", "pull_request_id", "prId")),
          model: str(
            pick(attrs, "model", "ai.model", "gen_ai.request.model", "gen_ai.response.model"),
          ),
          provider: str(
            pick(attrs, "provider", "ai.provider", "gen_ai.provider.name", "gen_ai.system"),
          ),
          toolCallCount: num(pick(attrs, "tool_call_count", "toolCallCount")),
          inputTokens: num(
            pick(
              attrs,
              "input_tokens",
              "inputTokens",
              "gen_ai.usage.input_tokens",
              "llm.usage.prompt_tokens",
            ),
          ),
          outputTokens: num(
            pick(
              attrs,
              "output_tokens",
              "outputTokens",
              "gen_ai.usage.output_tokens",
              "llm.usage.completion_tokens",
            ),
          ),
          httpMethod: str(pick(attrs, "http.request.method", "http.method")),
          httpPath: str(pick(attrs, "url.path", "http.route", "http.target")),
          httpStatus: num(pick(attrs, "http.response.status_code", "http.status_code")),
        });
      }
    }
  }
  return { spans: rows, rejectedSpans };
}

/** Benchmark/parser convenience: malformed containers have no usable rows. */
export function parseOtlp(body: unknown): SpanInsert[] {
  try {
    return parseOtlpBatch(body).spans;
  } catch (error) {
    if (error instanceof OtlpPayloadError) return [];
    throw error;
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

const PLACEHOLDERS = SPAN_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
const INSERT_SQL = `INSERT INTO spans (${SPAN_COLUMNS.join(", ")}) VALUES (${PLACEHOLDERS}) ON CONFLICT DO NOTHING`;

/**
 * Batch-insert spans inside one transaction. Idempotent on (trace_id, span_id):
 * a replayed batch inserts nothing. Returns the row count handed in (DuckDB's
 * ON CONFLICT makes the effective count best-effort, but the caller only needs
 * a magnitude for the SSE signal).
 */
export async function insertSpans(conn: DuckDBConnection, rows: SpanInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stmt = await conn.prepare(INSERT_SQL);
  await conn.run("BEGIN TRANSACTION");
  try {
    for (const r of rows) {
      stmt.bindVarchar(1, r.traceId);
      stmt.bindVarchar(2, r.spanId);
      bindNullableVarchar(stmt, 3, r.parentSpanId);
      stmt.bindVarchar(4, r.name);
      stmt.bindVarchar(5, r.serviceName);
      stmt.bindBigInt(6, BigInt(Math.max(0, Math.round(r.startMs))));
      stmt.bindDouble(7, r.durationMs);
      stmt.bindInteger(8, r.statusCode);
      bindNullableVarchar(stmt, 9, r.statusMessage);
      stmt.bindVarchar(10, JSON.stringify(r.attributes));
      bindNullableVarchar(stmt, 11, r.walkthroughId);
      bindNullableVarchar(stmt, 12, r.prId);
      bindNullableVarchar(stmt, 13, r.model);
      bindNullableVarchar(stmt, 14, r.provider);
      bindNullableInteger(stmt, 15, r.toolCallCount);
      bindNullableInteger(stmt, 16, r.inputTokens);
      bindNullableInteger(stmt, 17, r.outputTokens);
      bindNullableVarchar(stmt, 18, r.httpMethod);
      bindNullableVarchar(stmt, 19, r.httpPath);
      bindNullableInteger(stmt, 20, r.httpStatus);
      await stmt.run();
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
  return rows.length;
}

/**
 * Rolling-window retention: drop spans older than `maxAgeMs`, then hard-cap the
 * table at `maxRows` (keeping the most recent). The dashboard is for live/recent
 * analysis, not infinite history.
 */
export async function pruneSpans(
  conn: DuckDBConnection,
  opts: { maxAgeMs: number; maxRows: number },
): Promise<void> {
  const cutoff = BigInt(Date.now() - opts.maxAgeMs);
  await conn.run(`DELETE FROM spans WHERE start_ms < ${cutoff}`);
  await conn.run(
    `DELETE FROM spans WHERE rowid IN (
       SELECT rowid FROM spans ORDER BY start_ms DESC OFFSET ${Math.max(0, opts.maxRows)}
     )`,
  );
}

function bindNullableVarchar(
  stmt: Awaited<ReturnType<DuckDBConnection["prepare"]>>,
  i: number,
  v: string | null,
): void {
  if (v === null) stmt.bindNull(i);
  else stmt.bindVarchar(i, v);
}

function bindNullableInteger(
  stmt: Awaited<ReturnType<DuckDBConnection["prepare"]>>,
  i: number,
  v: number | null,
): void {
  if (v === null) stmt.bindNull(i);
  else stmt.bindInteger(i, Math.round(v));
}
