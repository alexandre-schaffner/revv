// ─── recap-tools/spec ────────────────────────────────────────────────────────
//
// MCP tool surface for project-recap generation. Replaces the prior
// text-buffer / single-blob pipeline with a structured pipeline:
//
//   Phase 1 — Read source data:
//     • get_recap_state  → period boundaries, source PR + walkthrough roll-up
//     • list_open_prs    → open PRs with diffDigest, written as active-work
//                          entries inside theme chapters alongside shipped work
//     • get_repo_context → prior recaps for rolling continuity
//
//   Phase 2 — Write the lede (one atomic call):
//     • set_lede(text) → 1–3 sentences, `<strong>`/`<em>` only.
//
//   Phase 3 — Write per-PR entries (one atomic idempotent call per PR):
//     • add_pr_entry(prId, position, theme, verb, description,
//                    linesAdded, linesRemoved)
//       Upsert on `(recap_id, pr_id)`; replay-safe.
//
//   Phase 4 — Finalize:
//     • complete_recap → validation gate. Requires non-empty lede + ≥1 entry.
//       Also stamps `summary_stats` from the source bundle and derives
//       `source_pr_ids` / `source_walkthrough_ids` from the entries.
//
// Per CLAUDE.md invariants #2 + #11: agents never write `status` directly.
// `complete_recap` only validates; the orchestrator observes the run's natural
// end and flips `status` to `'complete'` after.

import type { ProjectRecap, RecapPeriod, RecapStreamEvent, RecapSummaryStats } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";
import type { ToolSpec as GatewayToolSpec, McpToolResult } from "../mcp-tool-gateway";

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
   * Lazy diff loader called by the `get_pr_diff` MCP handler. The
   * orchestrator wires this to `loadDiffForPr` at job-start time.
   * Returns null when the prId is not in the source bundle or when
   * both diff cache and GitHub are unavailable.
   */
  readonly getPrDiff: (prId: string) => Promise<RecapSourcePrDiff | null>;
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
   * Tool names that actually reached a handler during this run. Used by the
   * runner for narrow recovery (e.g., the agent set the lede + entries but
   * never called `complete_recap`). Ephemeral, reconstructible state.
   */
  readonly toolCalls?: Set<string>;
}

export interface RecapToolResult extends McpToolResult {
  [k: string]: unknown;
}

export type RecapToolHandler<TInput> = (
  ctx: RecapToolContext,
  input: TInput,
) => Promise<RecapToolResult>;

export type RecapToolSpecRecord = GatewayToolSpec<RecapToolContext, RecapToolResult>;

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

export interface RecapSourcePrDigest {
  readonly source: "cache" | "github" | "unavailable";
  readonly digest: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    readonly patchAvailable: boolean;
    readonly patchTruncated: boolean;
  }>;
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
  /** Compact pre-ingested diff context for PRs without walkthroughs. */
  readonly diffDigest: RecapSourcePrDigest | null;
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

export const setLedeSchema = z.object({
  lede: z
    .string()
    .min(1)
    .describe(
      "Short editorial lede for this recap — 1 to 3 sentences naming the dominant theme of the period and any standout work. Plain text plus optional inline `<strong>` (for the headline phrase) and `<em>` (for technical names) tags. NO markdown headers, lists, links, code spans, or emoji. Everything outside the `<strong>` / `<em>` allowlist is stripped at render. Write at most ~50 words.",
    ),
});

export const addPrEntrySchema = z.object({
  pr_id: z
    .string()
    .describe(
      "The `id` of a PR returned by `get_recap_state.prs` (archived) or `list_open_prs` (active). Upserts on `(recap_id, pr_id)` — calling again with the same `pr_id` overwrites in place.",
    ),
  position: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Render order within the recap. Lower = earlier. Position is global across the whole recap, not per-theme; the UI groups by theme but preserves your relative order within each group.",
    ),
  theme: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "Short lowercase theme label grouping this PR with related work. Pick a SHARP, REUSABLE noun (e.g. `auth`, `payments`, `db`, `frontend`, `infra`, `agents`) — avoid one-off themes per PR. Reuse the same theme across PRs that touch the same area. The UI groups chapters by theme and orders them by count desc.",
    ),
  verb: z
    .string()
    .min(1)
    .max(24)
    .describe(
      "Past-tense verb describing what landed: `shipped`, `fixed`, `refactored`, `removed`, `added`, `extended`, `tightened`, etc. Single word preferred; short phrases OK.",
    ),
  description: z
    .string()
    .min(1)
    .describe(
      "One-sentence description of what the PR does. Plain prose, may include backtick-wrapped code spans for identifiers / file paths (rendered as `.codechip` chips in the UI). No other markdown. Aim for ≤ 25 words.",
    ),
  lines_added: z
    .number()
    .int()
    .nonnegative()
    .describe("Additions for this PR — copy the value from `get_recap_state.prs[].additions`."),
  lines_removed: z
    .number()
    .int()
    .nonnegative()
    .describe("Deletions for this PR — copy the value from `get_recap_state.prs[].deletions`."),
});

export const setThemeSummarySchema = z.object({
  theme: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "Theme label this summary belongs to. MUST exactly match a `theme` you already passed to `add_pr_entry` (same lowercase noun). The server normalizes (lowercase + trim + collapse whitespace) before keying, so casing differences are tolerated — but the underlying word must match.",
    ),
  summary: z
    .string()
    .min(1)
    .describe(
      "One- or two-sentence editorial summary of what landed in this theme. Plain prose. May include backtick-wrapped code spans for identifiers / file paths (rendered as small inline chips). NO other markdown — no bold, no links, no headers, no lists. ≤ ~35 words. The UI renders this as a small lede paragraph below the chapter heading and above the PR rows.",
    ),
});

export const completeRecapSchema = z.object({});

export const getPrDiffSchema = z.object({
  pr_id: z
    .string()
    .describe(
      "The `id` of the PR to fetch the diff for, as returned in the `prs` array by get_recap_state. Use this for archived PRs where `walkthrough` is null to get per-file status, +/- counts, and unified patch text before composing the recap.",
    ),
});

// ── Type exports ─────────────────────────────────────────────────────────────

export type GetRecapStateInput = z.infer<typeof getRecapStateSchema>;
export type ListOpenPrsInput = z.infer<typeof listOpenPrsSchema>;
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type SetLedeInput = z.infer<typeof setLedeSchema>;
export type AddPrEntryInput = z.infer<typeof addPrEntrySchema>;
export type SetThemeSummaryInput = z.infer<typeof setThemeSummarySchema>;
export type CompleteRecapInput = z.infer<typeof completeRecapSchema>;
export type GetPrDiffInput = z.infer<typeof getPrDiffSchema>;
