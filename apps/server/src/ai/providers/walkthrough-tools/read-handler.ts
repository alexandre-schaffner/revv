// ─── walkthrough-read-handler ────────────────────────────────────────────────
//
// Read-only MCP tool handler: get_walkthrough_state. The first call every
// agent run makes, including resumes.

import type {
  RatingAxis,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughPipelinePhase,
  WalkthroughState,
} from "@revv/shared";
import { and, asc, eq } from "drizzle-orm";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { errorResult, findIssuesMissingInlineComment, loadWalkthroughRow } from "./helpers";
import type { GetWalkthroughStateInput, WalkthroughToolHandler } from "./spec";

// ── Handler: get_walkthrough_state ───────────────────────────────────────────
//
// The first call every agent run makes, including resumes. Returns enough
// state for the agent to figure out where to pick up: which phase is
// complete, which diff steps exist, which axes have been rated.

export const getWalkthroughStateHandler: WalkthroughToolHandler<GetWalkthroughStateInput> = async (
  ctx,
) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return errorResult(
      `Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
    );
  }

  const semanticRows = ctx.db
    .select({
      semanticStepIndex: walkthroughSemanticSteps.semanticStepIndex,
      title: walkthroughSemanticSteps.title,
      summary: walkthroughSemanticSteps.summary,
    })
    .from(walkthroughSemanticSteps)
    .where(eq(walkthroughSemanticSteps.walkthroughId, ctx.walkthroughId))
    .orderBy(asc(walkthroughSemanticSteps.semanticStepIndex))
    .all();

  const diffBlocks = ctx.db
    .select({
      semanticStepIndex: walkthroughBlocks.semanticStepIndex,
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

  const issueRows = ctx.db
    .select({
      id: walkthroughIssues.id,
      order: walkthroughIssues.order,
      title: walkthroughIssues.title,
      filePath: walkthroughIssues.filePath,
      startLine: walkthroughIssues.startLine,
      endLine: walkthroughIssues.endLine,
    })
    .from(walkthroughIssues)
    .where(eq(walkthroughIssues.walkthroughId, ctx.walkthroughId))
    .all();

  const diffSteps = diffBlocks
    .slice()
    .sort((a, b) => a.semanticStepIndex - b.semanticStepIndex || a.stepIndex - b.stepIndex)
    .map((b) => ({
      semanticStepIndex: b.semanticStepIndex,
      stepIndex: b.stepIndex,
      blockType: b.type as WalkthroughBlock["type"],
    }));

  const stepIndicesBySection = new Map<number, number[]>();
  for (const b of diffBlocks) {
    const arr = stepIndicesBySection.get(b.semanticStepIndex) ?? [];
    arr.push(b.stepIndex);
    stepIndicesBySection.set(b.semanticStepIndex, arr);
  }
  const semanticSteps = semanticRows.map((s) => ({
    semanticStepIndex: s.semanticStepIndex,
    title: s.title,
    summary: s.summary ?? null,
    stepIndices: (stepIndicesBySection.get(s.semanticStepIndex) ?? [])
      .slice()
      .sort((a, b) => a - b),
  }));

  const issues = issueRows
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((r) => ({
      id: r.id,
      title: r.title,
      filePath: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
    }));

  // Surface unfinished comment-pairing work so resumes (and any agent that
  // is reasoning about whether it can call `complete_walkthrough` yet)
  // don't have to deduce it from the issues list. This is the same query
  // the orchestrator and `complete_walkthrough` use — single source of
  // truth (see findIssuesMissingInlineComment).
  const issuesNeedingInlineComment = findIssuesMissingInlineComment(ctx.db, ctx.walkthroughId);

  const state: WalkthroughState = {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    status: row.status as WalkthroughState["status"],
    lastCompletedPhase: row.lastCompletedPhase as WalkthroughPipelinePhase,
    summary: row.summary || null,
    riskLevel: row.summary ? (row.riskLevel as RiskLevel) : null,
    sentiment: row.sentiment ?? null,
    semanticSteps,
    diffSteps,
    ratedAxes: ratingRows.map((r) => r.axis as RatingAxis),
    issues,
    issueCount: issues.length,
    issuesNeedingInlineComment,
  };

  // Loud, plain-text banner when the agent has unfinished comment work.
  // The JSON state still contains the full list, but the prefix makes it
  // impossible for the model to skim past — especially on resume, where
  // missing this would lead straight back to the same complete_walkthrough
  // validation failure.
  const stateJson = JSON.stringify(state);
  const text =
    issuesNeedingInlineComment.length > 0
      ? `WARNING: ${issuesNeedingInlineComment.length} line-anchored issue(s) at severity 'warning' or 'critical' have no inline comment yet — call add_issue_comment for each before complete_walkthrough.\n\n${stateJson}`
      : stateJson;

  return {
    content: [{ type: "text" as const, text }],
  };
};
