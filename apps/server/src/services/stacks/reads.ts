import type { StackBriefLayer } from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackBriefLayers } from "../../db/schema/stack-briefs";

/** Revv's PR ids for the repository's PR numbers it tracks. */
export function prIdsByNumber(
  db: Db,
  repositoryId: string,
  numbers: readonly number[],
): Map<number, string> {
  if (numbers.length === 0) return new Map();
  const rows = db
    .select({ id: pullRequests.id, number: pullRequests.externalId })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        inArray(pullRequests.externalId, [...numbers]),
      ),
    )
    .all();
  return new Map(rows.map((r) => [r.number, r.id]));
}

export function isCompleteReview(w: {
  readonly phase: string;
  readonly completedAt: string | null;
  readonly status: string;
}): boolean {
  return w.phase === "D" && w.completedAt !== null && w.status !== "error";
}

export function readBriefLayers(db: Db, briefId: string): StackBriefLayer[] {
  return db
    .select({
      position: stackBriefLayers.position,
      prNumber: stackBriefLayers.prNumber,
      role: stackBriefLayers.role,
      reviewFocus: stackBriefLayers.reviewFocus,
      chapter: stackBriefLayers.chapter,
      buildsOn: stackBriefLayers.buildsOn,
    })
    .from(stackBriefLayers)
    .where(eq(stackBriefLayers.briefId, briefId))
    .orderBy(stackBriefLayers.position)
    .all();
}
