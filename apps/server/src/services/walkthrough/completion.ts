// The one journal check behind both `complete_walkthrough` (the agent's gate)
// and the orchestrator's decision to mark a row `complete` (invariant 12),
// declared as a list of requirements so the text the agent reads about the
// gate renders from the same list the gate checks. Every unmet requirement
// refuses the gate; the orchestrator ignores the `gate-only` ones.

import { RATING_AXES } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../db/schema/walkthrough-semantic-steps";
import {
  findIssuesMissingInlineComment,
  isJourneyChapterText,
  isRatedAxis,
  journeyKeywordList,
  loadWalkthroughRow,
  renderMissingInlineCommentError,
  type WalkthroughRow,
} from "./content";
import { findUnresolvedLeads, renderUnresolvedLeadsError } from "./leads";

export interface CompletionBlocker {
  /** `hard` blocks both; `gate-only` blocks the agent's gate but not the orchestrator. */
  readonly scope: "hard" | "gate-only";
  /** Agent-facing: what to call next. */
  readonly message: string;
}

interface Journal {
  readonly db: Db;
  readonly row: WalkthroughRow;
  readonly blocks: ReadonlyArray<{ readonly semanticStepIndex: number }>;
  readonly chapters: ReadonlyArray<{
    readonly semanticStepIndex: number;
    readonly title: string;
    readonly summary: string | null;
  }>;
}

function journalOf(db: Db, row: WalkthroughRow): Journal {
  let blocks: Journal["blocks"] | undefined;
  let chapters: Journal["chapters"] | undefined;
  return {
    db,
    row,
    get blocks() {
      blocks ??= db
        .select({ semanticStepIndex: walkthroughBlocks.semanticStepIndex })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, row.id),
            eq(walkthroughBlocks.phase, "diff_analysis"),
          ),
        )
        .all();
      return blocks;
    },
    get chapters() {
      chapters ??= db
        .select({
          semanticStepIndex: walkthroughSemanticSteps.semanticStepIndex,
          title: walkthroughSemanticSteps.title,
          summary: walkthroughSemanticSteps.summary,
        })
        .from(walkthroughSemanticSteps)
        .where(eq(walkthroughSemanticSteps.walkthroughId, row.id))
        .all();
      return chapters;
    },
  };
}

interface CompletionRequirement {
  /** The requirement as the agent is told it, in `complete_walkthrough`'s description and the system prompt. */
  readonly statement: string;
  readonly scope: CompletionBlocker["scope"];
  /** What to do when the journal doesn't meet it, or null when it does. */
  readonly blocker: (journal: Journal) => string | null;
}

/** Everything `complete_walkthrough` checks, in the order it checks it. */
const COMPLETION_REQUIREMENTS: readonly CompletionRequirement[] = [
  {
    statement: `Phase D reached (all ${RATING_AXES.length} axes rated)`,
    scope: "hard",
    blocker: ({ row }) =>
      row.lastCompletedPhase === "D"
        ? null
        : `Error: complete_walkthrough requires Phase D complete (all ${RATING_AXES.length} axes rated). Current phase: '${row.lastCompletedPhase}'.`,
  },
  {
    statement: "summary (Phase A) and sentiment (Phase C) non-empty",
    scope: "hard",
    blocker: ({ row }) =>
      row.summary && row.sentiment
        ? null
        : "Error: complete_walkthrough requires both summary (Phase A) and sentiment (Phase C) to be non-empty.",
  },
  {
    statement: "at least one diff step",
    scope: "hard",
    blocker: ({ blocks }) =>
      blocks.length > 0 ? null : "Error: complete_walkthrough requires at least one diff step.",
  },
  {
    statement: "at least one chapter",
    scope: "hard",
    blocker: ({ chapters }) =>
      chapters.length > 0
        ? null
        : "Error: complete_walkthrough requires at least one semantic step (chapter). Call add_semantic_step before any add_diff_step.",
  },
  {
    statement: `in reviewer mode, chapter 0 is the 'How we got here' journey chapter, its title or summary containing one of ${journeyKeywordList("'")}`,
    scope: "hard",
    blocker: ({ row, chapters }) => {
      if (row.mode === "author") return null;
      // Chapters carry no type, so the journey chapter is recognized by the
      // keywords the prompt tells the agent to title it with.
      const first = chapters.find((r) => r.semanticStepIndex === 0);
      if (!first) {
        return "Error: complete_walkthrough requires a journey chapter at semantic_step_index 0. Open it with add_semantic_step({ semantic_step_index: 0, title: 'How we got here', initial_block: { markdown: { content: '...' } } }) — see the prompt's 'How we got here' guidance.";
      }
      return isJourneyChapterText(first.title, first.summary)
        ? null
        : `Error: the chapter at semantic_step_index 0 is required to be the 'How we got here' journey chapter, but its title ('${first.title}') and summary do not name the journey. Re-call add_semantic_step with semantic_step_index 0 and a title (or summary) that includes one of: ${journeyKeywordList("'")}. The chapter should narrate the commit history get_commit_history returns — not commit-by-commit, but the shape of the work.`;
    },
  },
  {
    statement: "every block in a chapter opened by add_semantic_step",
    scope: "hard",
    blocker: ({ blocks, chapters }) => {
      const known = new Set(chapters.map((r) => r.semanticStepIndex));
      const orphans = [
        ...new Set(blocks.map((b) => b.semanticStepIndex).filter((i) => !known.has(i))),
      ];
      return orphans.length === 0
        ? null
        : `Error: blocks reference unknown semantic_step_index values [${orphans.join(", ")}]. Each block must belong to a chapter opened by add_semantic_step.`;
    },
  },
  {
    statement: "every chapter holding at least one block",
    scope: "hard",
    blocker: ({ blocks, chapters }) => {
      const filled = new Set(blocks.map((b) => b.semanticStepIndex));
      const empty = chapters.map((r) => r.semanticStepIndex).filter((i) => !filled.has(i));
      return empty.length === 0
        ? null
        : `Error: semantic_step(s) [${empty.join(", ")}] have no atomic blocks. Each chapter needs ≥1 add_diff_step call.`;
    },
  },
  {
    statement: `all ${RATING_AXES.length} axes rated with a rationale`,
    scope: "hard",
    blocker: ({ db, row }) => {
      const rated = new Set(
        db
          .select({ axis: walkthroughRatings.axis, rationale: walkthroughRatings.rationale })
          .from(walkthroughRatings)
          .where(eq(walkthroughRatings.walkthroughId, row.id))
          .all()
          .filter(isRatedAxis)
          .map((r) => r.axis),
      );
      const missing = RATING_AXES.filter((a) => !rated.has(a));
      return missing.length === 0
        ? null
        : `Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough.`;
    },
  },
  {
    // flag_issue writes the sidebar card, add_issue_comment the inline note;
    // without it a line-anchored concern is invisible to the coder.
    statement: "every line-anchored concern with at least one add_issue_comment thread",
    scope: "hard",
    blocker: ({ db, row }) => {
      const uncommented = findIssuesMissingInlineComment(db, row.id);
      return uncommented.length === 0 ? null : renderMissingInlineCommentError(uncommented);
    },
  },
  {
    // A first-pass lead is a hint; a skipped hint shouldn't cost the review.
    statement: "every first-pass lead given a resolve_lead verdict",
    scope: "gate-only",
    blocker: ({ db, row }) => {
      const unresolved = findUnresolvedLeads(db, row.id);
      return unresolved.length === 0 ? null : renderUnresolvedLeadsError(unresolved);
    },
  },
];

/** The requirements as a markdown list, for the system prompt. */
export function renderCompletionRequirements(): string {
  return COMPLETION_REQUIREMENTS.map((r) => `- ${r.statement}`).join("\n");
}

/** The requirements as one sentence, for `complete_walkthrough`'s description. */
export function completionRequirementsSentence(): string {
  return COMPLETION_REQUIREMENTS.map((r) => r.statement).join("; ");
}

/** Why the walkthrough isn't finished: the first unmet requirement, or empty when it is. */
export function walkthroughCompletionBlockers(db: Db, walkthroughId: string): CompletionBlocker[] {
  const row = loadWalkthroughRow(db, walkthroughId);
  if (!row) return [{ scope: "hard", message: `Walkthrough ${walkthroughId} not found.` }];
  const journal = journalOf(db, row);
  for (const requirement of COMPLETION_REQUIREMENTS) {
    const message = requirement.blocker(journal);
    if (message !== null) return [{ scope: requirement.scope, message }];
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
