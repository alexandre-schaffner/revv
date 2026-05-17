// ─── walkthrough-tools ───────────────────────────────────────────────────────
//
// Phase-bound MCP tool handlers for the walkthrough pipeline. Consumed by both
// the Claude Agent SDK (in-process via mcp-walkthrough.ts) and the HTTP MCP
// route (apps/server/src/routes/mcp/walkthrough.ts). Handler implementations
// are shared — per doctrine invariant #13 (Agent-path parity), behavior is
// byte-for-byte identical across transports.
//
// Each handler:
//   1. Opens a single db.transaction() covering: phase read, precondition
//      check, content upsert, phase advance.
//   2. Emits a WalkthroughStreamEvent AFTER the DB commit (commit-first /
//      broadcast-second — doctrine invariant #8).
//   3. Returns an MCP-style `{ content, isError? }` result.
//
// Phase preconditions are enforced here AND only here. If a caller invokes
// add_diff_step before set_overview, this module returns a structured error
// the agent can recover from — the DB row is never touched.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  RatingCitation,
  RiskLevel,
  WalkthroughPipelinePhase,
  WalkthroughRating,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import {
  blockIdFor,
  errorResult,
  findIssuesMissingInlineComment,
  isJourneyChapterText,
  loadWalkthroughRow,
  okResult,
  renderMissingInlineCommentError,
  unwrapJsonWrappedString,
} from "./helpers";
import {
  addDiffStepHandler,
  addIssueCommentHandler,
  addSemanticStepHandler,
  flagIssueHandler,
} from "./phase-b-handlers";
import {
  getCommitHistoryHandler,
  getRepoContextHandler,
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
  getWalkthroughStateSchema,
  RATING_AXES as RATING_AXES_SPEC,
  type RateAxisInput,
  rateAxisSchema,
  type SetOverviewInput,
  type SetSentimentInput,
  setOverviewSchema,
  setSentimentSchema,
  type ToolSpec,
  type WalkthroughToolContext,
  type WalkthroughToolHandler,
  type WalkthroughToolResult,
} from "./spec";

// ── Re-exports (preserve public API) ────────────────────────────────────────

export type { MissingInlineComment } from "./helpers";
export {
  blockIdFor,
  findIssuesMissingInlineComment,
  renderMissingInlineCommentError,
  unwrapJsonWrappedString,
} from "./helpers";
export {
  addDiffStepHandler,
  addIssueCommentHandler,
  addSemanticStepHandler,
  flagIssueHandler,
} from "./phase-b-handlers";
export {
  getCommitHistoryHandler,
  getRepoContextHandler,
  getWalkthroughStateHandler,
} from "./read-handler";
export { computeAnchorThreadId, computeIssueId } from "./spec";

// ── Handler: set_overview (Phase A) ──────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'none'.
// Writes: walkthroughs.summary, walkthroughs.risk_level.
// Advances: last_completed_phase → 'A'.

export const setOverviewHandler: WalkthroughToolHandler<SetOverviewInput> = async (ctx, input) => {
  const summary = unwrapJsonWrappedString(input.summary, "summary");

  let result: WalkthroughToolResult | null = null;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (phase !== "none") {
      result = errorResult(
        `Error: set_overview can only be called once, before any other tool. Current phase: '${phase}'. If you're resuming, call get_walkthrough_state first — the overview has already been set.`,
      );
      return;
    }
    ctx.db
      .update(walkthroughs)
      .set({
        summary,
        riskLevel: input.risk_level,
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
      riskLevel: input.risk_level as RiskLevel,
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
//
// Phase precondition: last_completed_phase === 'B' (and thus at least one
// diff step persisted — Phase B can't be entered without one).
// Writes: walkthroughs.sentiment.
// Advances: last_completed_phase → 'C'.

export const setSentimentHandler: WalkthroughToolHandler<SetSentimentInput> = async (
  ctx,
  input,
) => {
  const markdown = unwrapJsonWrappedString(input.markdown, "markdown");

  let result: WalkthroughToolResult | null = null;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (phase !== "B") {
      result = errorResult(
        `Error: set_sentiment requires Phase B complete (at least one diff step persisted). Current phase: '${phase}'. Add diff steps first.`,
      );
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
      .set({ sentiment: markdown, lastCompletedPhase: "C" })
      .where(eq(walkthroughs.id, ctx.walkthroughId))
      .run();
  });
  if (result) return result;

  ctx.emit({ type: "sentiment", data: { sentiment: markdown } });
  ctx.emit({
    type: "phase:advanced",
    data: { lastCompletedPhase: "C" },
  });
  return okResult("Sentiment set. Phase C complete — now rate each of the 9 axes with rate_axis.");
};

// ── Handler: rate_axis (Phase D) ─────────────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'C', 'D'}.
// Writes: one walkthrough_ratings row (upsert on (walkthroughId, axis)).
// Advances: last_completed_phase → 'D' on the 9th distinct axis.

export const rateAxisHandler: WalkthroughToolHandler<RateAxisInput> = async (ctx, input) => {
  if (input.verdict !== "pass" && input.citations.length === 0) {
    return errorResult(
      `Error: verdict='${input.verdict}' requires at least one citation. Add a citation pointing to the specific line range, or downgrade to 'pass' with an explanatory rationale.`,
    );
  }

  let result: WalkthroughToolResult | null = null;
  let ratingEvent: WalkthroughRating | null = null;
  let advanced = false;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (phase !== "C" && phase !== "D") {
      result = errorResult(
        `Error: rate_axis requires Phase C complete (sentiment set). Current phase: '${phase}'. Call set_sentiment first.`,
      );
      return;
    }

    // Validate block_refs reference persisted diff blocks if any given.
    if (input.block_refs.length > 0) {
      const stepRows = ctx.db
        .select({
          semanticStepIndex: walkthroughBlocks.semanticStepIndex,
          stepIndex: walkthroughBlocks.stepIndex,
        })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
          ),
        )
        .all();
      const knownBlocks = new Set(stepRows.map((r) => `${r.semanticStepIndex}:${r.stepIndex}`));
      const unknown = input.block_refs.filter(
        (r) => !knownBlocks.has(`${r.semantic_step_index}:${r.step_index}`),
      );
      if (unknown.length > 0) {
        result = errorResult(
          `Error: block_refs [${unknown.map((r) => `{semantic_step_index: ${r.semantic_step_index}, step_index: ${r.step_index}}`).join(", ")}] reference diff blocks that don't exist.`,
        );
        return;
      }
    }

    const seen = new Set<string>();
    const uniqueRefs = input.block_refs.filter((r) => {
      const k = `${r.semantic_step_index}:${r.step_index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const blockIds = uniqueRefs.map((r) =>
      blockIdFor(ctx.walkthroughId, r.semantic_step_index, r.step_index),
    );
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
        verdict: input.verdict,
        confidence: input.confidence,
        rationale: input.rationale,
        details: input.details,
        citations: JSON.stringify(citations),
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [walkthroughRatings.walkthroughId, walkthroughRatings.axis],
        set: {
          verdict: input.verdict,
          confidence: input.confidence,
          rationale: input.rationale,
          details: input.details,
          citations: JSON.stringify(citations),
          blockIds: JSON.stringify(blockIds),
        },
      })
      .run();

    // Count distinct axes rated; advance phase to 'D' if all 9 present.
    const ratedRows = ctx.db
      .select({ axis: walkthroughRatings.axis })
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
      .all();
    const ratedSet = new Set(ratedRows.map((r) => r.axis));
    if (ratedSet.size === RATING_AXES_SPEC.length && row.lastCompletedPhase !== "D") {
      ctx.db
        .update(walkthroughs)
        .set({ lastCompletedPhase: "D" })
        .where(eq(walkthroughs.id, ctx.walkthroughId))
        .run();
      advanced = true;
    }

    const rating: WalkthroughRating = {
      axis: input.axis,
      verdict: input.verdict,
      confidence: input.confidence,
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
// Phase precondition: last_completed_phase === 'D' AND all 9 axes rated AND
// sentiment non-empty AND ≥1 diff step. The actual `status='complete'`
// transition is performed by WalkthroughJobs in response to the `done` event —
// this handler only validates, then emits `done`. Doctrine invariant #11:
// status transitions are orchestrator-only.

export const completeWalkthroughHandler: WalkthroughToolHandler<CompleteWalkthroughInput> = async (
  ctx,
) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
  }
  const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
  if (phase !== "D") {
    return errorResult(
      `Error: complete_walkthrough requires Phase D complete (all 9 axes rated). Current phase: '${phase}'.`,
    );
  }
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
  // Required journey chapter at semantic_step_index 0. The chapter is the
  // narrative of how the coder reached the state being reviewed; the user
  // prompt seeds it with a `### Commit history` section, and the system
  // prompt instructs the agent to open chapter 0 with a journey-flavored
  // title. We can't tag chapters structurally (no extra column), so we
  // validate via title/summary keywords — the prompt and the regex are
  // intentionally kept in lockstep (see JOURNEY_CHAPTER_PATTERN).
  const firstChapter = semanticRows.find((r) => r.semanticStepIndex === 0);
  if (!firstChapter) {
    return errorResult(
      "Error: complete_walkthrough requires a journey chapter at semantic_step_index 0. Open it with add_semantic_step({ semantic_step_index: 0, title: 'How we got here', initial_block: { markdown: { content: '...' } } }) — see the prompt's 'How we got here' guidance.",
    );
  }
  if (!isJourneyChapterText(firstChapter.title, firstChapter.summary)) {
    return errorResult(
      `Error: the chapter at semantic_step_index 0 is required to be the 'How we got here' journey chapter, but its title ('${firstChapter.title}') and summary do not name the journey. Re-call add_semantic_step with semantic_step_index 0 and a title (or summary) that includes one of: 'journey', 'history', 'got here', 'how we', 'evolution', 'explored', 'attempts', 'origins', 'trajectory', 'path to', 'came to', 'story of', 'trail'. The chapter should narrate the commit-history narrative surfaced in the user prompt's Commit history section — not commit-by-commit, but the shape of the work.`,
    );
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

  const ratedAxes = ctx.db
    .select({ axis: walkthroughRatings.axis })
    .from(walkthroughRatings)
    .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
    .all();
  const ratedSet = new Set(ratedAxes.map((r) => r.axis));
  const missing = RATING_AXES_SPEC.filter((a) => !ratedSet.has(a));
  if (missing.length > 0) {
    return errorResult(
      `Error: missing ratings for [${missing.join(", ")}]. Call rate_axis for each before complete_walkthrough.`,
    );
  }

  // Every line-anchored WARNING or CRITICAL issue must have at least one
  // inline comment. The agent's job is `flag_issue` (sidebar card) +
  // `add_issue_comment` (inline review comment); a warning/critical with no
  // inline comment is invisible to the coder at the place that matters.
  // Exempt: severity='info' (nitpicks — no inline noise expected) and
  // PR-wide issues (file_path / start_line NULL — no anchor possible).
  //
  // Shared with WalkthroughJobs.ts — see findIssuesMissingInlineComment
  // above. Both gates MUST agree, otherwise the orchestrator can mark
  // `complete` while the tool surface would still reject.
  const uncommented = findIssuesMissingInlineComment(ctx.db, ctx.walkthroughId);
  if (uncommented.length > 0) {
    return errorResult(renderMissingInlineCommentError(uncommented));
  }

  // Deliberately NO stream emit here. The AI provider's generator end
  // (stream-guard synthesizes `done` with real token accounting) is the
  // authoritative completion signal that WalkthroughJobs observes. This
  // tool just validates invariants and lets the agent know it may stop
  // calling tools. Doctrine invariant #11: status transitions are
  // orchestrator-only.
  return okResult(
    "Walkthrough complete. You may stop. The orchestrator will transition status on generator end.",
  );
};

// ── Canonical TOOL_SPECS list ────────────────────────────────────────────────

/**
 * The full phase-bound tool surface. Both the Claude Agent SDK path and the
 * HTTP MCP route (opencode) consume this array — one source of truth.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TOOL_SPECS: Array<ToolSpec<any>> = [
  {
    name: "get_walkthrough_state",
    description:
      "Read-only. Call FIRST on every run, including resumes. Returns current phase, the chapter manifest (semanticSteps), per-chapter atomic blocks, rated axes, and metadata so you can pick up exactly where the previous run stopped. Skipping this risks duplicating work.",
    inputSchema: getWalkthroughStateSchema,
    handler: getWalkthroughStateHandler,
  },
  {
    name: "get_commit_history",
    description:
      "Read-only. Returns the PR commit list (sha, first-line message, author, date) in oldest → newest order. Call this once before opening chapter 0 ('How we got here' journey chapter) so you can narrate the narrative of the work, course corrections, and abandoned tracks. The response also includes guidance for the single-commit / empty-history edge cases.",
    inputSchema: getCommitHistorySchema,
    handler: getCommitHistoryHandler,
  },
  {
    name: "get_repo_context",
    description:
      "Read-only. Returns the most-recent complete project recaps for this repository (daily and/or weekly summaries of what shipped, themes, risk patterns). Call this once during Phase A to ground your overview in repo-level context. Returns an empty list when no recaps exist yet — proceed without context in that case. Do not pad the overview with repo-context references when none are directly relevant to this PR.",
    inputSchema: getRepoContextSchema,
    handler: getRepoContextHandler,
  },
  {
    name: "set_overview",
    description:
      "Phase A. Call exactly once, before any other write tool. Sets the PR summary (2-3 sentences) and overall risk level (low/medium/high). Advances phase to A.",
    inputSchema: setOverviewSchema,
    handler: setOverviewHandler,
  },
  {
    name: "add_semantic_step",
    description:
      "Phase B. Open a chapter AND write its first atomic block in one atomic transaction. Provide a monotonic zero-based semantic_step_index, a short title, an optional summary, and a REQUIRED initial_block (exactly one of markdown/code/diff — same shape as add_diff_step). The first call advances the pipeline from Phase A to Phase B. Subsequent blocks in the same chapter use add_diff_step with step_index starting at 1. Idempotent upsert on (walkthroughId, semantic_step_index) for both the chapter row and its step_index=0 block — retries replace, never duplicate.",
    inputSchema: addSemanticStepSchema,
    handler: addSemanticStepHandler,
  },
  {
    name: "add_diff_step",
    description:
      "Phase B. Append one atomic block (markdown, code excerpt, or diff hunk — exactly one of the three) to an already-opened chapter. Required: semantic_step_index (the parent chapter, opened by add_semantic_step), step_index (monotonic zero-based within the chapter — typically 1, 2, 3, ... since step_index=0 is already written by add_semantic_step's initial_block). Retries with the same composite key are idempotent upserts. Each chapter typically holds 2–5 atomic blocks total (1 from add_semantic_step + 1–4 from add_diff_step).",
    inputSchema: addDiffStepSchema,
    handler: addDiffStepHandler,
  },
  {
    name: "flag_issue",
    description:
      "Phase B. Flag a structured concern (security, correctness, tests, perf, etc.). Must be called AFTER the diff step(s) that explain the concern, and must link to them via block_refs = [{ semantic_step_index, step_index }, ...].",
    inputSchema: flagIssueSchema,
    handler: flagIssueHandler,
  },
  {
    name: "add_issue_comment",
    description:
      "Phase B. Attach a line-anchored comment to a previously flagged issue — appears inline in the diff view like a human review comment. Call AFTER flag_issue, passing its returned issue id. You may call this multiple times per issue to annotate multiple lines (one tool call per anchor). Idempotent per (issue_id, file_path, start_line, end_line, diff_side): a retry replaces the comment body, never duplicates the thread.",
    inputSchema: addIssueCommentSchema,
    handler: addIssueCommentHandler,
  },
  {
    name: "set_sentiment",
    description:
      "Phase C. Call exactly once, after all diff steps are persisted. 2–4 sentence overall verdict on the PR. Advances phase to C.",
    inputSchema: setSentimentSchema,
    handler: setSentimentHandler,
  },
  {
    name: "rate_axis",
    description:
      "Phase D. Call exactly once for each of the 9 axes (correctness, scope, tests, clarity, safety, consistency, api_changes, performance, description). Idempotent per axis — retries replace the prior rating. The 9th distinct axis advances phase to D.",
    inputSchema: rateAxisSchema,
    handler: rateAxisHandler,
  },
  {
    name: "complete_walkthrough",
    description:
      "Signal that the walkthrough is complete. Fails unless Phase D is reached with all 9 axes rated, summary + sentiment non-empty, and ≥1 diff step. The orchestrator observes the emitted `done` event and performs the final status transition.",
    inputSchema: completeWalkthroughSchema,
    handler: completeWalkthroughHandler,
  },
];

// ── Claude Agent SDK adapter ─────────────────────────────────────────────────
//
// Wraps TOOL_SPECS in the shape the Claude Agent SDK expects. The SDK calls
// tool handlers with just `args`, so we bind the context here (per MCP server
// creation). The HTTP MCP route binds the context per-request instead.

/**
 * Create an MCP server registration for the Claude Agent SDK, scoped to a
 * specific walkthroughId + emitter.
 */
export function createWalkthroughMcpServer(
  ctx: WalkthroughToolContext,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "revv-walkthrough",
    version: "2.0.0",
    tools: TOOL_SPECS.map((spec) =>
      tool(
        spec.name,
        spec.description,
        spec.inputSchema.shape,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args: any) => spec.handler(ctx, args),
      ),
    ),
  });
}

// ── Back-compat shims ────────────────────────────────────────────────────────
//
// The old `WalkthroughEmitter`, `createInitialState`, and
// `WalkthroughToolState` exports are no longer needed — state is in the DB,
// per doctrine. Any caller that still imports those symbols needs to migrate
// to the new context-threading model. We intentionally do NOT re-export the
// old names so stale imports surface as typecheck errors rather than silent
// misbehavior.

export type {
  WalkthroughToolContext,
  WalkthroughToolHandler,
  WalkthroughToolResult,
} from "./spec";
