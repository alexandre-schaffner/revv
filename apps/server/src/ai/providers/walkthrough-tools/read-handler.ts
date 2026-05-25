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
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { projectRecaps } from "../../../db/schema/project-recaps";
import { pullRequests } from "../../../db/schema/pull-requests";
import { walkthroughBlocks } from "../../../db/schema/walkthrough-blocks";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughRatings } from "../../../db/schema/walkthrough-ratings";
import { walkthroughSemanticSteps } from "../../../db/schema/walkthrough-semantic-steps";
import { errorResult, findIssuesMissingInlineComment, loadWalkthroughRow } from "./helpers";
import type {
  GetCommitHistoryInput,
  GetRepoContextInput,
  GetWalkthroughStateInput,
  WalkthroughToolHandler,
} from "./spec";

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

// ── Handler: get_commit_history ──────────────────────────────────────────────
//
// Read-only. Returns the PR commit list captured at job start (orchestrator
// writes `walkthroughs.pr_commits` as JSON inside `createPartial`).
//
// The agent calls this once before opening the required journey chapter at
// `semantic_step_index: 0`. Surfacing commits via a tool — rather than the
// user prompt — keeps the prompt token-bounded on long-running PRs (cap is
// 300 commits ≈ 4.5K tokens otherwise paid on every run + every resume).
//
// Returns commits in oldest → newest order (already stored that way by the
// orchestrator). A NULL `pr_commits` column (legacy row, or pre-migration)
// surfaces as an empty array — the agent's single-commit edge-case path
// then writes a one-paragraph journey chapter and moves on.

interface PrCommitJson {
  readonly sha: string;
  readonly message: string;
  readonly authorLogin: string | null;
  readonly authorAvatarUrl: string | null;
  readonly date: string | null;
}

function isPrCommitJson(v: unknown): v is PrCommitJson {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.sha === "string" &&
    typeof o.message === "string" &&
    (o.authorLogin === null || typeof o.authorLogin === "string") &&
    (o.authorAvatarUrl === null || typeof o.authorAvatarUrl === "string") &&
    (o.date === null || typeof o.date === "string")
  );
}

export const getCommitHistoryHandler: WalkthroughToolHandler<GetCommitHistoryInput> = async (
  ctx,
) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return errorResult(
      `Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
    );
  }

  let commits: PrCommitJson[] = [];
  if (row.prCommits) {
    try {
      const parsed: unknown = JSON.parse(row.prCommits);
      if (Array.isArray(parsed)) {
        commits = parsed.filter(isPrCommitJson);
      }
    } catch {
      // Corrupt JSON — surface as empty so the agent doesn't crash; the
      // single-commit fallback path handles the rendering.
    }
  }

  // Return as a structured JSON payload. The agent reads commits in
  // oldest → newest order and writes the journey chapter from it; the
  // narrative shape is governed by the system prompt, not this tool.
  const payload = {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    commitCount: commits.length,
    commits,
    instructions:
      commits.length === 0
        ? "No commit history persisted for this walkthrough. Open chapter 0 with a single markdown block explaining 'Single commit — no journey to trace' (or 'Commit history unavailable' if the row is legacy), then move on to chapter 1."
        : commits.length === 1
          ? "Single commit. Open chapter 0 with a one-paragraph markdown block stating that there's no journey to narrate, then move on."
          : `${commits.length} commits, oldest → newest. Open chapter 0 (semantic_step_index: 0) with a journey narrative — the narrative, course corrections, abandoned tracks — NOT a commit-by-commit log. See the system prompt's 'How we got here' section.`,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
};

// ── Handler: get_repo_context ────────────────────────────────────────────────
//
// Read-only. Returns the most-recent complete project recaps for the
// repository this walkthrough belongs to. Used by the walkthrough agent in
// Phase A to ground its summary in recent repo context — what shipped, what
// themes recur, what risk patterns to watch for.
//
// We resolve the repoId by walking walkthrough → pull_request → repository.
// No round-trip through services — this handler runs in the tool's
// transaction-free read path, just like get_commit_history.

interface RecapForAgent {
  readonly id: string;
  readonly period: "daily" | "weekly";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly completedAt: string | null;
  /** Short editorial lede from the structured recap (1–3 sentences). */
  readonly lede: string;
  readonly summaryStats: unknown;
}

export const getRepoContextHandler: WalkthroughToolHandler<GetRepoContextInput> = async (
  ctx,
  input,
) => {
  const walkthroughRow = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!walkthroughRow) {
    return errorResult(
      `Walkthrough ${ctx.walkthroughId} not found — cannot resolve repo for context lookup.`,
    );
  }

  // walkthrough.pullRequestId → pullRequests.repositoryId
  const prRow = ctx.db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, walkthroughRow.pullRequestId))
    .get();
  if (!prRow) {
    // PR vanished (deleted repo, foreign-key cascade in flight). Return
    // empty context rather than failing — the agent can still produce a
    // walkthrough.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            priorRecaps: [],
            instructions: "PR row not found — proceed without repo context.",
          }),
        },
      ],
    };
  }

  const conditions = [
    eq(projectRecaps.repositoryId, prRow.repositoryId),
    eq(projectRecaps.status, "complete"),
    isNull(projectRecaps.supersededBy),
  ];
  if (input.period !== null && input.period !== undefined) {
    conditions.push(eq(projectRecaps.period, input.period));
  }

  const rawLimit = input.limit ?? 3;
  const limit = Math.min(Math.max(1, rawLimit), 10);

  const rows = ctx.db
    .select({
      id: projectRecaps.id,
      period: projectRecaps.period,
      periodStart: projectRecaps.periodStart,
      periodEnd: projectRecaps.periodEnd,
      completedAt: projectRecaps.completedAt,
      lede: projectRecaps.lede,
      summaryStats: projectRecaps.summaryStats,
    })
    .from(projectRecaps)
    .where(and(...conditions))
    .orderBy(desc(projectRecaps.completedAt))
    .limit(limit)
    .all();

  const priorRecaps: RecapForAgent[] = rows.map((r) => {
    let stats: unknown = {};
    try {
      stats = JSON.parse(r.summaryStats);
    } catch {
      stats = {};
    }
    return {
      id: r.id,
      period: r.period as "daily" | "weekly",
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      completedAt: r.completedAt ?? null,
      lede: r.lede,
      summaryStats: stats,
    };
  });

  const instructions =
    priorRecaps.length === 0
      ? "No prior project recaps for this repo. Proceed using only the PR's own diff and commit history."
      : "Use these recaps to ground your overview — what's recently shipped, which themes recur in this repo, and what risk patterns reviewers have flagged. Cite them only when directly relevant; don't pad. Specifically: a 'pass' note in a prior recap doesn't mean your PR is safe; a recurring 'concern' on the same axis might be worth surfacing in the new walkthrough.";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ priorRecaps, instructions }),
      },
    ],
  };
};
