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
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughIssue,
  WalkthroughPipelinePhase,
  WalkthroughRating,
  WalkthroughState,
} from "@revv/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db";
import { walkthroughBlocks } from "../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../db/schema/walkthrough-ratings";
import { walkthroughs } from "../../db/schema/walkthroughs";
import {
  type AddDiffStepInput,
  addDiffStepSchema,
  type CompleteWalkthroughInput,
  completeWalkthroughSchema,
  computeIssueId,
  type FlagIssueInput,
  flagIssueSchema,
  type GetWalkthroughStateInput,
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
} from "./walkthrough-tool-spec";

// ── Phase helpers ────────────────────────────────────────────────────────────

const PHASE_ORDER: Record<WalkthroughPipelinePhase, number> = {
  none: 0,
  A: 1,
  B: 2,
  C: 3,
  D: 4,
};

function phaseAtLeast(
  phase: WalkthroughPipelinePhase,
  min: WalkthroughPipelinePhase,
): boolean {
  return PHASE_ORDER[phase] >= PHASE_ORDER[min];
}

function phaseAtMost(
  phase: WalkthroughPipelinePhase,
  max: WalkthroughPipelinePhase,
): boolean {
  return PHASE_ORDER[phase] <= PHASE_ORDER[max];
}

function errorResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function okResult(text: string): WalkthroughToolResult {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Read the walkthrough row for a tool call. Throws a tool-level error result
 * if the row is missing — the orchestrator is supposed to have created the
 * row before the agent starts calling tools.
 */
function loadWalkthroughRow(
  db: Db,
  walkthroughId: string,
): typeof walkthroughs.$inferSelect | null {
  return (
    db
      .select()
      .from(walkthroughs)
      .where(eq(walkthroughs.id, walkthroughId))
      .get() ?? null
  );
}

// ── Handler: get_walkthrough_state ───────────────────────────────────────────
//
// The first call every agent run makes, including resumes. Returns enough
// state for the agent to figure out where to pick up: which phase is
// complete, which diff steps exist, which axes have been rated.

export const getWalkthroughStateHandler: WalkthroughToolHandler<
  GetWalkthroughStateInput
> = async (ctx) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return errorResult(
      `Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
    );
  }

  const diffBlocks = ctx.db
    .select({
      stepIndex: walkthroughBlocks.stepIndex,
      type: walkthroughBlocks.type,
    })
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
      ),
    )
    .all();

  const ratingRows = ctx.db
    .select({ axis: walkthroughRatings.axis })
    .from(walkthroughRatings)
    .where(eq(walkthroughRatings.walkthroughId, ctx.walkthroughId))
    .all();

  const issueCountRow = ctx.db
    .select({ id: walkthroughIssues.id })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
    .all();

  const diffSteps = diffBlocks
    .filter(
      (b): b is { stepIndex: number; type: string } => b.stepIndex !== null,
    )
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((b) => ({
      stepIndex: b.stepIndex,
      blockType: b.type as WalkthroughBlock["type"],
    }));

  const state: WalkthroughState = {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    status: row.status as WalkthroughState["status"],
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    summary: row.summary || null,
    riskLevel: row.summary ? (row.riskLevel as RiskLevel) : null,
    sentiment: row.sentiment ?? null,
    diffSteps,
    ratedAxes: ratingRows.map((r) => r.axis as RatingAxis),
    issueCount: issueCountRow.length,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
  };
};

// ── Handler: set_overview (Phase A) ──────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'none'.
// Writes: walkthroughs.summary, walkthroughs.risk_level.
// Advances: last_completed_phase → 'A'.

export const setOverviewHandler: WalkthroughToolHandler<
  SetOverviewInput
> = async (ctx, input) => {
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
        summary: input.summary,
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
      summary: input.summary,
      riskLevel: input.risk_level as RiskLevel,
    },
  });
  ctx.emit({
    type: "phase:advanced",
    data: { lastCompletedPhase: "A" },
  });
  return okResult(
    "Overview set. Phase A complete — now add diff-analysis steps with add_diff_step (one call per step).",
  );
};

// ── Handler: add_diff_step (Phase B) ─────────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'}.
// Writes: one walkthrough_blocks row (upsert on (walkthroughId, phase,
// stepIndex)).
// Advances: last_completed_phase → 'B' (first step only).

function blockVariantCount(input: AddDiffStepInput): number {
  let n = 0;
  if (input.markdown != null) n++;
  if (input.code != null) n++;
  if (input.diff != null) n++;
  return n;
}

export const addDiffStepHandler: WalkthroughToolHandler<
  AddDiffStepInput
> = async (ctx, input) => {
  // Exactly one of {markdown, code, diff} must be provided.
  if (blockVariantCount(input) !== 1) {
    return errorResult(
      "Error: add_diff_step requires exactly one of { markdown, code, diff } — not zero, not two. Pick the shape that matches the step's intent.",
    );
  }

  let result: WalkthroughToolResult | null = null;
  let block: WalkthroughBlock | null = null;
  let isFirstStep = false;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
      result = errorResult(
        `Error: add_diff_step requires Phase A complete and Phase C not yet entered. Current phase: '${phase}'. Call set_overview first, or stop adding diff steps once sentiment has been set.`,
      );
      return;
    }

    const blockId = `block-${ctx.walkthroughId}-${input.step_index}`;
    const now = new Date().toISOString();

    if (input.markdown) {
      const md: MarkdownBlock = {
        type: "markdown",
        id: blockId,
        order: input.step_index,
        phase: "diff_analysis",
        stepIndex: input.step_index,
        content: input.markdown.content,
      };
      block = md;
      ctx.db
        .insert(walkthroughBlocks)
        .values({
          id: blockId,
          walkthroughId: ctx.walkthroughId,
          phase: "diff_analysis",
          stepIndex: input.step_index,
          order: input.step_index,
          type: "markdown",
          data: JSON.stringify(md),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [
            walkthroughBlocks.walkthroughId,
            walkthroughBlocks.phase,
            walkthroughBlocks.stepIndex,
          ],
          set: {
            type: "markdown",
            order: input.step_index,
            data: JSON.stringify(md),
          },
        })
        .run();
    } else if (input.code) {
      const code: CodeBlock = {
        type: "code",
        id: blockId,
        order: input.step_index,
        phase: "diff_analysis",
        stepIndex: input.step_index,
        filePath: input.code.file_path,
        startLine: input.code.start_line,
        endLine: input.code.end_line,
        language: input.code.language,
        content: input.code.content,
        annotation: input.code.annotation,
        annotationPosition: input.code.annotation_position,
      };
      block = code;
      ctx.db
        .insert(walkthroughBlocks)
        .values({
          id: blockId,
          walkthroughId: ctx.walkthroughId,
          phase: "diff_analysis",
          stepIndex: input.step_index,
          order: input.step_index,
          type: "code",
          data: JSON.stringify(code),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [
            walkthroughBlocks.walkthroughId,
            walkthroughBlocks.phase,
            walkthroughBlocks.stepIndex,
          ],
          set: {
            type: "code",
            order: input.step_index,
            data: JSON.stringify(code),
          },
        })
        .run();
    } else if (input.diff) {
      const diff: DiffBlock = {
        type: "diff",
        id: blockId,
        order: input.step_index,
        phase: "diff_analysis",
        stepIndex: input.step_index,
        filePath: input.diff.file_path,
        patch: input.diff.patch,
        annotation: input.diff.annotation,
        annotationPosition: input.diff.annotation_position,
      };
      block = diff;
      ctx.db
        .insert(walkthroughBlocks)
        .values({
          id: blockId,
          walkthroughId: ctx.walkthroughId,
          phase: "diff_analysis",
          stepIndex: input.step_index,
          order: input.step_index,
          type: "diff",
          data: JSON.stringify(diff),
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [
            walkthroughBlocks.walkthroughId,
            walkthroughBlocks.phase,
            walkthroughBlocks.stepIndex,
          ],
          set: {
            type: "diff",
            order: input.step_index,
            data: JSON.stringify(diff),
          },
        })
        .run();
    }

    if (phase === "A") {
      isFirstStep = true;
      ctx.db
        .update(walkthroughs)
        .set({ lastCompletedPhase: "B" })
        .where(eq(walkthroughs.id, ctx.walkthroughId))
        .run();
    }
  });
  if (result) return result;
  if (!block) {
    return errorResult(
      "Internal error: add_diff_step reached emit without a block variant.",
    );
  }

  ctx.emit({ type: "block", data: block });
  if (isFirstStep) {
    ctx.emit({
      type: "phase:advanced",
      data: { lastCompletedPhase: "B" },
    });
  }
  return okResult(
    `Diff step ${input.step_index} persisted. Continue with more steps, or call set_sentiment when Phase B is done.`,
  );
};

// ── Handler: flag_issue (during Phase B) ─────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'A', 'B'} (issues must link to
// already-persisted diff steps).
// Writes: one walkthrough_issues row (upsert on deterministic id).
// Does not advance phase.

export const flagIssueHandler: WalkthroughToolHandler<FlagIssueInput> = async (
  ctx,
  input,
) => {
  const issueId = await computeIssueId(
    ctx.walkthroughId,
    input.title,
    input.file_path ?? null,
    input.start_line ?? null,
  );

  let result: WalkthroughToolResult | null = null;
  let issueEvent: WalkthroughIssue | null = null;
  ctx.db.transaction(() => {
    const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
    if (!row) {
      result = errorResult(`Walkthrough ${ctx.walkthroughId} not found.`);
      return;
    }
    const phase = row.lastCompletedPhase as WalkthroughPipelinePhase;
    if (!phaseAtLeast(phase, "A") || !phaseAtMost(phase, "B")) {
      result = errorResult(
        `Error: flag_issue is only valid during Phase A/B. Current phase: '${phase}'.`,
      );
      return;
    }

    // Validate all referenced block_orders point at persisted diff steps.
    const stepRows = ctx.db
      .select({ stepIndex: walkthroughBlocks.stepIndex })
      .from(walkthroughBlocks)
      .where(
        and(
          eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
          eq(walkthroughBlocks.phase, "diff_analysis"),
        ),
      )
      .all();
    const knownSteps = new Set(
      stepRows.map((r) => r.stepIndex).filter((n): n is number => n !== null),
    );
    const unknown = input.block_orders.filter((o) => !knownSteps.has(o));
    if (unknown.length > 0) {
      result = errorResult(
        `Error: block_orders [${unknown.join(", ")}] reference diff steps that don't exist yet. Call add_diff_step for each before flag_issue.`,
      );
      return;
    }

    const uniqueOrders = Array.from(new Set(input.block_orders));
    const blockIds = uniqueOrders.map((o) => `block-${ctx.walkthroughId}-${o}`);

    // Issue `order` is the post-row insertion order within this walkthrough —
    // compute it inside the transaction so concurrent writes (which can't
    // happen today, but defended anyway) don't collide.
    const existing = ctx.db
      .select({ id: walkthroughIssues.id, order: walkthroughIssues.order })
      .from(walkthroughIssues)
      .where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
      .all();
    const order =
      existing.find((e) => e.id === issueId)?.order ?? existing.length;

    const now = new Date().toISOString();
    ctx.db
      .insert(walkthroughIssues)
      .values({
        id: issueId,
        walkthroughId: ctx.walkthroughId,
        order,
        severity: input.severity,
        title: input.title,
        description: input.description,
        filePath: input.file_path ?? null,
        startLine: input.start_line ?? null,
        endLine: input.end_line ?? null,
        blockIds: JSON.stringify(blockIds),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: walkthroughIssues.id,
        set: {
          severity: input.severity,
          title: input.title,
          description: input.description,
          filePath: input.file_path ?? null,
          startLine: input.start_line ?? null,
          endLine: input.end_line ?? null,
          blockIds: JSON.stringify(blockIds),
        },
      })
      .run();

    const issue: WalkthroughIssue = {
      id: issueId,
      severity: input.severity,
      title: input.title,
      description: input.description,
      blockIds,
      ...(input.file_path !== null ? { filePath: input.file_path } : {}),
      ...(input.start_line !== null ? { startLine: input.start_line } : {}),
      ...(input.end_line !== null ? { endLine: input.end_line } : {}),
    };
    issueEvent = issue;
  });
  if (result) return result;
  if (issueEvent) {
    ctx.emit({ type: "issue", data: issueEvent });
  }
  return okResult(
    `Issue flagged: [${input.severity}] ${input.title} (id: ${issueId}).`,
  );
};

// ── Handler: set_sentiment (Phase C) ─────────────────────────────────────────
//
// Phase precondition: last_completed_phase === 'B' (and thus at least one
// diff step persisted — Phase B can't be entered without one).
// Writes: walkthroughs.sentiment.
// Advances: last_completed_phase → 'C'.

export const setSentimentHandler: WalkthroughToolHandler<
  SetSentimentInput
> = async (ctx, input) => {
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
      .set({ sentiment: input.markdown, lastCompletedPhase: "C" })
      .where(eq(walkthroughs.id, ctx.walkthroughId))
      .run();
  });
  if (result) return result;

  ctx.emit({ type: "sentiment", data: { sentiment: input.markdown } });
  ctx.emit({
    type: "phase:advanced",
    data: { lastCompletedPhase: "C" },
  });
  return okResult(
    "Sentiment set. Phase C complete — now rate each of the 9 axes with rate_axis.",
  );
};

// ── Handler: rate_axis (Phase D) ─────────────────────────────────────────────
//
// Phase precondition: last_completed_phase ∈ {'C', 'D'}.
// Writes: one walkthrough_ratings row (upsert on (walkthroughId, axis)).
// Advances: last_completed_phase → 'D' on the 9th distinct axis.

export const rateAxisHandler: WalkthroughToolHandler<RateAxisInput> = async (
  ctx,
  input,
) => {
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

    // Validate block_orders reference persisted diff steps if any given.
    if (input.block_orders.length > 0) {
      const stepRows = ctx.db
        .select({ stepIndex: walkthroughBlocks.stepIndex })
        .from(walkthroughBlocks)
        .where(
          and(
            eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
            eq(walkthroughBlocks.phase, "diff_analysis"),
          ),
        )
        .all();
      const knownSteps = new Set(
        stepRows.map((r) => r.stepIndex).filter((n): n is number => n !== null),
      );
      const unknown = input.block_orders.filter((o) => !knownSteps.has(o));
      if (unknown.length > 0) {
        result = errorResult(
          `Error: block_orders [${unknown.join(", ")}] reference diff steps that don't exist.`,
        );
        return;
      }
    }

    const uniqueOrders = Array.from(new Set(input.block_orders));
    const blockIds = uniqueOrders.map((o) => `block-${ctx.walkthroughId}-${o}`);
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
    if (
      ratedSet.size === RATING_AXES_SPEC.length &&
      row.lastCompletedPhase !== "D"
    ) {
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

export const completeWalkthroughHandler: WalkthroughToolHandler<
  CompleteWalkthroughInput
> = async (ctx) => {
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

  const stepCount = ctx.db
    .select({ id: walkthroughBlocks.id })
    .from(walkthroughBlocks)
    .where(
      and(
        eq(walkthroughBlocks.walkthroughId, ctx.walkthroughId),
        eq(walkthroughBlocks.phase, "diff_analysis"),
      ),
    )
    .all().length;
  if (stepCount === 0) {
    return errorResult(
      "Error: complete_walkthrough requires at least one diff step.",
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
      "Read-only. Call FIRST on every run, including resumes. Returns current phase, persisted diff steps, rated axes, and metadata so you can pick up exactly where the previous run stopped. Never calls this are silently tolerated but highly discouraged — you risk duplicating work.",
    inputSchema: getWalkthroughStateSchema,
    handler: getWalkthroughStateHandler,
  },
  {
    name: "set_overview",
    description:
      "Phase A. Call exactly once, before any other write tool. Sets the PR summary (2-3 sentences) and overall risk level (low/medium/high). Advances phase to A.",
    inputSchema: setOverviewSchema,
    handler: setOverviewHandler,
  },
  {
    name: "add_diff_step",
    description:
      "Phase B. Call ONCE PER STEP. Each call persists one narrative unit: markdown, a code excerpt, or a diff hunk (exactly one of the three). step_index is monotonic zero-based and required — retries with the same index are idempotent upserts. Advances phase to B on the first call.",
    inputSchema: addDiffStepSchema,
    handler: addDiffStepHandler,
  },
  {
    name: "flag_issue",
    description:
      "Phase B. Flag a structured concern (security, correctness, tests, perf, etc.). Must be called AFTER the diff step(s) that explain the concern, and must link to them via block_orders (= step_index values).",
    inputSchema: flagIssueSchema,
    handler: flagIssueHandler,
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
} from "./walkthrough-tool-spec";
