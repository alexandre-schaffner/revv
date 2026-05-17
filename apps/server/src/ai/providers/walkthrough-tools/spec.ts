import type {
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  WalkthroughIssue,
  WalkthroughRating,
  WalkthroughSemanticStep,
  WalkthroughStreamEvent,
  WsServerMessage,
} from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { Effect } from "effect";
import { z } from "zod";
import type { Db } from "../../../db";

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
   *
   * The emit implementation is provider-specific: the Claude SDK path passes
   * a callback that routes through `WalkthroughJobs.emitEvent` (P1), while
   * the opencode HTTP path wraps the same route via `runSync`. Both are
   * synchronous from the handler's perspective — the handler simply calls
   * `ctx.emit(event)` and returns the tool result; broadcast timing is
   * handled by the provider's wrapper, not the handler.
   */
  readonly emit: (event: WalkthroughStreamEvent) => void;
  /**
   * General WebSocket broadcast hook (separate channel from the walkthrough
   * SSE stream above). Used by handlers that mutate non-walkthrough tables —
   * specifically `add_issue_comment`, which writes to `comment_threads` /
   * `thread_messages` and must notify any open `DiffViewerInner` so the
   * agent's comment shows up inline in the diff. Like `emit`, it is called
   * AFTER the DB commit so subscribers never see an event without a row.
   */
  readonly broadcastThreadEvent: (msg: WsServerMessage) => void;
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

/**
 * Read-only: returns recent project recaps for the repo this walkthrough
 * belongs to. The agent calls this once during Phase A to ground its
 * overview in recent project context (what shipped, themes, risk
 * patterns) without re-deriving them from the diff alone. See
 * `apps/server/src/services/ProjectRecap.ts` for the recap model.
 *
 * Empty inputs by design — the repoId is resolved from the walkthrough
 * row inside the handler.
 */
const getRepoContextSchema = z.object({
  /**
   * Optional period filter. Default is "any period" — the handler returns
   * the most recent recaps across daily and weekly so the agent sees both
   * fresh signal (yesterday) and broader context (last week).
   */
  period: z.enum(["daily", "weekly"]).nullable().optional(),
  /** Optional cap; defaults to 3. Hard maximum 10 to keep prompts bounded. */
  limit: z.number().int().positive().max(10).nullable().optional(),
});

/**
 * Read-only: returns the PR commit list captured at job start. The agent
 * calls this once before opening the required journey chapter at
 * `semantic_step_index: 0`, then narrates the narrative from the response.
 *
 * Empty inputs by design — the walkthroughId is in the tool context.
 * Commits are stored verbatim on the walkthrough row (`pr_commits` JSON
 * column), so this never hits GitHub.
 */
const getCommitHistorySchema = z.object({});

const setOverviewSchema = z.object({
  summary: z.string().describe("2-3 sentence summary of what this PR does and why"),
  risk_level: z.enum(["low", "medium", "high"]).describe("Overall risk assessment"),
});

/**
 * Phase B chapter declaration — opens a chapter AND writes its first atomic
 * block in one transaction. This is the ONLY way to create a chapter. The
 * `initial_block` argument is REQUIRED: it lands at `step_index=0` of the
 * chapter, so a chapter cannot exist without content.
 *
 * Rationale: a previous version of this tool only opened the chapter and
 * relied on a follow-up `add_diff_step` call to fill it. Models routinely
 * stopped between the two calls (open chapter → satisfied → end_turn),
 * leaving empty chapters that the completion gate would reject and the run
 * would never recover from. Bundling the first block into the open call
 * eliminates the failure mode by construction.
 *
 * Subsequent atomic blocks in the same chapter (the 2nd–Nth) still go through
 * `add_diff_step` with `step_index >= 1`.
 *
 * One atomic idempotent upsert per call (doctrine invariant #3): retry with
 * the same `semantic_step_index` replays as a no-op against the unique key
 * for both the chapter row and the step_index=0 block.
 */
const semanticStepInitialBlockSchema = z
  .object({
    markdown: z
      .object({
        content: z
          .string()
          .describe(
            "GitHub-flavored markdown for the chapter's opening block. Headings, **bold**, `inline code`, lists, blockquotes, fenced snippets — use the full toolkit. This is the first thing the reader sees in the chapter, so set up the narrative.",
          ),
      })
      .nullable()
      .optional()
      .describe(
        "Use for narrative/explanatory opening content. Mutually exclusive with `code` and `diff`.",
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
        "Use for source-code excerpts. Mutually exclusive with `markdown` and `diff`. Annotation REQUIRED (1–3 sentences) — code without annotation is a wall of code.",
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
        "Use for unified-diff hunks. Mutually exclusive with `markdown` and `code`. Annotation REQUIRED (1–3 sentences).",
      ),
  })
  .describe(
    "REQUIRED. Exactly one of { markdown, code, diff }. Becomes the chapter's step_index=0 block, written atomically with the chapter itself.",
  );

const addSemanticStepSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Monotonic zero-based ordering for this chapter. Required. Use 0 for the first chapter, 1 for the second, and so on. Upsert key: a retry with the same index replaces (not duplicates) the prior row.",
    ),
  title: z
    .string()
    .min(1)
    .describe(
      "Chapter title — the heading the reader sees. Keep it short (≤ ~60 chars). Describe the concept being walked through, e.g. 'Token validation changes', 'Race condition in refresh flow', 'Test coverage gaps'. NOT a file name — chapters span concepts, not files.",
    ),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional 1–2 sentence prelude rendered under the chapter title. Use to frame what the reader is about to learn in this chapter. Omit (or set null) when the title is self-explanatory.",
    ),
  initial_block: semanticStepInitialBlockSchema,
});

/**
 * Phase B step input — exactly one atomic block per tool call. The tool
 * schema rejects arrays and batch submissions deliberately (doctrine
 * invariant #4): each step is a separate atomic MCP call so resume is
 * idempotent and crash loss is bounded to at most one in-flight step.
 *
 * Every block belongs to a parent semantic step (declared earlier via
 * `add_semantic_step`). The persistence key is
 * `(walkthroughId, phase, semantic_step_index, step_index)`.
 */
const addDiffStepSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Index of the parent chapter — must reference a `semantic_step_index` already created via `add_semantic_step`. Required. Use the same value for every block in a chapter.",
    ),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Monotonic zero-based index for this atomic block *within* its parent chapter. Restart at 0 in each new chapter. Required. Upsert key: a retry with the same (semantic_step_index, step_index) replaces (not duplicates) the prior row.",
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
    .describe("Use for narrative/explanatory content. Mutually exclusive with `code` and `diff`."),
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

/**
 * Reference to a single atomic block by its composite position. Used by
 * `flag_issue.block_refs` and `rate_axis.block_refs` to point at the
 * `add_diff_step` calls that explain a concern/rating. The handler
 * resolves these to canonical `block-{walkthroughId}-{semantic}-{step}` ids
 * and persists them in the row's `blockIds` JSON.
 */
const blockRefSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe("Parent chapter's semantic_step_index."),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Atomic block's step_index within the chapter (matches the add_diff_step call you want to reference).",
    ),
});

const flagIssueSchema = z.object({
  severity: z
    .enum(["info", "warning", "critical"])
    .describe(
      "DEFAULT TO 'warning' WHEN UNSURE. Calibration: 'info' = nitpick the coder can ignore (style preference, optional cleanup, observation a real reviewer would not block on) — RARE, most reviews have zero info. 'warning' = a real concern the coder should address before merge (concrete bug, missing test, error path not handled, design issue, unclear naming on critical path, missing edge-case handling) — this is the COMMON case for any concern worth surfacing. 'critical' = hard merge blocker (security flaw, auth bypass, data loss, broken migration, breaking API change without compatibility shim, race condition in shared state, unhandled error that crashes the process). Do not soften 'critical' to 'warning' — if it would cause an incident, call it critical. Do not soften 'warning' to 'info' to hedge — if you would mention it as a reviewer, it is at minimum a warning.",
    ),
  title: z.string().describe("Short title of the concern (10 words max)"),
  description: z
    .string()
    .describe(
      "MINIMAL one-sentence label for the issues-list card (≤ ~15 words). Do not explain the concern here — the full explanation belongs in the annotation of the linked diff step.",
    ),
  block_refs: z
    .array(blockRefSchema)
    .min(1)
    .describe(
      "Composite identifiers of the diff step(s) that explain this concern, in the form { semantic_step_index, step_index }. Must reference blocks already added via add_diff_step. Provide every block the reviewer should read to understand the issue.",
    ),
  file_path: z.string().nullable().describe("Path to the relevant file, or null if PR-wide"),
  start_line: z.number().int().nullable().describe("Starting line number of the concern, or null"),
  end_line: z.number().int().nullable().describe("Ending line number of the concern, or null"),
});

const addIssueCommentSchema = z.object({
  issue_id: z
    .string()
    .describe(
      "The walkthrough_issues.id returned (in the ok result text) by a prior flag_issue call. The issue must exist for this walkthrough — calls referencing an unknown id are rejected.",
    ),
  file_path: z
    .string()
    .describe(
      "Path of the file the comment anchors to — must match a path present in the PR diff.",
    ),
  start_line: z
    .number()
    .int()
    .describe(
      "1-based start line of the anchor range. Must be inside a hunk present in the PR diff (same rule as human review comments on GitHub).",
    ),
  end_line: z
    .number()
    .int()
    .describe("1-based inclusive end line. Equal to start_line for a single-line comment."),
  diff_side: z
    .enum(["old", "new"])
    .default("new")
    .describe(
      "'new' for added/modified lines (right side of a split diff), 'old' for deleted lines.",
    ),
  body: z
    .string()
    .describe(
      "Markdown body of the comment. Speak to the coder directly — explain the issue, why it matters, and the recommended fix. Idempotency: a retry with the same anchor (issue_id + file_path + start_line + end_line + diff_side) replaces the body of the existing comment rather than creating a duplicate.",
    ),
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
  block_refs: z
    .array(blockRefSchema)
    .describe(
      "Composite identifiers of Phase-B diff blocks that explain this rating in depth, in the form { semantic_step_index, step_index }. May be empty. Each entry must reference a block already added via add_diff_step.",
    ),
});

const completeWalkthroughSchema = z.object({});

// ── Type exports (so handlers can be written with static input types) ────────

export type GetWalkthroughStateInput = z.infer<typeof getWalkthroughStateSchema>;
export type GetCommitHistoryInput = z.infer<typeof getCommitHistorySchema>;
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type SetOverviewInput = z.infer<typeof setOverviewSchema>;
export type AddSemanticStepInput = z.infer<typeof addSemanticStepSchema>;
export type AddDiffStepInput = z.infer<typeof addDiffStepSchema>;
export type FlagIssueInput = z.infer<typeof flagIssueSchema>;
export type AddIssueCommentInput = z.infer<typeof addIssueCommentSchema>;
export type SetSentimentInput = z.infer<typeof setSentimentSchema>;
export type RateAxisInput = z.infer<typeof rateAxisSchema>;
export type CompleteWalkthroughInput = z.infer<typeof completeWalkthroughSchema>;

// Re-exported so both the Claude SDK wrapper and the HTTP MCP route can
// construct the spec list without reimporting zod for every shape.
export {
  addDiffStepSchema,
  addIssueCommentSchema,
  addSemanticStepSchema,
  completeWalkthroughSchema,
  flagIssueSchema,
  getCommitHistorySchema,
  getRepoContextSchema,
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

/**
 * Deterministic comment-thread id for the `add_issue_comment` MCP tool.
 * Collision-resistant (SHA-256) and stable across resumes — a retry of
 * `add_issue_comment` with the same anchor produces the same id, so the
 * underlying `comment_threads` upsert is idempotent (one thread per
 * (issue, file, start_line, end_line, diff_side) tuple).
 */
export async function computeAnchorThreadId(
  walkthroughId: string,
  issueId: string,
  filePath: string,
  startLine: number,
  endLine: number,
  diffSide: "old" | "new",
): Promise<string> {
  const input = `${walkthroughId}\0${issueId}\0${filePath}\0${startLine}\0${endLine}\0${diffSide}`;
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
  WalkthroughSemanticStep,
  WalkthroughStreamEvent,
};
/** Canonical RATING_AXES re-export so handlers can reference it locally. */
export { RATING_AXES };
