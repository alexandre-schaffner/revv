// ── Storage facade ───────────────────────────────────────────────────────────
//
// The single module the rest of the collector talks to. The DuckDB engine lives
// behind this surface on purpose: if the native addon ever stops loading under
// Bun, a bun:sqlite implementation can satisfy the same shape without touching
// the service or the queries' callers. (The Phase-2 spike confirmed DuckDB loads
// cleanly, so DuckDB it is — but the seam stays.)

import { DuckDBInstance } from "@duckdb/node-api";
import { retentionFromEnv } from "../retention";
import type {
  CategoryFacet,
  GenerationRun,
  Kpis,
  OperationSummary,
  ServiceFacet,
  ServiceTimeseriesPoint,
  SpanRecord,
  TimeseriesPoint,
  TraceSummary,
} from "../shared/types";
import { insertSpans, parseOtlpBatch, pruneSpans, type SpanInsert } from "./ingest";
import * as q from "./queries";
import { CREATE_INDEXES, CREATE_SPANS_TABLE } from "./schema";

/** Rolling retention: enough recent history for live analysis, bounded memory. */
const RETENTION = retentionFromEnv(process.env);

export class TelemetryStore {
  #instance: DuckDBInstance;
  #conn: Awaited<ReturnType<DuckDBInstance["connect"]>>;
  #pending: Promise<void> = Promise.resolve();

  private constructor(
    instance: DuckDBInstance,
    conn: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  ) {
    this.#instance = instance;
    this.#conn = conn;
  }

  /** A DuckDB connection has one transaction context. Keep each batch and its
   * readers/pruner indivisible on that connection; overlapping BEGINs abort it.
   * Recover the queue after a failure so one bad batch cannot blind collection. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.then(
      () => {},
      () => {},
    );
    return result;
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
  async ingestOtlp(
    body: unknown,
  ): Promise<{ accepted: number; latestMs: number; rejectedSpans: number }> {
    const { spans: rows, rejectedSpans } = parseOtlpBatch(body);
    const accepted = await this.ingest(rows);
    const latestMs = rows.reduce((mx, r) => Math.max(mx, r.startMs), 0);
    return { accepted, latestMs, rejectedSpans };
  }

  /** Direct row insert — used by tests and any non-OTLP feeder. */
  ingest(rows: SpanInsert[]): Promise<number> {
    return this.#run(() => insertSpans(this.#conn, rows));
  }

  prune(): Promise<void> {
    return this.#run(() => pruneSpans(this.#conn, RETENTION));
  }

  operationSummary(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    service?: string | undefined;
    includeNoise?: boolean;
  }): Promise<OperationSummary[]> {
    return this.#run(() => q.operationSummary(this.#conn, opts));
  }
  categories(opts: { sinceMs: number; untilMs?: number | undefined }): Promise<CategoryFacet[]> {
    return this.#run(() => q.categories(this.#conn, opts));
  }
  timeseries(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    bucketMs: number;
    service?: string | undefined;
  }): Promise<TimeseriesPoint[]> {
    return this.#run(() => q.timeseries(this.#conn, opts));
  }
  serviceTimeseries(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    bucketMs: number;
  }): Promise<ServiceTimeseriesPoint[]> {
    return this.#run(() => q.serviceTimeseries(this.#conn, opts));
  }
  slowestSpans(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  }): Promise<SpanRecord[]> {
    return this.#run(() => q.slowestSpans(this.#conn, opts));
  }
  errorSpans(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  }): Promise<SpanRecord[]> {
    return this.#run(() => q.errorSpans(this.#conn, opts));
  }
  traceSpans(traceId: string): Promise<SpanRecord[]> {
    return this.#run(() => q.traceSpans(this.#conn, traceId));
  }
  recentTraces(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  }): Promise<TraceSummary[]> {
    return this.#run(() => q.recentTraces(this.#conn, opts));
  }
  generations(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    limit: number;
    service?: string | undefined;
  }): Promise<GenerationRun[]> {
    return this.#run(() => q.generations(this.#conn, opts));
  }
  services(opts: { sinceMs: number; untilMs?: number | undefined }): Promise<ServiceFacet[]> {
    return this.#run(() => q.services(this.#conn, opts));
  }
  kpis(opts: {
    sinceMs: number;
    untilMs?: number | undefined;
    service?: string | undefined;
  }): Promise<Kpis> {
    return this.#run(() => q.kpis(this.#conn, opts));
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
