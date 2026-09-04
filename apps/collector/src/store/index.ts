// ── Storage facade ───────────────────────────────────────────────────────────
//
// The single module the rest of the collector talks to. The DuckDB engine lives
// behind this surface on purpose: if the native addon ever stops loading under
// Bun, a bun:sqlite implementation can satisfy the same shape without touching
// the service or the queries' callers. (The Phase-2 spike confirmed DuckDB loads
// cleanly, so DuckDB it is — but the seam stays.)

import { DuckDBInstance } from "@duckdb/node-api";
import type {
  CategoryFacet,
  Kpis,
  OperationSummary,
  ServiceFacet,
  ServiceTimeseriesPoint,
  SpanRecord,
  TimeseriesPoint,
  TraceSummary,
} from "../shared/types";
import { insertSpans, parseOtlp, pruneSpans, type SpanInsert } from "./ingest";
import * as q from "./queries";
import { CREATE_INDEXES, CREATE_SPANS_TABLE } from "./schema";

/** Rolling retention: enough recent history for live analysis, bounded memory. */
const RETENTION = { maxAgeMs: 6 * 60 * 60 * 1000, maxRows: 100_000 };

export class TelemetryStore {
  #instance: DuckDBInstance;
  #conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;

  private constructor(
    instance: DuckDBInstance,
    conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  ) {
    this.#instance = instance;
    this.#conn = conn;
  }

  /** Open (or create) the DuckDB file and ensure the schema exists. */
  static async open(dbPath: string): Promise<TelemetryStore> {
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    await conn.run(CREATE_SPANS_TABLE);
    for (const idx of CREATE_INDEXES) await conn.run(idx);
    return new TelemetryStore(instance, conn);
  }

  /** Parse an OTLP/HTTP JSON body and persist its spans. Returns rows accepted. */
  async ingestOtlp(body: unknown): Promise<{ accepted: number; latestMs: number }> {
    const rows = parseOtlp(body);
    const accepted = await insertSpans(this.#conn, rows);
    const latestMs = rows.reduce((mx, r) => Math.max(mx, r.startMs), 0);
    return { accepted, latestMs };
  }

  /** Direct row insert — used by tests and any non-OTLP feeder. */
  ingest(rows: SpanInsert[]): Promise<number> {
    return insertSpans(this.#conn, rows);
  }

  prune(): Promise<void> {
    return pruneSpans(this.#conn, RETENTION);
  }

  operationSummary(opts: {
    sinceMs: number;
    service?: string | undefined;
    includeNoise?: boolean;
  }): Promise<OperationSummary[]> {
    return q.operationSummary(this.#conn, opts);
  }
  categories(opts: { sinceMs: number }): Promise<CategoryFacet[]> {
    return q.categories(this.#conn, opts);
  }
  timeseries(opts: {
    sinceMs: number;
    bucketMs: number;
    service?: string | undefined;
  }): Promise<TimeseriesPoint[]> {
    return q.timeseries(this.#conn, opts);
  }
  serviceTimeseries(opts: {
    sinceMs: number;
    bucketMs: number;
  }): Promise<ServiceTimeseriesPoint[]> {
    return q.serviceTimeseries(this.#conn, opts);
  }
  slowestSpans(opts: {
    sinceMs: number;
    limit: number;
    service?: string | undefined;
  }): Promise<SpanRecord[]> {
    return q.slowestSpans(this.#conn, opts);
  }
  errorSpans(opts: {
    sinceMs: number;
    limit: number;
    service?: string | undefined;
  }): Promise<SpanRecord[]> {
    return q.errorSpans(this.#conn, opts);
  }
  traceSpans(traceId: string): Promise<SpanRecord[]> {
    return q.traceSpans(this.#conn, traceId);
  }
  recentTraces(opts: {
    sinceMs: number;
    limit: number;
    service?: string | undefined;
  }): Promise<TraceSummary[]> {
    return q.recentTraces(this.#conn, opts);
  }
  services(opts: { sinceMs: number }): Promise<ServiceFacet[]> {
    return q.services(this.#conn, opts);
  }
  kpis(opts: { sinceMs: number; service?: string | undefined }): Promise<Kpis> {
    return q.kpis(this.#conn, opts);
  }

  /** Flush and release the DuckDB handles. Safe to call once on shutdown. */
  close(): void {
    try {
      this.#conn.closeSync();
    } catch {}
    try {
      this.#instance.closeSync();
    } catch {}
  }
}

export type { SpanInsert } from "./ingest";
