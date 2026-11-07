// Agents never write `status` (CLAUDE.md invariants 2 and 11): `complete_recap`
// only validates, and the orchestrator marks the recap complete after the run.

import type { ProjectRecap, RecapStreamEvent } from "@revv/shared";
import type { Effect } from "effect";
import { z } from "zod";
import type { Db } from "../../../db";
import type { RecapSourceBundle } from "../../../db/schema/project-recaps";
import type { McpToolResult } from "../mcp-tool-gateway";

export interface RecapToolContext {
  readonly db: Db;
  readonly recapId: string;
  /** Computed once at job start, so `get_recap_state` doesn't re-query the archive every turn. */
  readonly sourceBundle: RecapSourceBundle;
  readonly priorRecaps: ReadonlyArray<ProjectRecap>;
  /** Null when the PR isn't in the source bundle, or neither the diff cache nor GitHub has it. */
  readonly getPrDiff: (prId: string) => Effect.Effect<RecapSourcePrDiff | null>;
  /**
   * Fired when `complete_recap` passes validation — unlike the stream ending,
   * which also happens on errors and cancellation.
   */
  readonly onCompleted: () => void;
  readonly emit: (event: RecapStreamEvent) => void;
  /** A tool call reached the route, before its handler runs. */
  readonly onToolCall: (toolName: string) => void;
}

export type RecapToolResult = McpToolResult;

export type RecapToolHandler<TInput> = (
  ctx: RecapToolContext,
  input: TInput,
) => Promise<RecapToolResult>;

/**
 * A `pr_diff_files` row with its patch clipped to a per-file budget, for PRs
 * with no walkthrough.
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
  readonly patchTruncated: boolean;
}

/**
 * Bounded so a 1000-file PR can't blow up the agent's context; see
 * `loadDiffForPr` in `ProjectRecapJobs`.
 */
export interface RecapSourcePrDiff {
  readonly files: ReadonlyArray<RecapSourcePrDiffFile>;
  /** Total files in the original PR diff (before any per-recap truncation). */
  readonly totalFiles: number;
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

export const getRecapStateSchema = z.object({});

/** The bundle holds at most the 20 most recently updated open PRs. */
export const OPEN_PRS_MAX_PAGE_SIZE = 20;

export const listOpenPrsSchema = z.object({
  offset: z.coerce
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Zero-based offset into the open-PR list. Defaults to 0. Use the `nextOffset` returned by the previous call to walk through pages — when it's null, you've reached the end.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(OPEN_PRS_MAX_PAGE_SIZE)
    .optional()
    .describe(
      "Maximum number of open PRs to return in this page. Defaults to 5 and is hard-capped at 20 to keep each tool response small. Stick with the default unless you have a reason to read more at once.",
    ),
});

export const getRepoContextSchema = z.object({
  period: z.enum(["daily", "weekly"]).nullable().optional(),
  limit: z.coerce.number().int().positive().max(10).nullable().optional(),
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
  position: z.coerce
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
  lines_added: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Additions for this PR — copy the value from `get_recap_state.prs[].additions`."),
  lines_removed: z.coerce
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
    .describe("The `id` of the PR, as returned in the `prs` array by get_recap_state."),
});

export type GetRecapStateInput = z.infer<typeof getRecapStateSchema>;
export type ListOpenPrsInput = z.infer<typeof listOpenPrsSchema>;
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type SetLedeInput = z.infer<typeof setLedeSchema>;
export type AddPrEntryInput = z.infer<typeof addPrEntrySchema>;
export type SetThemeSummaryInput = z.infer<typeof setThemeSummarySchema>;
export type CompleteRecapInput = z.infer<typeof completeRecapSchema>;
export type GetPrDiffInput = z.infer<typeof getPrDiffSchema>;
