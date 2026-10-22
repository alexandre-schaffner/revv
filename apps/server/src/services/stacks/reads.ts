import type { StackBriefLayer } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { stackBriefLayers } from "../../db/schema/stack-briefs";

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
