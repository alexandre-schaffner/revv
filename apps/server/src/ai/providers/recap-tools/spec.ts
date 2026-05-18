// ─── recap-tools/spec ────────────────────────────────────────────────────────
//
// MCP tool surface for project-recap generation. Mirrors the structure of
// `walkthrough-tools/spec.ts` but with a much smaller surface — single-phase
// pipeline (see /Users/alex/.claude/plans/let-s-review-the-archive-logical-eagle.md):
//
//   Phase 1 — Read source data:
//     • get_recap_state  → period boundaries, source PR + walkthrough roll-up
//     • get_repo_context → prior recaps for this repo (rolling context)
//
//   Phase 2 — Compose the recap as visible assistant text:
//     • Agent writes the markdown body as its assistant response. The
//       orchestrator's stream consumer fans every text-delta out as a
//       `chunk` SSE event AND appends to `ctx.textBuffer.current`.
//
//   Phase 3 — Commit (single atomic call):
//     • commit_recap_overview → reads `ctx.textBuffer.current` for the
//       markdown body, persists with provenance + stats. No `overview`
//       arg — the model only emits the markdown once (as text).
//
//   Phase 4 — Finalize:
//     • complete_recap → validation gate; orchestrator transitions status
//
// Per CLAUDE.md invariants #2 + #11: agents never write `status` directly.
// `complete_recap` only validates; the orchestrator observes the agent run's
// natural end and transitions `status` to `'complete'` then.

import type { ProjectRecap, RecapPeriod, RecapStreamEvent, RecapSummaryStats } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";

// ── Handler execution context ────────────────────────────────────────────────

/**
 * Per-call binding given to every recap MCP handler. Built by the transport
 * layer (Claude SDK adapter in `index.ts`, HTTP-MCP route in the future).
 */
export interface RecapToolContext {
  /** Direct DB handle. */
  readonly db: Db;
  /** The recap row this call mutates / reads. */
  readonly recapId: string;
  /**
   * Source bundle the agent reads via `get_recap_state`. Computed once at
   * job start by the orchestrator and threaded through here so the read
   * tool doesn't re-query the archive for every agent turn.
   */
  readonly sourceBundle: RecapSourceBundle;
  /**
   * Prior recaps for the same repo (typically 1 daily + 1 weekly). Used by
   * `get_repo_context` to give the agent rolling continuity.
   */
  readonly priorRecaps: ReadonlyArray<ProjectRecap>;
  /**
   * Hook fired the moment the agent calls `complete_recap` and validation
   * passes. The orchestrator subscribes here so it knows the agent
   * reached the validation gate cleanly — distinct from the agent's
   * natural stream end (which may happen on errors / cancellation too).
   */
  readonly onCompleted: () => void;
  /**
   * Stream emitter for live recap generation. Called by handlers that
   * produce content so the SSE endpoint can forward it to subscribers.
   */
  readonly emit: (event: RecapStreamEvent) => void;
  /**
   * Mutable closure cell holding the agent's currently-buffered visible
   * assistant text. The orchestrator's stream consumer (Claude SDK walker
   * or opencode SSE subscriber) appends every `text-delta` event to
   * `.current` and resets it on each non-commit tool-call boundary.
   * `commit_recap_overview`'s handler reads `.current` to obtain the
   * markdown body — the model never re-serialises it as a tool argument.
   *
   * Reconstructible cache (CLAUDE.md invariant #1): on `kill -9` the
   * buffer is lost; the orchestrator's resume path re-runs the agent
   * from scratch and a fresh buffer accumulates.
   */
  readonly textBuffer: { current: string };
}

export interface RecapToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

export type RecapToolHandler<TInput> = (
  ctx: RecapToolContext,
  input: TInput,
) => Promise<RecapToolResult>;

export interface RecapToolSpec<TShape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<TShape>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: RecapToolHandler<any>;
}

// ── Source bundle: the structured input the agent sees ───────────────────────

/**
 * One file from a PR's diff, surfaced to the recap agent for PRs that have no
 * walkthrough. Mirrors the shape stored in `pr_diff_files` (see
 * `DiffCacheService`) but with patch text optionally truncated to keep the
 * agent's context bounded.
 */
export interface RecapSourcePrDiffFile {
  readonly path: string;
  readonly oldPath: string | null;
  /** GitHub raw: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'unchanged'. */
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** Unified-diff patch text. Null when GitHub omitted it (binary / too large). */
  readonly patch: string | null;
  /** True when the patch was clipped server-side to fit the per-file char budget. */
  readonly patchTruncated: boolean;
}

/**
 * Compact diff payload threaded to the recap agent for PRs without
 * walkthroughs. Bounded by the orchestrator so a 1000-file PR doesn't blow
 * up the agent's context — see `loadDiffForRecap` in `ProjectRecapJobs`.
 */
export interface RecapSourcePrDiff {
  readonly files: ReadonlyArray<RecapSourcePrDiffFile>;
  /** Total files in the original PR diff (before any per-recap truncation). */
  readonly totalFiles: number;
  /** True when some files were dropped server-side to fit the bundle. */
  readonly filesTruncated: boolean;
  /**
   * Where the bytes came from. 'cache' = served from `pr_diff_files`;
   * 'github' = fetched live during recap assembly; 'unavailable' = no token
   * or fetch failed and nothing was cached.
   */
  readonly source: "cache" | "github" | "unavailable";
  /** Optional human-readable hint about truncation / missing data for the agent. */
  readonly note: string | null;
}

export interface RecapSourcePr {
  readonly id: string;
  readonly externalId: number;
  readonly title: string;
  readonly authorLogin: string;
  readonly status: "closed" | "merged" | "open";
  readonly closedAt: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly url: string;
  /**
   * Body of the PR description, truncated if very long. Null if GitHub
   * never had one or it was empty.
   */
  readonly body: string | null;
  /**
   * The PR's latest non-superseded complete walkthrough, if any. Null when
   * no human ever generated a walkthrough or all of them are
   * superseded/error/generating. Recap agent should still include the PR
   * in the narrative — just without walkthrough-derived insight.
   */
  readonly walkthrough: {
    readonly id: string;
    readonly summary: string;
    readonly sentiment: string | null;
    readonly riskLevel: "low" | "medium" | "high";
    readonly completedAt: string | null;
  } | null;
  /**
   * Fallback diff data loaded by the orchestrator when `walkthrough` is null.
   * Lets the agent read the actual code change instead of guessing from
   * title + +/- counts. Null when a walkthrough exists (we trust the
   * walkthrough's summary), or when both the diff cache and GitHub failed
   * to produce anything for the PR.
   */
  readonly diff: RecapSourcePrDiff | null;
}

export interface RecapSourceBundle {
  readonly repoId: string;
  readonly repoFullName: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Archived (closed/merged) PRs in the period window. */
  readonly prs: ReadonlyArray<RecapSourcePr>;
  /** Currently open PRs with walkthrough context, sorted by relevancy. */
  readonly openPrs: ReadonlyArray<RecapSourcePr>;
  /** Pre-computed summary stats — same shape persisted on the recap row. */
  readonly stats: RecapSummaryStats;
  /**
   * Markdown overview of the prior recap row for this exact (repo, period,
   * periodStart) tuple. Populated when the orchestrator is rerunning an
   * existing row in place (max-1-recap-per-period rule). `null` on a fresh
   * first-time run for the period. The agent should use this as the
   * starting point and update it with new information rather than starting
   * from scratch.
   */
  readonly previousOverview: string | null;
}

// ── Tool input schemas ───────────────────────────────────────────────────────

export const getRecapStateSchema = z.object({});

export const listOpenPrsSchema = z.object({
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Zero-based offset into the open-PR list. Defaults to 0. Use the `nextOffset` returned by the previous call to walk through pages — when it's null, you've reached the end.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe(
      "Maximum number of open PRs to return in this page. Defaults to 5 and is hard-capped at 20 to keep each tool response small. Stick with the default unless you have a reason to read more at once.",
    ),
});

export const getRepoContextSchema = z.object({
  /**
   * Optional period filter for the prior-recap lookup. Defaults to "any
   * period" (returns the most recent across daily and weekly).
   */
  period: z.enum(["daily", "weekly"]).nullable().optional(),
  /** Optional cap on returned rows. Defaults to 3. */
  limit: z.number().int().positive().max(10).nullable().optional(),
});

export const commitRecapOverviewSchema = z.object({
  source_pr_ids: z
    .array(z.string())
    .min(1)
    .describe(
      "Ids of the PRs included in this recap. Must be ids returned by get_recap_state — archived (`prs`) or open (`openPrs`) are both valid. The orchestrator validates against the full bundle. When nothing shipped this period, reference the open PRs you wrote about in 'Active work'.",
    ),
  source_walkthrough_ids: z
    .array(z.string())
    .describe(
      "Ids of the walkthroughs you incorporated. May be empty when none of the PRs had walkthroughs. Must be a subset of the walkthroughs in get_recap_state.",
    ),
  stats: z
    .object({
      pr_count: z.number().int().nonnegative(),
      merged_count: z.number().int().nonnegative(),
      closed_count: z.number().int().nonnegative(),
      author_count: z.number().int().nonnegative(),
      risk_low: z.number().int().nonnegative(),
      risk_medium: z.number().int().nonnegative(),
      risk_high: z.number().int().nonnegative(),
      walkthroughs_missing_count: z.number().int().nonnegative(),
    })
    .describe(
      "Pre-aggregated counts you computed from the source bundle. Used by the UI for at-a-glance rendering — match the numbers in get_recap_state so the UI and the markdown agree.",
    ),
});

export const completeRecapSchema = z.object({});

// ── Type exports ─────────────────────────────────────────────────────────────

export type GetRecapStateInput = z.infer<typeof getRecapStateSchema>;
export type ListOpenPrsInput = z.infer<typeof listOpenPrsSchema>;
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type CommitRecapOverviewInput = z.infer<typeof commitRecapOverviewSchema>;
export type CompleteRecapInput = z.infer<typeof completeRecapSchema>;
