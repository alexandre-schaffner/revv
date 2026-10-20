// ── Stack reads ─────────────────────────────────────────────────────────────
//
// DB reads the stack overlay and the stack-brief tools both make, so the two
// can't disagree on what a finished review is or how a brief's layers read.

import type { StackBriefLayer } from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { stackBriefLayers } from "../../db/schema/stack-briefs";

/** A walkthrough that finished all four phases: a review a layer can lean on. */
export function isCompleteReview(w: {
  readonly phase: string;
  readonly completedAt: string | null;
  readonly status: string;
}): boolean {
  return w.phase === "D" && w.completedAt !== null && w.status !== "error";
}

/** The layers a brief has written so far, base first. */
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
