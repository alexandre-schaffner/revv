// ── When a walkthrough is finished ───────────────────────────────────────────
// The one journal check behind both `complete_walkthrough` (the agent's gate)
// and the orchestrator's decision to mark a row `complete` (invariant 12).
// Every blocker refuses the gate. The orchestrator ignores the `gate-only`
// ones: a first-pass lead is a hint, and a skipped hint shouldn't cost the
// whole review.

import { RATING_AXES } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import {
  findIssuesMissingInlineComment,
  isJourneyChapterText,
  loadWalkthroughRow,
  renderMissingInlineCommentError,
} from "../../ai/providers/walkthrough-tools/helpers";
import {
  findUnresolvedLeads,
  renderUnresolvedLeadsError,
} from "../../ai/providers/walkthrough-tools/lead-handler";
import type { Db } from "../../db";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";

export interface CompletionBlocker {
  /** `hard` blocks both; `gate-only` blocks the agent's gate but not the orchestrator. */
  readonly scope: "hard" | "gate-only";
  /** Agent-facing: what to call next. */
  readonly message: string;
}

/** Why the walkthrough isn't finished, in the order the agent should fix them. Empty when it is. */
export function walkthroughCompletionBlockers(db: Db, walkthroughId: string): CompletionBlocker[] {
  const hard = (message: string): CompletionBlocker[] => [{ scope: "hard", message }];
  const row = loadWalkthroughRow(db, walkthroughId);
  if (!row) return hard(`Walkthrough ${walkthroughId} not found.`);
  if (row.lastCompletedPhase !== "D") {
    return hard(
      `Error: complete_walkthrough requires Phase D complete (all 9 axes rated). Current phase: '${row.lastCompletedPhase}'.`,
    );
  }
  if (!row.summary || !row.sentiment) {
    return hard(
      "Error: complete_walkthrough requires both summary (Phase A) and sentiment (Phase C) to be non-empty.",
    );
  }

  const blockRows = db
    .select({ semanticStepIndex: walkthroughBlocks.semanticStepIndex })
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
      ),
    )
    .all();
  if (blockRows.length === 0) {
    return hard("Error: complete_walkthrough requires at least one diff step.");
  }

  const semanticRows = db
    .select({
      semanticStepIndex: walkthroughSemanticSteps.semanticStepIndex,
      title: walkthroughSemanticSteps.title,
      summary: walkthroughSemanticSteps.summary,
    })
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, walkthroughId))
    .all();
  if (semanticRows.length === 0) {
    return hard(
      "Error: complete_walkthrough requires at least one semantic step (chapter). Call add_semantic_step before any add_diff_step.",
    );
  }
  if (row.mode !== "author") {
    // Chapters carry no type, so the journey chapter is recognized by the
    // keywords the prompt tells the agent to title it with.
    const firstChapter = semanticRows.find((r) => r.semanticStepIndex === 0);
    if (!firstChapter) {
      return hard(
        "Error: complete_walkthrough requires a journey chapter at semantic_step_index 0. Open it with add_semantic_step({ semantic_step_index: 0, title: 'How we got here', initial_block: { markdown: { content: '...' } } }) — see the prompt's 'How we got here' guidance.",
      );
    }
    if (!isJourneyChapterText(firstChapter.title, firstChapter.summary)) {
      return hard(
        `Error: the chapter at semantic_step_index 0 is required to be the 'How we got here' journey chapter, but its title ('${firstChapter.title}') and summary do not name the journey. Re-call add_semantic_step with semantic_step_index 0 and a title (or summary) that includes one of: 'journey', 'history', 'got here', 'how we', 'evolution', 'explored', 'attempts', 'origins', 'trajectory', 'path to', 'came to', 'story of', 'trail'. The chapter should narrate the commit-history narrative surfaced in the user prompt's Commit history section — not commit-by-commit, but the shape of the work.`,
      );
    }
  }
  const knownSections = new Set(semanticRows.map((r) => r.semanticStepIndex));
  const orphanIndices = [
    ...new Set(
      blockRows
        .filter((b) => !knownSections.has(b.semanticStepIndex))
        .map((b) => b.semanticStepIndex),
    ),
  ];
  if (orphanIndices.length > 0) {
    return hard(
      `Error: blocks reference unknown semantic_step_index values [${orphanIndices.join(", ")}]. Each block must belong to a chapter opened by add_semantic_step.`,
    );
  }
  const blockSections = new Set(blockRows.map((b) => b.semanticStepIndex));
  const emptySections = semanticRows
    .map((r) => r.semanticStepIndex)
    .filter((i) => !blockSections.has(i));
  if (emptySections.length > 0) {
    return hard(
      `Error: semantic_step(s) [${emptySections.join(", ")}] have no atomic blocks. Each chapter needs ≥1 add_diff_step call.`,
    );
  }

  // A rating with no rationale (seeded by the retired Jev verdict pass) isn't one.
  const ratedSet = new Set(
    db
      .select({ axis: walkthroughRatings.axis, rationale: walkthroughRatings.rationale })
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.walkthroughId, walkthroughId))
      .all()
      .filter((r) => r.rationale.trim().length > 0)
      .map((r) => r.axis),
  );
  const missing = RATING_AXES.filter((a) => !ratedSet.has(a));
  if (missing.length > 0) {
    return hard(
      `Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough.`,
    );
  }

  // flag_issue writes the sidebar card, add_issue_comment the inline note;
  // without it a line-anchored concern is invisible to the coder.
  const uncommented = findIssuesMissingInlineComment(db, walkthroughId);
  if (uncommented.length > 0) return hard(renderMissingInlineCommentError(uncommented));

  const unresolved = findUnresolvedLeads(db, walkthroughId);
  if (unresolved.length > 0) {
    return [{ scope: "gate-only", message: renderUnresolvedLeadsError(unresolved) }];
  }
  return [];
}

/** The first blocker the orchestrator honours, or null when it may mark the row complete. */
export function orchestratorCompletionBlocker(db: Db, walkthroughId: string): string | null {
  return (
    walkthroughCompletionBlockers(db, walkthroughId).find((b) => b.scope === "hard")?.message ??
    null
  );
}
