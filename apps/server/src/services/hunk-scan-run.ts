// ── First-pass run ───────────────────────────────────────────────────────────
//
// Runs the per-hunk smell scan (`ai/jev/hunk-scan.ts`) for one PR head. Elysia
// owns this end to end — Jev's answers are orchestrator-computed judgments
// (invariant 2's carve-out), so they're written here, never through MCP.
// `HunkScanService` decides when it runs; this is the run itself.
//
// The scan has its own lifecycle on `hunk_scans.status`, and every run ends in
// exactly one terminal state:
//
//   running ─┬─ complete   every hunk answered
//            ├─ partial    Jev stopped answering partway; the rest are `unscanned`
//            └─ failed     Jev answered nothing; rows deleted, as if it never ran
//
// A finished scan is reused as it is, with two exceptions. One whose rows no
// longer match the diff it's handed was built from a stale diff, and is
// re-seeded: rows that still match keep their answers. And when the caller
// asks (`retry`, the review page opening), a `failed` or `partial` scan runs
// again, since Jev may be back; answers are cached on content, so only what
// was never answered costs a call. A scan cut off while `running` (a restart)
// picks up where it left off. Each answer is committed before it is broadcast
// (invariant 8).

import { createHash } from "node:crypto";
import {
  flaggedHunkSmells,
  type HunkScanEventMessage,
  type HunkScanRow,
  type HunkScanStatus,
  hunkKey,
  isHunkRowPending,
} from "@revv/shared";
import { Effect } from "effect";
import { type HunkSelection, scanHunks, selectHunks } from "../ai/jev/hunk-scan";
import type { FileLike } from "../ai/jev/state";
import { debug } from "../logger";
import type { CacheService } from "./Cache";
import type { DbService } from "./Db";
import {
  closeHunkScan,
  discardHunkScan,
  getHunkScan,
  type HunkScanKey,
  type HunkScanRowRecord,
  type HunkScanSeed,
  listHunkScanRows,
  recordHunkSignals,
  seedHunkScan,
  toHunkScanRow,
} from "./hunk-scan-store";
import { JevService } from "./Jev";

export interface HunkScanInput extends HunkScanKey {
  /** Full-PR patches at `headSha`, even for an incremental review, so hunk indices match the Diff tab. */
  readonly files: readonly FileLike[];
  readonly filePriorities: ReadonlyArray<{
    readonly filename: string;
    readonly tier: number | null;
  }> | null;
}

/** The hunks `input` covers: what to seed, and what to ask in which order. */
export function planHunkScan(input: HunkScanInput): HunkSelection {
  const priorities =
    input.filePriorities === null
      ? null
      : new Map(input.filePriorities.map((f) => [f.filename, f.tier]));
  return selectHunks(input.files, priorities);
}

/** Identity of the diff a selection was cut from: equal for the same hunks, whatever their order. */
export function selectionFingerprint(selection: HunkSelection): string {
  const hash = createHash("sha1");
  for (const seed of selection.seeds) hash.update(`${hunkKey(seed)}\0${seed.contentHash}\n`);
  return hash.digest("hex");
}

/** Whether the persisted rows are exactly the seeds: same hunks, same content. */
function matchesSeeds(rows: readonly HunkScanRowRecord[], seeds: readonly HunkScanSeed[]) {
  if (rows.length !== seeds.length) return false;
  const hashes = new Map(seeds.map((seed) => [hunkKey(seed), seed.contentHash]));
  return rows.every((row) => hashes.get(hunkKey(row)) === row.contentHash);
}

/** Whether a scan in `status` is reused as it is (given its rows match the diff). */
function isSettled(status: HunkScanStatus, retry: boolean): boolean {
  return status === "complete" || (!retry && status !== "running");
}

/**
 * Run the first pass to a terminal state and return its rows (empty when it
 * failed or never ran). Never fails: a broken read or write discards the
 * scan, and the walkthrough goes ahead without leads.
 */
export function runHunkScan(
  input: HunkScanKey & {
    readonly selection: HunkSelection;
    readonly retry: boolean;
    readonly emit: (event: HunkScanEventMessage) => Effect.Effect<void>;
    /** Wraps the Jev calls, so the service can cap how many scans call at once. */
    readonly withCallSlot: <A, R>(effect: Effect.Effect<A, never, R>) => Effect.Effect<A, never, R>;
  },
): Effect.Effect<HunkScanRow[], never, JevService | CacheService | DbService> {
  const startedAt = Date.now();
  const key = { prId: input.prId, headSha: input.headSha };
  const label = `${input.prId}@${input.headSha.slice(0, 7)}`;

  return Effect.gen(function* () {
    const existing = yield* getHunkScan(key);
    const rows = existing === null ? [] : yield* listHunkScanRows(existing.id);
    const fresh = matchesSeeds(rows, input.selection.seeds);
    if (existing !== null) {
      // A failed scan has no rows to compare; only a retry runs it again.
      if (existing.status === "failed" && !input.retry) return [];
      if (fresh && isSettled(existing.status, input.retry)) return rows.map(toHunkScanRow);
    }

    // Switch off or no key. A scan cut off mid-run is ended exactly as if Jev
    // had stopped answering; anything else is left as it is.
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) {
      if (existing?.status === "running") {
        return yield* finish(existing.id, "Jev became unavailable").pipe(
          Effect.catchAll((e) => fail(existing.id, String(e))),
        );
      }
      return fresh ? rows.map(toHunkScanRow) : [];
    }

    const id = yield* seedHunkScan(key, input.selection.seeds);
    return yield* scan(id).pipe(Effect.catchAll((e) => fail(id, String(e))));
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        debug("jev", `hunk-scan ${label} could not start: ${String(e)}`);
        return [];
      }),
    ),
  );

  /** Ask about every row still waiting, then close the scan. */
  function scan(id: string) {
    return Effect.gen(function* () {
      const seeded = yield* listHunkScanRows(id);
      yield* input.emit({
        type: "hunk-scan:started",
        data: { ...key, rows: seeded.map(toHunkScanRow) },
      });
      const waiting = new Set(seeded.filter(isHunkRowPending).map(hunkKey));
      const targets = input.selection.targets.filter((target) => waiting.has(hunkKey(target)));
      yield* input.withCallSlot(
        scanHunks(targets, (target, signals) =>
          recordHunkSignals(id, target.filePath, target.hunkIndex, signals).pipe(
            Effect.flatMap((row) =>
              row === null
                ? Effect.void
                : input.emit({ type: "hunk-scan:hunk", data: { ...key, row } }),
            ),
            Effect.catchAll((e) =>
              Effect.sync(() => debug("jev", `hunk-scan record failed: ${String(e)}`)),
            ),
          ),
        ),
      );
      return yield* finish(id, "Jev answered nothing");
    });
  }

  /** Close the scan on its committed rows: `complete`, `partial`, or — nothing answered — `failed`. */
  function finish(id: string, nothingAnswered: string) {
    return Effect.gen(function* () {
      const rows = (yield* listHunkScanRows(id)).map(toHunkScanRow);
      const answered = rows.filter((row) => row.signals !== null).length;
      const waiting = rows.filter(isHunkRowPending).length;
      if (answered === 0 && waiting > 0) return yield* fail(id, nothingAnswered);

      const status = waiting > 0 ? "partial" : "complete";
      yield* closeHunkScan(id, status);
      const closed = rows.map(
        (row): HunkScanRow => (isHunkRowPending(row) ? { ...row, skipReason: "unscanned" } : row),
      );
      const flagged = closed.filter((r) => flaggedHunkSmells(r.signals).length > 0).length;
      const durationMs = Date.now() - startedAt;
      debug(
        "jev",
        `hunk-scan ${label} ${status}: ${answered}/${closed.length} hunks answered, ${flagged} flagged, ${durationMs}ms`,
      );
      yield* input.emit({
        type: "hunk-scan:complete",
        data: { ...key, status, scanned: answered, flagged, durationMs },
      });
      return closed;
    });
  }

  /**
   * Discard the scan and say so. Best effort: if even this write fails, the
   * row stays `running`, nothing is announced (commit first, broadcast
   * second), and the next run retries.
   */
  function fail(id: string, reason: string) {
    return Effect.gen(function* () {
      debug("jev", `hunk-scan ${label} failed: ${reason}`);
      const discarded = yield* discardHunkScan(id).pipe(
        Effect.as(true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      if (!discarded) return [];
      yield* input.emit({
        type: "hunk-scan:complete",
        data: {
          ...key,
          status: "failed",
          scanned: 0,
          flagged: 0,
          durationMs: Date.now() - startedAt,
        },
      });
      return [];
    });
  }
}
