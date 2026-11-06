// ─── walkthrough-tools ───────────────────────────────────────────────────────
//
// Phase-bound MCP tool handlers for the walkthrough pipeline. Consumed by the
// HTTP MCP route (apps/server/src/routes/mcp/walkthrough.ts) that every ACP
// agent talks to. Handler implementations are shared — per doctrine invariant
// #13 (Agent-path parity), behavior is byte-for-byte identical across agents.
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

import type {
  RatingCitation,
  RiskLevel,
  WalkthroughPipelinePhase,
  WalkthroughRating,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughs } from "../../../db/schema/walkthroughs";
import { walkthroughCompletionBlockers } from "../../../services/walkthrough/completion";
import type { ToolSpecBundle } from "../mcp-tool-gateway";
import { withContentWriteMetrics } from "../walkthrough-metrics";
import {
  blockIdFor,
  errorResult,
  loadWalkthroughRow,
  okResult,
  unwrapJsonWrappedString,
} from "./helpers";
import { resolveLeadHandler } from "./lead-handler";
import {
  addDiffStepHandler,
  addIssueCommentHandler,
  addSemanticStepHandler,
  flagIssueHandler,
} from "./phase-b-handlers";
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
  RATING_AXES as RATING_AXES_SPEC,
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

// ── Re-exports (preserve public API) ────────────────────────────────────────

export {
  blockIdFor,
  findIssuesMissingInlineComment,
  unwrapJsonWrappedString,
} from "./helpers";
export { computeAnchorThreadId, computeIssueId } from "./spec";

// ── Handler: set_overview (Phase A) ──────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'none'.
// Writes: walkthroughs.summary, and risk_level only if not already assigned
//   by the orchestrator (risk_confidence null).
// Advances: last_completed_phase → 'A'.

export const setOverviewHandler: WalkthroughToolHandler<SetOverviewInput> = async (ctx, input) => {
  const summary = unwrapJsonWrappedString(input.summary, "summary");

  let result: WalkthroughToolResult | null = null;
  let riskLevel: RiskLevel = "low";
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
    // Non-null riskConfidence marks the tier as orchestrator-assigned; its
    // value wins over the agent's argument, since the agent's issue budget
    // was already sized to it.
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
// Phase precondition: last_completed_phase ∈ {'C', 'D'}.
// Writes: one walkthrough_ratings row (upsert on (walkthroughId, axis)).
// Advances: last_completed_phase → 'D' once all 9 axes carry a rationale.
//
// The agent emits all nine calls in one turn, so they can land in any order.
// Safe because the whole body is one synchronous transaction: the rated-axis
// count below sees every prior call's commit, and exactly one call advances.

export const rateAxisHandler: WalkthroughToolHandler<RateAxisInput> = async (ctx, input) => {
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

    const { verdict, confidence } = input;
    if (verdict !== "pass" && input.citations.length === 0) {
      result = errorResult(
        `Error: verdict='${verdict}' requires at least one citation. Add a citation pointing to the specific line range, or downgrade to 'pass' with an explanatory rationale.`,
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

    // Advance to 'D' once every axis has a rationale, not just a row — rows
    // seeded by the retired Jev verdict pass carry empty prose.
    const ratedRows = ctx.db
      .select({ axis: walkthroughRatings.axis, rationale: walkthroughRatings.rationale })
      .from(walkthroughRatings)
      .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
      .all();
    const ratedSet = new Set(
      ratedRows.filter((r) => r.rationale.trim().length > 0).map((r) => r.axis),
    );
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
// Validates only, on the same journal check the orchestrator completes a run
// by (services/walkthrough/completion.ts); the status transition is the
// orchestrator's (invariant 11).

export const completeWalkthroughHandler: WalkthroughToolHandler<CompleteWalkthroughInput> = async (
  ctx,
) => {
  // Drain every scheduled relevance judgment before validating, so the gate
  // never checks an issue set that's about to change. Bounded; see ai/jev/pending.ts.
  await ctx.jev.awaitIssueJudgments();
  const [blocker] = walkthroughCompletionBlockers(ctx.db, ctx.walkthroughId);
  if (blocker) return errorResult(blocker.message);
  return okResult(
    "Walkthrough complete. You may stop. The orchestrator marks it complete when your turn ends.",
  );
};

// ── Canonical TOOL_SPECS list ────────────────────────────────────────────────

/** The full phase-bound tool surface, served by the `/mcp/walkthrough` route. */
export const TOOL_SPECS: ReadonlyArray<WalkthroughToolSpec> = [
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
      "Read-only. Reviewer mode only: returns the PR commit list (sha, first-line message, author, date) in oldest → newest order. Call this once before opening chapter 0 ('How we got here' journey chapter). In author self-review mode, do not call this tool; focus on current-diff preflight review.",
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
    name: "get_stack_context",
    description:
      "Read-only. For a PR that is one layer of a GitHub stack: the stack as captured at job start (layers base-first, this PR marked), the takeaway and open issue titles of each reviewed lower layer, and the title, description excerpt, and changed files of each upper layer. Call once during Phase A, and before flagging anything as missing — a higher layer may add it. Returns `stack: null` for a PR outside any stack.",
    inputSchema: getStackContextSchema,
    handler: getStackContextHandler,
  },
  {
    name: "set_overview",
    description:
      "Phase A. Call exactly once, before any other write tool. Sets the PR overview — a six-part briefing (takeaway, Context, Why, What changed, How, Watch) that a stranger to the code can follow — and the overall risk level (low/medium/high). Advances phase to A.",
    inputSchema: setOverviewSchema,
    handler: withContentWriteMetrics(setOverviewHandler),
  },
  {
    name: "add_semantic_step",
    description:
      "Phase B. Open a chapter AND write its first atomic block in one atomic transaction. Provide a monotonic zero-based semantic_step_index, a short title, an optional summary, and a REQUIRED initial_block (exactly one of markdown/code/diff — same shape as add_diff_step). The first call advances the pipeline from Phase A to Phase B. Subsequent blocks in the same chapter use add_diff_step with step_index starting at 1. Idempotent upsert on (walkthroughId, semantic_step_index) for both the chapter row and its step_index=0 block — retries replace, never duplicate.",
    inputSchema: addSemanticStepSchema,
    handler: withContentWriteMetrics(addSemanticStepHandler),
  },
  {
    name: "add_diff_step",
    description:
      "Phase B. Append one atomic block (markdown, code excerpt, or diff hunk — exactly one of the three) to an already-opened chapter. Required: semantic_step_index (the parent chapter, opened by add_semantic_step), step_index (monotonic zero-based within the chapter — typically 1, 2, 3, ... since step_index=0 is already written by add_semantic_step's initial_block). Retries with the same composite key are idempotent upserts. Each chapter typically holds 2–5 atomic blocks total (1 from add_semantic_step + 1–4 from add_diff_step).",
    inputSchema: addDiffStepSchema,
    handler: withContentWriteMetrics(addDiffStepHandler),
  },
  {
    name: "flag_issue",
    description:
      "Phase B. Flag a structured concern (security, correctness, tests, perf, etc.). Must be called AFTER the diff step(s) that explain the concern, and must link to them via block_refs = [{ semantic_step_index, step_index }, ...].",
    inputSchema: flagIssueSchema,
    handler: withContentWriteMetrics(flagIssueHandler),
  },
  {
    name: "add_issue_comment",
    description:
      "Phase B. Attach a line-anchored comment to a previously flagged issue — appears inline in the diff view like a human review comment. Call AFTER flag_issue, passing its returned issue id. You may call this multiple times per issue to annotate multiple lines (one tool call per anchor). Idempotent per (issue_id, file_path, start_line, end_line, diff_side): a retry replaces the comment body, never duplicates the thread.",
    inputSchema: addIssueCommentSchema,
    handler: withContentWriteMetrics(addIssueCommentHandler),
  },
  {
    name: "resolve_lead",
    description:
      "Phase B onward. Record your verdict on one first-pass lead from the prompt (lead_id `L1`, `L2`, …): `confirmed` with the issue_id of the issue you raised for it, or `rejected` with a one-sentence reason. Every lead needs one before complete_walkthrough. Idempotent per lead_id — a later call replaces the verdict. Independent calls can go out in parallel.",
    inputSchema: resolveLeadSchema,
    handler: withContentWriteMetrics(resolveLeadHandler),
  },
  {
    name: "set_sentiment",
    description:
      "Phase C. Call exactly once, after all diff steps are persisted. 2–4 sentence overall verdict on the PR. Advances phase to C.",
    inputSchema: setSentimentSchema,
    handler: withContentWriteMetrics(setSentimentHandler),
  },
  {
    name: "rate_axis",
    description:
      "Phase D. Call exactly once for each of the 9 axes (correctness, scope, tests, clarity, safety, consistency, api_changes, performance, description), sending all nine as parallel tool calls in a single turn. Calls are independent and may land in any order. Idempotent per axis — retries replace the prior rating. The 9th distinct axis advances phase to D.",
    inputSchema: rateAxisSchema,
    handler: withContentWriteMetrics(rateAxisHandler),
  },
  {
    name: "complete_walkthrough",
    description:
      "Signal that the walkthrough is complete. Fails unless Phase D is reached with all 9 axes rated, summary + sentiment non-empty, ≥1 diff step, every line-anchored issue commented, and every first-pass lead resolved. The orchestrator observes the emitted `done` event and performs the final status transition.",
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

export type {
  WalkthroughToolContext,
  WalkthroughToolHandler,
  WalkthroughToolResult,
} from "./spec";
