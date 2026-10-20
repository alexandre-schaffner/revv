// ── Stack merge runs: the row ───────────────────────────────────────────────
//
// The `stack_merge_runs` reads and writes both stack services make: the merge
// owns its runs, and a rebase refuses while one is live. Plain DB calls; the
// services wrap them in their tagged DB error.

import type { StackMergeRun, StackMergeRunStatus } from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";

export type RunRow = typeof stackMergeRuns.$inferSelect;

/** A run a fiber is stepping, or should be: the only rows a step may write. */
export const LIVE_RUN_STATUSES = [
  "running",
  "waiting",
] as const satisfies readonly StackMergeRunStatus[];

export function isLiveStatus(status: StackMergeRunStatus): boolean {
  return LIVE_RUN_STATUSES.some((live) => live === status);
}

export function toRun(row: RunRow): StackMergeRun {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    stackNumber: row.stackNumber,
    throughPosition: row.throughPosition,
    method: row.method,
    mode: row.mode,
    status: row.status,
    layers: row.layers,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The stack's live run, if any. Takes a transaction too. */
export function liveRunFor(
  db: Pick<Db, "select">,
  repositoryId: string,
  stackNumber: number,
): RunRow | undefined {
  return db
    .select()
    .from(stackMergeRuns)
    .where(
      and(
        eq(stackMergeRuns.repositoryId, repositoryId),
        eq(stackMergeRuns.stackNumber, stackNumber),
        inArray(stackMergeRuns.status, [...LIVE_RUN_STATUSES]),
      ),
    )
    .get();
}

/**
 * Write a run only while it's still live, so a cancel committed between two
 * steps is never overwritten by the step after it. The row as written, or
 * undefined when it had already left `running`/`waiting`.
 */
export function updateLiveRun(
  db: Db,
  runId: string,
  patch: Partial<Pick<RunRow, "status" | "layers" | "error" | "updatedAt">>,
): RunRow | undefined {
  return db
    .update(stackMergeRuns)
    .set(patch)
    .where(
      and(eq(stackMergeRuns.id, runId), inArray(stackMergeRuns.status, [...LIVE_RUN_STATUSES])),
    )
    .returning()
    .get();
}
