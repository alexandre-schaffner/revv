import { STACK_CITATION_FORMAT } from "@revv/shared";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { projectRecaps } from "../../../db/schema/project-recaps";
import { pullRequests } from "../../../db/schema/pull-requests";
import { walkthroughIssues } from "../../../db/schema/walkthrough-issues";
import { walkthroughs as walkthroughsTable } from "../../../db/schema/walkthroughs";
import { readCurrentHeadFiles } from "../../../services/DiffCache";
import { takeawayOf } from "../../../services/stacks/overlay";
import { readWalkthroughState } from "../../../services/walkthrough/agent-state";
import {
  decodePrCommits,
  finishedReview,
  loadWalkthroughRow,
} from "../../../services/walkthrough/content";
import { fail } from "../mcp-tool-gateway";
import type {
  GetCommitHistoryInput,
  GetRepoContextInput,
  GetStackContextInput,
  GetWalkthroughStateInput,
  WalkthroughToolHandler,
} from "./spec";

// The first call every agent run makes, including resumes (invariant 6).

export const getWalkthroughStateHandler: WalkthroughToolHandler<GetWalkthroughStateInput> = async (
  ctx,
) => {
  const state = readWalkthroughState(ctx.db, ctx.walkthroughId);
  if (!state) {
    return fail(
      `Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
    );
  }
  const { issuesNeedingInlineComment, leadsNeedingVerdict } = state;

  // Models skim past the lists inside the JSON; a plain-text prefix they
  // can't miss keeps a resume from walking back into the same
  // complete_walkthrough refusal.
  const stateJson = JSON.stringify(state);
  const warnings = [
    ...(issuesNeedingInlineComment.length > 0
      ? [
          `WARNING: ${issuesNeedingInlineComment.length} line-anchored concern(s) have no inline comment yet — call add_issue_comment for each before complete_walkthrough.`,
        ]
      : []),
    ...(leadsNeedingVerdict.length > 0 && state.lastCompletedPhase !== "none"
      ? [
          `WARNING: ${leadsNeedingVerdict.length} first-pass lead(s) have no verdict yet (${leadsNeedingVerdict.join(", ")}) — call resolve_lead for each before complete_walkthrough.`,
        ]
      : []),
  ];
  const text = warnings.length > 0 ? `${warnings.join("\n")}\n\n${stateJson}` : stateJson;

  return {
    content: [{ type: "text" as const, text }],
  };
};

// The commit list the orchestrator captured when it created the row. A tool rather than
// the prompt, so long PRs (GitHub returns up to 250 commits) don't pay for it
// on every run and resume. A legacy row's NULL `pr_commits` reads as an empty list.

export const getCommitHistoryHandler: WalkthroughToolHandler<GetCommitHistoryInput> = async (
  ctx,
) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return fail(
      `Walkthrough ${ctx.walkthroughId} not found. The orchestrator should have created it before the agent ran — check WalkthroughJobs.`,
    );
  }

  const commits = decodePrCommits(row.prCommits);

  if (row.mode === "author") {
    const payload = {
      walkthroughId: row.id,
      prHeadSha: row.prHeadSha,
      mode: row.mode,
      commitCount: commits.length,
      commits: [],
      instructions:
        "This walkthrough is in author self-review mode. Do not write a commit-history or journey chapter. Return to Phase B current-diff preflight review and open semantic_step_index 0 with the first substantive review area.",
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    };
  }

  const payload = {
    walkthroughId: row.id,
    prHeadSha: row.prHeadSha,
    mode: row.mode,
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
    return fail(
      `Walkthrough ${ctx.walkthroughId} not found — cannot resolve repo for context lookup.`,
    );
  }

  const prRow = ctx.db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, walkthroughRow.pullRequestId))
    .get();
  if (!prRow) {
    // PR vanished (deleted repo, FK cascade in flight); the agent can still
    // review without repo context.
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

const STACK_ISSUES_PER_LAYER = 8;
const STACK_BODY_EXCERPT_CHARS = 600;
const STACK_FILES_PER_LAYER = 60;

export const getStackContextHandler: WalkthroughToolHandler<GetStackContextInput> = async (ctx) => {
  const row = loadWalkthroughRow(ctx.db, ctx.walkthroughId);
  if (!row) {
    return fail(`Walkthrough ${ctx.walkthroughId} not found — cannot resolve its stack.`);
  }
  const stack = row.stackContext;
  const repo = ctx.db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, row.pullRequestId))
    .get();
  if (!stack || !repo) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            stack: null,
            instructions: "This PR is not part of a stack. Review it as a standalone pull request.",
          }),
        },
      ],
    };
  }

  const others = stack.layers.filter((l) => l.position !== stack.position);
  const prRows =
    others.length === 0
      ? []
      : ctx.db
          .select({
            id: pullRequests.id,
            externalId: pullRequests.externalId,
            title: pullRequests.title,
            body: pullRequests.body,
          })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repositoryId, repo.repositoryId),
              inArray(
                pullRequests.externalId,
                others.map((l) => l.number),
              ),
            ),
          )
          .all();
  const prByNumber = new Map(prRows.map((p) => [p.externalId, p]));

  const lowerLayers = others
    .filter((l) => l.position < stack.position)
    .sort((a, b) => a.position - b.position)
    .map((l) => {
      const pr = prByNumber.get(l.number);
      const base = { position: l.position, number: l.number, status: l.status };
      if (!pr) return { ...base, title: l.title, tracked: false, review: null };
      const reviewed = ctx.db
        .select({ id: walkthroughsTable.id, summary: walkthroughsTable.summary })
        .from(walkthroughsTable)
        .where(and(eq(walkthroughsTable.pullRequestId, pr.id), finishedReview()))
        .orderBy(desc(walkthroughsTable.generatedAt))
        .get();
      if (!reviewed) return { ...base, title: pr.title, tracked: true, review: null };
      const openIssues = ctx.db
        .select({ title: walkthroughIssues.title, severity: walkthroughIssues.severity })
        .from(walkthroughIssues)
        .where(
          and(
            eq(walkthroughIssues.walkthroughId, reviewed.id),
            eq(walkthroughIssues.resolutionStatus, "open"),
          ),
        )
        .orderBy(asc(walkthroughIssues.order))
        .all();
      return {
        ...base,
        title: pr.title,
        tracked: true,
        review: {
          takeaway: takeawayOf(reviewed.summary),
          openIssueCount: openIssues.length,
          openIssues: openIssues.slice(0, STACK_ISSUES_PER_LAYER),
        },
      };
    });

  const upperLayers = others
    .filter((l) => l.position > stack.position)
    .sort((a, b) => a.position - b.position)
    .map((l) => {
      const pr = prByNumber.get(l.number);
      const base = { position: l.position, number: l.number, status: l.status };
      if (!pr) return { ...base, title: l.title, tracked: false, files: null };
      const body = pr.body?.trim() ?? "";
      const files =
        readCurrentHeadFiles(ctx.db, [pr.id])
          .get(pr.id)
          ?.map((f) => f.path)
          .toSorted() ?? null;
      return {
        ...base,
        title: pr.title,
        tracked: true,
        bodyExcerpt:
          body.length > STACK_BODY_EXCERPT_CHARS
            ? `${body.slice(0, STACK_BODY_EXCERPT_CHARS)}…`
            : body,
        files: files?.slice(0, STACK_FILES_PER_LAYER) ?? null,
        fileCount: files?.length ?? null,
      };
    });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          stack,
          lowerLayers,
          upperLayers,
          instructions: `Your diff is this layer alone. Before flagging an absence, check the upper layers: if one plausibly adds it (its description or file list says so), it is not an issue here — mention it in a sentence if it helps the reader. Lower layers are context, already reviewed on their own; don't re-review them. Cite layers as \`${STACK_CITATION_FORMAT}\`. An upper layer with \`files: null\` hasn't been fetched by Revv yet.`,
        }),
      },
    ],
  };
};
