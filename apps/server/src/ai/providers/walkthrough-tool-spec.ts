import type {
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  WalkthroughIssue,
  WalkthroughRating,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../db";

// ─── Doctrine & phase model ─────────────────────────────────────────────────
//
// The walkthrough content pipeline is strictly A → B → C → D (see
// "Agent Subsystem Invariants" in the repo-root CLAUDE.md). Every MCP tool in
// this file is bound to a specific phase and enforces its precondition at the
// tool-call level — out-of-order calls fail fast with a structured error the
// agent can recover from.
//
//   Phase A — set_overview     (one call; fills walkthroughs.summary + risk)
//   Phase B — add_diff_step    (many calls; one per step)
//            flag_issue        (any number; only during B, linked to steps)
//   Phase C — set_sentiment    (one call; fills walkthroughs.sentiment)
//   Phase D — rate_axis        (nine calls, one per RatingAxis)
//   Finish  — complete_walkthrough (validation gate; advances status)
//
// Plus one read tool:
//   get_walkthrough_state      (read-only; called first on every run to
//                               reconstruct context from DB — replaces the old
//                               env-var continuation channel)
//
// Handler contract:
//   Each handler is a pure function `(ctx, input) => Promise<ToolResult>` that:
//     1. Opens a db.transaction().
//     2. Reads the walkthrough row (for `last_completed_phase` + identity).
//     3. Validates the phase precondition + any tool-specific invariants.
//     4. Performs one atomic upsert (or read) against the walkthrough tables.
//     5. Advances `last_completed_phase` if appropriate (same transaction).
//     6. Emits a WalkthroughStreamEvent via ctx.emit (outside DB commit).
//     7. Returns { content, isError? } for the MCP transport layer.
//   The transport layer (Claude Agent SDK wrapper OR HTTP MCP route) is
//   indifferent — same handler runs inside the same Elysia process either way.

// ── Handler execution context ─────────────────────────────────────────────────

export interface WalkthroughToolContext {
  /** Direct DB handle (Bun sqlite + drizzle). */
  readonly db: Db;
  /** The walkthrough this tool call is scoped to — deterministic identity. */
  readonly walkthroughId: string;
  /**
   * Event sink. The handler calls this AFTER the DB commit so subscribers
   * never see an event that doesn't have a corresponding durable row. Per
   * doctrine invariant #8: "Commit first, broadcast second."
   */
  readonly emit: (event: WalkthroughStreamEvent) => void;
}

export interface WalkthroughToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // MCP SDK's tool() signature uses an open-ended response type with a
  // string index signature. This extra field lets our narrower type unify
  // with that shape when the SDK wraps us; it's never populated.
  [k: string]: unknown;
}

export type WalkthroughToolHandler<TInput> = (
  ctx: WalkthroughToolContext,
  input: TInput,
) => Promise<WalkthroughToolResult>;

export interface ToolSpec<TShape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<TShape>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: WalkthroughToolHandler<any>;
}

// ── Tool input schemas (zod) ─────────────────────────────────────────────────

const getWalkthroughStateSchema = z.object({});

const setOverviewSchema = z.object({
  summary: z
    .string()
    .describe("2-3 sentence summary of what this PR does and why"),
  risk_level: z
    .enum(["low", "medium", "high"])
    .describe("Overall risk assessment"),
});

/**
 * Phase B step input — exactly one step per tool call. The tool schema rejects
 * arrays and batch submissions deliberately (doctrine invariant #4): each step
 * is a separate atomic MCP call so resume is idempotent and crash loss is
 * bounded to at most one in-flight step.
 */
const addDiffStepSchema = z.object({
  step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Monotonic zero-based index for this step within Phase B. Required. Upsert key: a retry with the same index replaces (not duplicates) the prior row.",
    ),
  /** One of three mutually-exclusive block shapes. Agent picks which to send. */
  markdown: z
    .object({
      content: z
        .string()
        .describe(
          "GitHub-flavored markdown. USE THE FULL TOOLKIT: headings (## / ###), **bold** for key terms, *italics*, `inline code` for identifiers and paths, bulleted / numbered lists, > blockquotes, [links](url), and ```fenced``` snippets for tiny illustrative code. A single flat sentence is a missed opportunity.",
        ),
    })
    .nullable()
    .optional()
    .describe(
      "Use for narrative/explanatory content. Mutually exclusive with `code` and `diff`.",
    ),
  code: z
    .object({
      file_path: z.string(),
      start_line: z.number().int(),
      end_line: z.number().int(),
      language: z.string(),
      content: z.string(),
      annotation: z.string().nullable(),
      annotation_position: z.enum(["left", "right"]),
    })
    .nullable()
    .optional()
    .describe(
      "Use for source-code excerpts. Mutually exclusive with `markdown` and `diff`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
    ),
  diff: z
    .object({
      file_path: z.string(),
      patch: z.string(),
      annotation: z.string().nullable(),
      annotation_position: z.enum(["left", "right"]),
    })
    .nullable()
    .optional()
    .describe(
      "Use for unified-diff hunks. Mutually exclusive with `markdown` and `code`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
    ),
});

const flagIssueSchema = z.object({
  severity: z
    .enum(["info", "warning", "critical"])
    .describe(
      "info: minor note; warning: should be addressed before merge; critical: blocks merge or introduces serious risk",
    ),
  title: z.string().describe("Short title of the concern (10 words max)"),
  description: z
    .string()
    .describe(
      "MINIMAL one-sentence label for the issues-list card (≤ ~15 words). Do not explain the concern here — the full explanation belongs in the annotation of the linked diff step.",
    ),
  block_orders: z
    .array(z.number().int().nonnegative())
    .min(1)
    .describe(
      "Order numbers (= step_index) of the diff step(s) that explain this concern. Must reference steps already added. Provide every step the reviewer should read to understand the issue.",
    ),
  file_path: z
    .string()
    .nullable()
    .describe("Path to the relevant file, or null if PR-wide"),
  start_line: z
    .number()
    .int()
    .nullable()
    .describe("Starting line number of the concern, or null"),
  end_line: z
    .number()
    .int()
    .nullable()
    .describe("Ending line number of the concern, or null"),
});

const setSentimentSchema = z.object({
  markdown: z
    .string()
    .describe(
      "GitHub-flavored markdown, 2–4 sentences, direct verdict. Covers the reviewer's bottom-line read of the PR after the diff analysis. Replaces the old convention of emitting a '## Overall Sentiment' markdown block.",
    ),
});

const rateAxisSchema = z.object({
  axis: z
    .enum([
      "correctness",
      "scope",
      "tests",
      "clarity",
      "safety",
      "consistency",
      "api_changes",
      "performance",
      "description",
    ])
    .describe(
      "Which scorecard axis this rating is for. correctness: logic errors, off-by-ones, race conditions, unhandled errors. scope: is the PR doing one thing, or has it absorbed drive-by refactors / unrelated formatting. tests: new behavior has tests, no suspiciously deleted/weakened assertions. clarity: naming, function length, nesting depth, comment quality, dead code, magic numbers. safety: touches auth, payments, migrations, deletes, public APIs, shared packages (a risk-surface signal, not a quality score). consistency: follows existing codebase patterns (layering, module boundaries, conventions). api_changes: breaking changes to routes, schemas, event payloads, exported types. performance: N+1 queries, unbounded loops, sync work in hot paths, missing indexes. description: does the PR explain why (not just what), link issues, call out deployment concerns.",
    ),
  verdict: z
    .enum(["pass", "concern", "blocker"])
    .describe(
      "pass: no meaningful concern on this axis (or n/a for this PR). concern: should be addressed before merge. blocker: do not merge until fixed.",
    ),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe(
      "How confident you are in this verdict. Use low when you couldn't find the caller / adjacent tests / relevant config — honest low confidence is more useful than a confident wrong rating.",
    ),
  rationale: z
    .string()
    .describe(
      "1–2 sentences. Required. If the axis doesn't apply (e.g. performance on a docs-only PR), emit verdict=pass with a rationale starting 'n/a for this PR — '.",
    ),
  details: z
    .string()
    .describe(
      "Rich GitHub-flavored markdown expanding on the rationale. USE THE FULL TOOLKIT: **bold** key terms, `inline code` for identifiers/paths, bullet lists for multiple findings, and ### subheadings if needed. For pass: 2–4 sentences explaining what was checked and why it's clean. For concern/blocker: explain the problem clearly, why it matters, affected code paths, and the recommended fix. Minimum 3 sentences.",
    ),
  citations: z
    .array(
      z.object({
        file_path: z.string(),
        start_line: z.number().int(),
        end_line: z.number().int(),
        note: z.string().nullable(),
      }),
    )
    .describe(
      "Specific lines backing the verdict. REQUIRED (>= 1) for verdict=concern or verdict=blocker. Optional (may be empty) for verdict=pass.",
    ),
  block_orders: z
    .array(z.number().int().nonnegative())
    .describe(
      "Order numbers (= step_index) of Phase-B diff step(s) that explain this rating in depth. May be empty. Each entry must reference a step already added.",
    ),
});

const completeWalkthroughSchema = z.object({});

// ── Type exports (so handlers can be written with static input types) ────────

export type GetWalkthroughStateInput = z.infer<
  typeof getWalkthroughStateSchema
>;
export type SetOverviewInput = z.infer<typeof setOverviewSchema>;
export type AddDiffStepInput = z.infer<typeof addDiffStepSchema>;
export type FlagIssueInput = z.infer<typeof flagIssueSchema>;
export type SetSentimentInput = z.infer<typeof setSentimentSchema>;
export type RateAxisInput = z.infer<typeof rateAxisSchema>;
export type CompleteWalkthroughInput = z.infer<
  typeof completeWalkthroughSchema
>;

// Re-exported so both the Claude SDK wrapper and the HTTP MCP route can
// construct the spec list without reimporting zod for every shape.
export {
  addDiffStepSchema,
  completeWalkthroughSchema,
  flagIssueSchema,
  getWalkthroughStateSchema,
  rateAxisSchema,
  setOverviewSchema,
  setSentimentSchema,
};

// ── Specs are declared where handlers are defined ─────────────────────────────
//
// See `walkthrough-tools.ts` for TOOL_SPECS (the array both transports
// consume). Keeping the handler implementations there keeps the DB-imports
// out of this spec file so tests can stub handlers without pulling in
// SQLite.

// Re-exported constants for handler shape callers
export type { WalkthroughPipelinePhase, WalkthroughState } from "@revv/shared";

// ── Shared helpers reused by handlers ──────────────────────────────────────

/**
 * Deterministic issue id. Collision-resistant (SHA-256) and stable across
 * resumes: if the agent calls `flag_issue` with the same title + file + start
 * line twice (e.g. after a crash), both calls produce the same row id and the
 * second becomes a no-op via `onConflictDoUpdate`.
 */
export async function computeIssueId(
  walkthroughId: string,
  title: string,
  filePath: string | null,
  startLine: number | null,
): Promise<string> {
  const input = `${walkthroughId}\0${title}\0${filePath ?? ""}\0${startLine ?? ""}`;
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Re-export the canonical types used by handlers so walkthrough-tools.ts does
// not need separate @revv/shared imports.
export type {
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  WalkthroughIssue,
  WalkthroughRating,
  WalkthroughStreamEvent,
};
/** Canonical RATING_AXES re-export so handlers can reference it locally. */
export { RATING_AXES };
