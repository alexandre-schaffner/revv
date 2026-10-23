import type { StackMergeRun, StackMergeRunStatus } from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";

export type RunRow = typeof stackMergeRuns.$inferSelect;

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
    layers: row.layersBaseFirst,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

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

export function updateLiveRun(
  db: Db,
  runId: string,
  patch: Partial<Pick<RunRow, "status" | "layersBaseFirst" | "error" | "updatedAt">>,
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
