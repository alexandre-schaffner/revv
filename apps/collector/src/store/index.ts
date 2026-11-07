// DuckDB stays behind this surface so that if its native addon stops loading
// under Bun, a bun:sqlite implementation can replace it without touching callers.

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

  /** A DuckDB connection has one transaction context and overlapping BEGINs
   * abort it, so every operation on the connection is serialized. */
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation);
    this.#pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  static async open(dbPath: string): Promise<TelemetryStore> {
    const instance = await DuckDBInstance.create(dbPath);
    const conn = await instance.connect();
    await conn.run(CREATE_SPANS_TABLE);
    for (const idx of CREATE_INDEXES) await conn.run(idx);
    return new TelemetryStore(instance, conn);
  }

  async ingestOtlp(
    body: unknown,
  ): Promise<{ accepted: number; latestMs: number; rejectedSpans: number }> {
    const { spans: rows, rejectedSpans } = parseOtlpBatch(body);
    const accepted = await this.ingest(rows);
    const latestMs = rows.reduce((mx, r) => Math.max(mx, r.startMs), 0);
    return { accepted, latestMs, rejectedSpans };
  }

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
