// ── First-pass persistence ───────────────────────────────────────────────────
//
// `hunk_scans` + `hunk_scan_rows` are the journal for the per-head smell scan
// (invariant 1): rows are seeded before the first Jev call, so a resumed scan
// rebuilds the total and its progress from here alone. A scan is keyed on
// `(pr_id, head_sha)` and its rows on `(scan_id, file_path, hunk_index)`, so a
// replay is a no-op. The scan's lifecycle lives on `hunk_scans.status`, and
// every transition commits together with the row changes it describes.

import { randomUUID } from "node:crypto";
import {
  HUNK_SMELLS,
  type HunkScanRow,
  type HunkScanSnapshot,
  type HunkScanStatus,
  type HunkSmell,
  hunkKey,
} from "@revv/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { hunkScanRows, hunkScans } from "../db/schema/hunk-scans";
import { DbError } from "../domain/errors";
import { DbService } from "./Db";

export type HunkScanRowRecord = typeof hunkScanRows.$inferSelect;

/** Which scan: one per PR head. */
export interface HunkScanKey {
  readonly prId: string;
  readonly headSha: string;
}

/** What the selector decided for one hunk, before any Jev answer. */
export type HunkScanSeed = Readonly<
  Omit<HunkScanRow, "signals" | "scannedAt"> & { contentHash: string }
>;

function parseSignals(raw: string | null): Record<HunkSmell, number> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const signals = {} as Record<HunkSmell, number>;
    for (const smell of HUNK_SMELLS) {
      const value: unknown = Reflect.get(parsed, smell);
      // A row answered before this smell existed was never asked it: not flagged.
      signals[smell] = typeof value === "number" ? value : 0;
    }
    return signals;
  } catch {
    return null;
  }
}

export function toHunkScanRow(row: HunkScanRowRecord): HunkScanRow {
  return {
    filePath: row.filePath,
    hunkIndex: row.hunkIndex,
    oldStart: row.oldStart,
    oldLines: row.oldLines,
    newStart: row.newStart,
    newLines: row.newLines,
    skipReason: row.skipReason,
    signals: parseSignals(row.signals),
    scannedAt: row.scannedAt,
  };
}

const dbError = (message: string) => (cause: unknown) => new DbError({ message, cause });

/** The scan for one PR head, or null when it never ran. */
export function getHunkScan(
  key: HunkScanKey,
): Effect.Effect<
  { readonly id: string; readonly status: HunkScanStatus } | null,
  DbError,
  DbService
> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    const row = yield* Effect.try({
      try: () =>
        db
          .select({ id: hunkScans.id, status: hunkScans.status })
          .from(hunkScans)
          .where(and(eq(hunkScans.prId, key.prId), eq(hunkScans.headSha, key.headSha)))
          .get(),
      catch: dbError("read hunk_scans"),
    });
    return row ?? null;
  });
}

/**
 * Bring the scan's rows in line with `seeds` and mark it `running`, in one
 * transaction: a crash can't leave rows without a status, or a status without
 * rows. A row whose hunk is still in the seeds (same position, same content
 * hash) keeps its answer, and one left `unscanned` by an earlier run is asked
 * again; every other row is dropped — it was judged on a different diff.
 * Creates the scan if it never ran. Returns the scan id.
 */
export function seedHunkScan(
  key: HunkScanKey,
  seeds: readonly HunkScanSeed[],
): Effect.Effect<string, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: () =>
        db.transaction((tx) => {
          const scan = tx
            .insert(hunkScans)
            .values({
              id: randomUUID(),
              prId: key.prId,
              headSha: key.headSha,
              status: "running",
              createdAt: new Date().toISOString(),
            })
            .onConflictDoUpdate({
              target: [hunkScans.prId, hunkScans.headSha],
              set: { status: "running" },
            })
            .returning({ id: hunkScans.id })
            .get();
          const wanted = new Map(seeds.map((seed) => [hunkKey(seed), seed]));
          const existing = tx
            .select({
              id: hunkScanRows.id,
              filePath: hunkScanRows.filePath,
              hunkIndex: hunkScanRows.hunkIndex,
              contentHash: hunkScanRows.contentHash,
              skipReason: hunkScanRows.skipReason,
            })
            .from(hunkScanRows)
            .where(eq(hunkScanRows.scanId, scan.id))
            .all();
          for (const row of existing) {
            const seed = wanted.get(hunkKey(row));
            if (seed === undefined || seed.contentHash !== row.contentHash) {
              tx.delete(hunkScanRows).where(eq(hunkScanRows.id, row.id)).run();
            } else if (row.skipReason === "unscanned") {
              tx.update(hunkScanRows)
                .set({ skipReason: seed.skipReason })
                .where(eq(hunkScanRows.id, row.id))
                .run();
            }
          }
          for (const seed of seeds) {
            tx.insert(hunkScanRows)
              .values({ id: randomUUID(), scanId: scan.id, ...seed })
              .onConflictDoNothing()
              .run();
          }
          return scan.id;
        }),
      catch: dbError("seed hunk_scan_rows"),
    });
  });
}

/** Record Jev's answer for one hunk. Returns the committed row, or null if it doesn't exist. */
export function recordHunkSignals(
  scanId: string,
  filePath: string,
  hunkIndex: number,
  signals: Readonly<Record<HunkSmell, number>>,
): Effect.Effect<HunkScanRow | null, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    const row = yield* Effect.try({
      try: () =>
        db
          .update(hunkScanRows)
          .set({
            signals: JSON.stringify(signals),
            skipReason: null,
            scannedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(hunkScanRows.scanId, scanId),
              eq(hunkScanRows.filePath, filePath),
              eq(hunkScanRows.hunkIndex, hunkIndex),
            ),
          )
          .returning()
          .get(),
      catch: dbError("record hunk_scan_rows signals"),
    });
    return row ? toHunkScanRow(row) : null;
  });
}

/**
 * End the scan with at least one answer: rows still waiting become
 * `unscanned`, and the status lands in the same transaction.
 */
export function closeHunkScan(
  scanId: string,
  status: "complete" | "partial",
): Effect.Effect<void, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    yield* Effect.try({
      try: () =>
        db.transaction((tx) => {
          tx.update(hunkScanRows)
            .set({ skipReason: "unscanned" })
            .where(
              and(
                eq(hunkScanRows.scanId, scanId),
                isNull(hunkScanRows.signals),
                isNull(hunkScanRows.skipReason),
              ),
            )
            .run();
          tx.update(hunkScans).set({ status }).where(eq(hunkScans.id, scanId)).run();
        }),
      catch: dbError("close hunk_scans"),
    });
  });
}

/**
 * End a scan that got nothing out of Jev: drop its rows so the PR reads
 * exactly as if the pass had never run, and record `failed` so a walkthrough
 * resume doesn't try again. Reopening the review page does.
 */
export function discardHunkScan(scanId: string): Effect.Effect<void, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    yield* Effect.try({
      try: () =>
        db.transaction((tx) => {
          tx.delete(hunkScanRows).where(eq(hunkScanRows.scanId, scanId)).run();
          tx.update(hunkScans).set({ status: "failed" }).where(eq(hunkScans.id, scanId)).run();
        }),
      catch: dbError("discard hunk_scans"),
    });
  });
}

/** Every row for a scan, in seed order — which is diff order. */
export function listHunkScanRows(
  scanId: string,
): Effect.Effect<ReadonlyArray<HunkScanRowRecord>, DbError, DbService> {
  return Effect.gen(function* () {
    const { db } = yield* DbService;
    return yield* Effect.try({
      try: () =>
        db
          .select()
          .from(hunkScanRows)
          .where(eq(hunkScanRows.scanId, scanId))
          .orderBy(sql`rowid`)
          .all(),
      catch: dbError("list hunk_scan_rows"),
    });
  });
}

/** The DTO view; a read failure degrades to no first pass rather than failing the page. */
export function loadHunkScan(key: HunkScanKey): Effect.Effect<HunkScanSnapshot, never, DbService> {
  return Effect.gen(function* () {
    const scan = yield* getHunkScan(key);
    if (scan === null) return { headSha: key.headSha, status: null, rows: [] };
    const rows = yield* listHunkScanRows(scan.id);
    return { headSha: key.headSha, status: scan.status, rows: rows.map(toHunkScanRow) };
  }).pipe(Effect.orElseSucceed(() => ({ headSha: key.headSha, status: null, rows: [] })));
}
