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
//   Phase 2 — Write the recap (single atomic call):
//     • set_recap_overview → overview markdown + provenance + summary stats
//
//   Phase 3 — Finalize:
//     • complete_recap → validation gate; orchestrator transitions status
//
// Per CLAUDE.md invariants #2 + #11: agents never write `status` directly.
// `complete_recap` only validates; the orchestrator observes the agent run's
// natural end and transitions `status` to `'complete'` then.

import type { ProjectRecap, RecapPeriod, RecapSummaryStats } from "@revv/shared";
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

export interface RecapSourcePr {
  readonly id: string;
  readonly externalId: number;
  readonly title: string;
  readonly authorLogin: string;
  readonly status: "closed" | "merged";
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
}

export interface RecapSourceBundle {
  readonly repoId: string;
  readonly repoFullName: string;
  readonly period: RecapPeriod;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly prs: ReadonlyArray<RecapSourcePr>;
  /** Pre-computed summary stats — same shape persisted on the recap row. */
  readonly stats: RecapSummaryStats;
}

// ── Tool input schemas ───────────────────────────────────────────────────────

export const getRecapStateSchema = z.object({});

export const getRepoContextSchema = z.object({
  /**
   * Optional period filter for the prior-recap lookup. Defaults to "any
   * period" (returns the most recent across daily and weekly).
   */
  period: z.enum(["daily", "weekly"]).nullable().optional(),
  /** Optional cap on returned rows. Defaults to 3. */
  limit: z.number().int().positive().max(10).nullable().optional(),
});

export const setRecapOverviewSchema = z.object({
  overview: z
    .string()
    .min(1)
    .describe(
      "GitHub-flavored markdown body of the recap. Cover: what shipped, by whom, themes / risk hotspots, and any signal worth carrying into next week's review work. Headings, bullet lists, and `inline code` are encouraged. Keep paragraphs tight — this is consumed by humans and by the walkthrough agent in subsequent runs.",
    ),
  source_pr_ids: z
    .array(z.string())
    .min(1)
    .describe(
      "Ids of the PRs included in this recap. Should match the PRs from get_recap_state — the orchestrator validates this against the source bundle. Use every PR; if you intentionally excluded any, that's fine, but be explicit in the overview.",
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
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type SetRecapOverviewInput = z.infer<typeof setRecapOverviewSchema>;
export type CompleteRecapInput = z.infer<typeof completeRecapSchema>;
