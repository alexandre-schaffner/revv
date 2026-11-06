// ─── walkthrough-tools ───────────────────────────────────────────────────────
//
// The phase-bound MCP tool surface of the walkthrough pipeline, served by
// `routes/mcp/walkthrough.ts`. Phase A/C/D handlers and the completion gate
// live here; Phase B in `phase-b-handlers.ts`.

import type { RatingCitation, RiskLevel, WalkthroughRating } from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  findIssuesMissingInlineComment,
  isJourneyChapterText,
  isRatedAxis,
  journeyKeywordList,
  renderMissingInlineCommentError,
  renderUnknownBlockRefs,
  resolveBlockRefs,
} from "../../../services/walkthrough/content";
import type { ToolSpecBundle } from "../mcp-tool-gateway";
import { withContentWriteMetrics } from "../walkthrough-metrics";
import { errorResult, okResult, unwrapJsonWrappedString } from "./helpers";
import {
  findUnresolvedLeads,
  renderUnresolvedLeadsError,
  resolveLeadHandler,
} from "./lead-handler";
import {
  addDiffStepHandler,
  addIssueCommentHandler,
  addSemanticStepHandler,
  flagIssueHandler,
} from "./phase-b-handlers";
import { openForWrite, phaseDescription } from "./phases";
import {
  getCommitHistoryHandler,
  getRepoContextHandler,
  getStackContextHandler,
  getWalkthroughStateHandler,
} from "./read-handler";
import {
  addDiffStepSchema,
  addIssueCommentSchema,
  addSemanticStepSchema,
  type CompleteWalkthroughInput,
  completeWalkthroughSchema,
  flagIssueSchema,
  getCommitHistorySchema,
  getRepoContextSchema,
  getStackContextSchema,
  getWalkthroughStateSchema,
  type RateAxisInput,
  rateAxisSchema,
  resolveLeadSchema,
  type SetOverviewInput,
  type SetSentimentInput,
  setOverviewSchema,
  setSentimentSchema,
  type WalkthroughToolContext,
  type WalkthroughToolHandler,
  type WalkthroughToolResult,
  type WalkthroughToolSpec,
} from "./spec";

export type {
  WalkthroughToolContext,
  WalkthroughToolJudgments,
  WalkthroughToolResult,
} from "./spec";

// ── Handler: set_overview (Phase A) ──────────────────────────────────────────
//
// Writes the summary, and the risk tier only when the orchestrator has not
// assigned one (invariant 2's carve-out).

export const setOverviewHandler: WalkthroughToolHandler<SetOverviewInput> = async (ctx, input) => {
  const summary = unwrapJsonWrappedString(input.summary, "summary");

  let result: WalkthroughToolResult | null = null;
  let riskLevel: RiskLevel = "low";
  ctx.db.transaction(() => {
    const open = openForWrite(ctx.db, ctx.walkthroughId, "set_overview");
    if ("refusal" in open) {
      result = open.refusal;
      return;
    }
    const { row } = open;
    // The agent's issue budget was already sized to an assigned tier.
    const orchestratorAssigned = row.riskConfidence !== null;
    riskLevel = orchestratorAssigned
      ? (row.riskLevel as RiskLevel)
      : ((input.risk_level ?? row.riskLevel) as RiskLevel);
    ctx.db
      .update(walkthroughs)
      .set({
        summary,
        riskLevel,
        lastCompletedPhase: "A",
      })
      .where(eq(walkthroughs.id, ctx.walkthroughId))
      .run();
  });
  if (result) return result;

  ctx.emit({
    type: "summary",
    data: {
      summary,
      riskLevel,
    },
  });
  ctx.emit({
    type: "phase:advanced",
    data: { lastCompletedPhase: "A" },
  });
  return okResult(
    "Overview set. Phase A complete — open the first chapter with add_semantic_step (title + optional summary), then walk through it via add_diff_step calls.",
  );
};

// ── Handler: set_sentiment (Phase C) ─────────────────────────────────────────

export const setSentimentHandler: WalkthroughToolHandler<SetSentimentInput> = async (
  ctx,
  input,
) => {
  const markdown = unwrapJsonWrappedString(input.markdown, "markdown");

  let result: WalkthroughToolResult | null = null;
  ctx.db.transaction(() => {
    const open = openForWrite(ctx.db, ctx.walkthroughId, "set_sentiment");
    if ("refusal" in open) {
      result = open.refusal;
      return;
    }

    // Defensive: explicit zero-step check even though phase='B' implies ≥1.
    const anyStep = ctx.db
      .select({ id: walkthroughBlocks.id })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
        ),
      )
      .limit(1)
      .all();
    if (anyStep.length === 0) {
      result = errorResult(
        "Error: set_sentiment requires at least one diff step. Call add_diff_step first.",
      );
      return;
    }

    ctx.db
      .update(walkthroughs)
      .set({
        sentiment: markdown,
        lastCompletedPhase: "C",
      })
      .where(eq(walkthroughs.id, ctx.walkthroughId))
      .run();
  });
  if (result) return result;

  ctx.emit({ type: "sentiment", data: { sentiment: markdown } });
  ctx.emit({
    type: "phase:advanced",
    data: { lastCompletedPhase: "C" },
  });
  return okResult(
    "Sentiment set. Phase C complete — now rate all 9 axes with rate_axis, as nine parallel calls in one turn.",
  );
};

// ── Handler: rate_axis (Phase D) ─────────────────────────────────────────────
//
// The agent sends all nine calls in one turn, so they land in any order. The
// body is one synchronous transaction, so the rated-axis count sees every
// earlier call's commit and exactly one call advances the phase.

export const rateAxisHandler: WalkthroughToolHandler<RateAxisInput> = async (ctx, input) => {
  let result: WalkthroughToolResult | null = null;
  let ratingEvent: WalkthroughRating | null = null;
  let advanced = false;
  ctx.db.transaction(() => {
    const open = openForWrite(ctx.db, ctx.walkthroughId, "rate_axis");
    if ("refusal" in open) {
      result = open.refusal;
      return;
    }
    const { row } = open;

    const { verdict, confidence } = input;
    if (verdict !== "pass" && input.citations.length === 0) {
      result = errorResult(
        `Error: verdict='${verdict}' requires at least one citation. Add a citation pointing to the specific line range, or downgrade to 'pass' with an explanatory rationale.`,
      );
      return;
    }

    const refs = resolveBlockRefs(ctx.db, ctx.walkthroughId, input.block_refs);
    if ("unknown" in refs) {
      result = errorResult(renderUnknownBlockRefs(refs.unknown));
      return;
    }
    const { blockIds } = refs;
    const citations: RatingCitation[] = input.citations.map((c) => ({
      filePath: c.file_path,
      startLine: c.start_line,
      endLine: c.end_line,
      ...(c.note !== null ? { note: c.note } : {}),
    }));

    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughRatings)
      .values({
        id: crypto.randomUUID(),
        walkthroughId: ctx.walkthroughId,
        axis: input.axis,
        verdict,
        confidence,
        rationale: input.rationale,
        details: input.details,
        citations: JSON.stringify(citations),
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [walkthroughRatings.walkthroughId, walkthroughRatings.axis],
        set: {
          verdict,
          confidence,
          rationale: input.rationale,
          details: input.details,
          citations: JSON.stringify(citations),
          blockIds: JSON.stringify(blockIds),
        },
      })
      .run();

    const ratedSet = new Set(
      ctx.db
        .select({ axis: walkthroughRatings.axis, rationale: walkthroughRatings.rationale })
        .from(walkthroughRatings)
        .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
        .all()
        .filter(isRatedAxis)
        .map((r) => r.axis),
    );
    if (ratedSet.size === RATING_AXES.length && row.lastCompletedPhase !== "D") {
      ctx.db
        .update(walkthroughs)
        .set({ lastCompletedPhase: "D" })
        .where(eq(walkthroughs.id, ctx.walkthroughId))
        .run();
      advanced = true;
    }

    const rating: WalkthroughRating = {
      axis: input.axis,
      verdict,
      confidence,
      rationale: input.rationale,
      details: input.details,
      citations,
      blockIds,
    };
    ratingEvent = rating;
  });
  if (result) return result;
  if (ratingEvent) {
    ctx.emit({ type: "rating", data: ratingEvent });
  }
  if (advanced) {
    ctx.emit({
      type: "phase:advanced",
      data: { lastCompletedPhase: "D" },
    });
  }
  return okResult(
    advanced
      ? "Final axis rated — all 9 axes complete. Call complete_walkthrough now."
      : `Axis '${input.axis}' rated. Continue rating the remaining axes.`,
  );
};

// ── Handler: complete_walkthrough (validation gate) ──────────────────────────
//
// Validates only (invariant 12); the status transition is the orchestrator's
// (invariant 11).

export const completeWalkthroughHandler: WalkthroughToolHandler<CompleteWalkthroughInput> = async (
  ctx,
) => {
  // Drain every scheduled relevance judgment before validating, so the gate
  // never checks an issue set that's about to change. Bounded; see ai/jev/pending.ts.
  await ctx.jev.awaitIssueJudgments();
  const open = openForWrite(ctx.db, ctx.walkthroughId, "complete_walkthrough");
  if ("refusal" in open) return open.refusal;
  const { row } = open;
  if (!row.summary || !row.sentiment) {
    return errorResult(
      "Error: complete_walkthrough requires both summary (Phase A) and sentiment (Phase C) to be non-empty.",
    );
  }

  const blockRows = ctx.db
    .select({
      semanticStepIndex: walkthroughBlocks.semanticStepIndex,
    })
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
      ),
    )
    .all();
  if (blockRows.length === 0) {
    return errorResult("Error: complete_walkthrough requires at least one diff step.");
  }

  const semanticRows = ctx.db
    .select({
      semanticStepIndex: walkthroughSemanticSteps.semanticStepIndex,
      title: walkthroughSemanticSteps.title,
      summary: walkthroughSemanticSteps.summary,
    })
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, ctx.walkthroughId))
    .all();
  if (semanticRows.length === 0) {
    return errorResult(
      "Error: complete_walkthrough requires at least one semantic step (chapter). Call add_semantic_step before any add_diff_step.",
    );
  }
  if (row.mode !== "author") {
    // Chapters carry no type, so the journey chapter is recognized by the
    // keywords the prompt tells the agent to title it with.
    const firstChapter = semanticRows.find((r) => r.semanticStepIndex === 0);
    if (!firstChapter) {
      return errorResult(
        "Error: complete_walkthrough requires a journey chapter at semantic_step_index 0. Open it with add_semantic_step({ semantic_step_index: 0, title: 'How we got here', initial_block: { markdown: { content: '...' } } }) — see the prompt's 'How we got here' guidance.",
      );
    }
    if (!isJourneyChapterText(firstChapter.title, firstChapter.summary)) {
      return errorResult(
        `Error: the chapter at semantic_step_index 0 is required to be the 'How we got here' journey chapter, but its title ('${firstChapter.title}') and summary do not name the journey. Re-call add_semantic_step with semantic_step_index 0 and a title (or summary) that includes one of: ${journeyKeywordList("'")}. The chapter should narrate the commit-history narrative surfaced in the user prompt's Commit history section — not commit-by-commit, but the shape of the work.`,
      );
    }
  }
  const knownSections = new Set(semanticRows.map((r) => r.semanticStepIndex));
  const orphanIndices = Array.from(
    new Set(
      blockRows
        .filter((b) => !knownSections.has(b.semanticStepIndex))
        .map((b) => b.semanticStepIndex),
    ),
  );
  if (orphanIndices.length > 0) {
    return errorResult(
      `Error: blocks reference unknown semantic_step_index values [${orphanIndices.join(", ")}]. Each block must belong to a chapter opened by add_semantic_step.`,
    );
  }
  const blockSections = new Set(blockRows.map((b) => b.semanticStepIndex));
  const emptySections = semanticRows
    .map((r) => r.semanticStepIndex)
    .filter((i) => !blockSections.has(i));
  if (emptySections.length > 0) {
    return errorResult(
      `Error: semantic_step(s) [${emptySections.join(", ")}] have no atomic blocks. Each chapter needs ≥1 add_diff_step call.`,
    );
  }

  const ratedSet = new Set(
    ctx.db
      .select({ axis: walkthroughRatings.axis, rationale: walkthroughRatings.rationale })
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
      .all()
      .filter(isRatedAxis)
      .map((r) => r.axis),
  );
  const missing = RATING_AXES.filter((a) => !ratedSet.has(a));
  if (missing.length > 0) {
    return errorResult(
      `Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough.`,
    );
  }

  const uncommented = findIssuesMissingInlineComment(ctx.db, ctx.walkthroughId);
  if (uncommented.length > 0) {
    return errorResult(renderMissingInlineCommentError(uncommented));
  }

  // Every first-pass lead owes a verdict. This gate is the tool's alone: the
  // orchestrator completes a run without one, because a lead is a hint and an
  // unread hint shouldn't cost the whole review. Refusing here is what makes
  // the agent finish the job while it still has the context to do it.
  const unresolved = findUnresolvedLeads(ctx.db, ctx.walkthroughId);
  if (unresolved.length > 0) {
    return errorResult(renderUnresolvedLeadsError(unresolved));
  }

  return okResult(
    "Walkthrough complete. You may stop. The orchestrator marks it complete when your turn ends.",
  );
};

// ── Canonical TOOL_SPECS list ────────────────────────────────────────────────

export const TOOL_SPECS: ReadonlyArray<WalkthroughToolSpec> = [
  {
    name: "get_walkthrough_state",
    description:
      "Read-only. Call FIRST on every run, including resumes. Returns current phase, the chapter manifest (semanticSteps), per-chapter atomic blocks, rated axes, and metadata so you can pick up exactly where the previous run stopped. Skipping this risks duplicating work.",
    activity: "Reading walkthrough state...",
    inputSchema: getWalkthroughStateSchema,
    handler: getWalkthroughStateHandler,
  },
  {
    name: "get_commit_history",
    description:
      "Read-only. Reviewer mode only: returns the PR commit list (sha, first-line message, author, date) in oldest → newest order. Call this once before opening chapter 0 ('How we got here' journey chapter). In author self-review mode, do not call this tool; focus on current-diff preflight review.",
    activity: "Reading commit history...",
    inputSchema: getCommitHistorySchema,
    handler: getCommitHistoryHandler,
  },
  {
    name: "get_repo_context",
    description:
      "Read-only. Returns the most-recent complete project recaps for this repository (daily and/or weekly summaries of what shipped, themes, risk patterns). Call this once during Phase A to ground your overview in repo-level context. Returns an empty list when no recaps exist yet — proceed without context in that case. Do not pad the overview with repo-context references when none are directly relevant to this PR.",
    activity: "Reading recent project recaps...",
    inputSchema: getRepoContextSchema,
    handler: getRepoContextHandler,
  },
  {
    name: "get_stack_context",
    description:
      "Read-only. For a PR that is one layer of a GitHub stack: the stack as captured at job start (layers base-first, this PR marked), the takeaway and open issue titles of each reviewed lower layer, and the title, description excerpt, and changed files of each upper layer. Call once during Phase A, and before flagging anything as missing — a higher layer may add it. Returns `stack: null` for a PR outside any stack.",
    activity: "Reading the PR stack...",
    inputSchema: getStackContextSchema,
    handler: getStackContextHandler,
  },
  {
    name: "set_overview",
    description: phaseDescription(
      "set_overview",
      "Call exactly once, before any other write tool. Sets the PR overview — a six-part briefing (takeaway, Context, Why, What changed, How, Watch) that a stranger to the code can follow — and the overall risk level (low/medium/high). Advances phase to A.",
    ),
    activity: "Writing overview...",
    inputSchema: setOverviewSchema,
    handler: withContentWriteMetrics(setOverviewHandler),
  },
  {
    name: "add_semantic_step",
    description: phaseDescription(
      "add_semantic_step",
      "Open a chapter AND write its first atomic block in one atomic transaction. Provide a monotonic zero-based semantic_step_index, a short title, an optional summary, and a REQUIRED initial_block (exactly one of markdown/code/diff — same shape as add_diff_step). The first call advances the pipeline from Phase A to Phase B. Subsequent blocks in the same chapter use add_diff_step with step_index starting at 1. Idempotent upsert on (walkthroughId, semantic_step_index) for both the chapter row and its step_index=0 block — retries replace, never duplicate.",
    ),
    activity: "Writing walkthrough step...",
    inputSchema: addSemanticStepSchema,
    handler: withContentWriteMetrics(addSemanticStepHandler),
  },
  {
    name: "add_diff_step",
    description: phaseDescription(
      "add_diff_step",
      "Append one atomic block (markdown, code excerpt, or diff hunk — exactly one of the three) to an already-opened chapter. Required: semantic_step_index (the parent chapter, opened by add_semantic_step), step_index (monotonic zero-based within the chapter — typically 1, 2, 3, ... since step_index=0 is already written by add_semantic_step's initial_block). Retries with the same composite key are idempotent upserts. Each chapter typically holds 2–5 atomic blocks total (1 from add_semantic_step + 1–4 from add_diff_step).",
    ),
    activity: "Writing walkthrough step...",
    inputSchema: addDiffStepSchema,
    handler: withContentWriteMetrics(addDiffStepHandler),
  },
  {
    name: "flag_issue",
    description: phaseDescription(
      "flag_issue",
      "Flag a structured concern (security, correctness, tests, perf, etc.). Must be called AFTER the diff step(s) that explain the concern, and must link to them via block_refs = [{ semantic_step_index, step_index }, ...].",
    ),
    activity: "Flagging a concern...",
    inputSchema: flagIssueSchema,
    handler: withContentWriteMetrics(flagIssueHandler),
  },
  {
    name: "add_issue_comment",
    description: phaseDescription(
      "add_issue_comment",
      "Attach a line-anchored comment to a previously flagged issue — appears inline in the diff view like a human review comment. Call AFTER flag_issue, passing its returned issue id. You may call this multiple times per issue to annotate multiple lines (one tool call per anchor). Idempotent per (issue_id, file_path, start_line, end_line, diff_side): a retry replaces the comment body, never duplicates the thread.",
    ),
    activity: "Commenting on a concern...",
    inputSchema: addIssueCommentSchema,
    handler: withContentWriteMetrics(addIssueCommentHandler),
  },
  {
    name: "resolve_lead",
    description: phaseDescription(
      "resolve_lead",
      "Record your verdict on one first-pass lead from the prompt (lead_id `L1`, `L2`, …): `confirmed` with the issue_id of the issue you raised for it, or `rejected` with a one-sentence reason. Every lead needs one before complete_walkthrough. Idempotent per lead_id — a later call replaces the verdict. Independent calls can go out in parallel.",
    ),
    activity: "Resolving a first-pass lead...",
    inputSchema: resolveLeadSchema,
    handler: withContentWriteMetrics(resolveLeadHandler),
  },
  {
    name: "set_sentiment",
    description: phaseDescription(
      "set_sentiment",
      "Call exactly once, after all diff steps are persisted. 2–4 sentence overall verdict on the PR. Advances phase to C.",
    ),
    activity: "Writing the overall verdict...",
    inputSchema: setSentimentSchema,
    handler: withContentWriteMetrics(setSentimentHandler),
  },
  {
    name: "rate_axis",
    description: phaseDescription(
      "rate_axis",
      `Call exactly once for each of the ${RATING_AXES.length} axes (${RATING_AXES.join(", ")}), sending all ${RATING_AXES.length} as parallel tool calls in a single turn. Calls are independent and may land in any order. Idempotent per axis — retries replace the prior rating. The ${RATING_AXES.length}th distinct axis advances phase to D.`,
    ),
    activity: "Scoring PR quality...",
    inputSchema: rateAxisSchema,
    handler: withContentWriteMetrics(rateAxisHandler),
  },
  {
    name: "complete_walkthrough",
    description: phaseDescription(
      "complete_walkthrough",
      `Signal that the walkthrough is complete. Fails unless Phase D is reached with all ${RATING_AXES.length} axes rated, summary + sentiment non-empty, ≥1 diff step, every line-anchored issue commented, and every first-pass lead resolved. The orchestrator performs the final status transition when your turn ends.`,
    ),
    activity: "Finalizing walkthrough...",
    inputSchema: completeWalkthroughSchema,
    handler: completeWalkthroughHandler,
  },
];

export const WALKTHROUGH_TOOL_BUNDLE: ToolSpecBundle<
  WalkthroughToolContext,
  WalkthroughToolResult
> = {
  name: "revv-walkthrough",
  version: "2.0.0",
  specs: TOOL_SPECS,
};
