import type {
  ArtifactBlock,
  CodeBlock,
  DiffBlock,
  MarkdownBlock,
  RatingAxis,
  RatingCitation,
  RiskLevel,
  ThreadEventMessage,
  WalkthroughIssue,
  WalkthroughRating,
  WalkthroughSemanticStep,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { RATING_AXES } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";
import type { ArtifactVerdict } from "../../jev/artifact-quality";
import type { IssueCandidate } from "../../jev/contracts";
import {
  ISSUE_COMMENT_CONTRACT,
  PLAIN_TEXT_FIELD,
  PROSE_VOICE_CONTRACT,
  SENTIMENT_CONTRACT,
  SUMMARY_CONTRACT,
} from "../../prompts/review-copy-contract";
import type { ToolSpec as GatewayToolSpec, McpToolResult } from "../mcp-tool-gateway";

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
   * General thread-event broadcast hook. Used by handlers that mutate non-walkthrough tables —
   * specifically `add_issue_comment`, which writes to `comment_threads` /
   * `thread_messages` and must notify any open `DiffViewerInner` so the
   * agent's comment shows up inline in the diff. Like `emit`, it is called
   * AFTER the DB commit so subscribers never see an event without a row.
   */
  readonly broadcastThreadEvent: (msg: ThreadEventMessage) => void;
  /**
   * The Jev-backed judgments the Phase-B tools defer to, injected as
   * closures rather than service handles so the handlers stay free of Effect
   * dependencies (the same reason `emit` is a callback).
   *
   * Every one of them degrades to "no opinion" — off, unconfigured,
   * unreachable — and the handler's behaviour without an opinion is exactly
   * what it was before these existed.
   */
  readonly jev: WalkthroughToolJudgments;
}

export interface WalkthroughToolJudgments {
  /**
   * Schedule the relevance + severity judgment for a just-committed concern.
   * **Returns immediately**; the judgment lands behind the agent and may
   * retract the row. See `ai/jev/issue-relevance.ts`.
   */
  readonly scheduleIssueJudgment: (issueId: string, candidate: IssueCandidate) => void;
  /**
   * Block until every scheduled judgment for this walkthrough has landed.
   * Called by `complete_walkthrough` so the gate never validates an issue set
   * that is about to change under it.
   */
  readonly awaitIssueJudgments: () => Promise<void>;
  /** Whether a judgment already retracted this issue id. */
  readonly issueRetracted: (issueId: string) => boolean;
  /**
   * Hold an artifact to the craft bar. **Awaited**, unlike the issue
   * judgment: a gate that rejects has to answer before the write, and
   * artifacts are rare enough that the round trip doesn't matter.
   */
  readonly judgeArtifact: (
    html: string,
    context: { readonly chapterTitle: string; readonly annotation: string | null },
  ) => Promise<ArtifactVerdict>;
  /** Schedule a voice check on a markdown block. Returns immediately. */
  readonly scheduleProseCheck: (markdown: string, chapterTitle: string) => void;
  /** Drain any voice advice that landed since the last tool call. */
  readonly takeProseAdvice: () => string | null;
}

export interface WalkthroughToolResult extends McpToolResult {
  // MCP SDK's tool() signature uses an open-ended response type with a
  // string index signature. This extra field lets our narrower type unify
  // with that shape when the SDK wraps us; it's never populated.
  [k: string]: unknown;
}

export type WalkthroughToolHandler<TInput> = (
  ctx: WalkthroughToolContext,
  input: TInput,
) => Promise<WalkthroughToolResult>;

export type WalkthroughToolSpec = GatewayToolSpec<WalkthroughToolContext, WalkthroughToolResult>;

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
  limit: z.coerce.number().int().positive().max(10).nullable().optional(),
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
  summary: z.string().describe(`${SUMMARY_CONTRACT} ${PROSE_VOICE_CONTRACT}`),
  // Optional rather than removed. When the orchestrator has already assigned
  // the tier (CLAUDE.md invariant 2's carve-out) the prompt tells the agent
  // the tier is a given and the handler ignores anything sent here; when it
  // hasn't — TypeSafe off, unconfigured, or unreachable — this is still the
  // only source of the tier, exactly as before.
  risk_level: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .describe(
      "Overall risk assessment. Omit when the prompt states the tier has already been assigned — a value sent then is ignored.",
    ),
});

const artifactBlockSchema = z
  .object({
    html: z
      .string()
      .describe(
        "A complete, self-contained HTML document with inline CSS/JS. Vanilla JS only; no external network/CDN; no localStorage; no timers/randomness. Renders in a sandboxed iframe that auto-sizes. Must carry a live state readout, something the reader can vary, and a verdict — a step-reveal with no changing state is a markdown list, not an artifact. Style with the injected Revv theme variables (`var(--color-*)`, `var(--font-*)`) so it matches the app and follows light/dark — never hardcode colors or font-family; spend the accent on the current state, not on buttons. Keep it under ~320px tall: compact rows, no placeholder rows for content not yet revealed. See 'Interactive artifacts (the craft bar)' in the system prompt for the full contract.",
      ),
    annotation: z.string().nullable(),
    annotation_position: z.enum(["left", "right"]),
  })
  .nullable()
  .optional()
  .describe(
    "Use for an interactive widget when prose/code/diff fall short. Mutually exclusive with markdown, code, and diff.",
  );

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
            `GitHub-flavored markdown for the chapter's opening block, budget 150 WORDS. Use headings, \`inline code\`, lists, tables, blockquotes and fenced snippets for STRUCTURE; **bold** is a line-start label, never mid-sentence emphasis. This is the first thing the reader sees in the chapter, so open on the point rather than on a preamble. ${PROSE_VOICE_CONTRACT}`,
          ),
      })
      .nullable()
      .optional()
      .describe(
        "Use for narrative/explanatory opening content. Mutually exclusive with `code`, `diff`, and `artifact`.",
      ),
    code: z
      .object({
        file_path: z.string(),
        start_line: z.coerce.number().int(),
        end_line: z.coerce.number().int(),
        language: z.string(),
        content: z.string(),
        annotation: z.string().nullable(),
        annotation_position: z.enum(["left", "right"]),
      })
      .nullable()
      .optional()
      .describe(
        `Use for source-code excerpts. Mutually exclusive with \`markdown\`, \`diff\`, and \`artifact\`. Annotation REQUIRED (1–3 sentences, 45 words); code without annotation is a wall of code. ${PROSE_VOICE_CONTRACT}`,
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
        `Use for unified-diff hunks. Mutually exclusive with \`markdown\`, \`code\`, and \`artifact\`. Annotation REQUIRED (1–3 sentences, 45 words). ${PROSE_VOICE_CONTRACT}`,
      ),
    artifact: artifactBlockSchema,
  })
  .describe(
    "REQUIRED. Exactly one of { markdown, code, diff, artifact }. Becomes the chapter's step_index=0 block, written atomically with the chapter itself.",
  );

const addSemanticStepSchema = z.object({
  semantic_step_index: z.coerce
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
      "Chapter title — the heading the reader sees. Keep it short (≤ ~60 chars). Describe the concept being walked through, e.g. 'Token validation changes', 'Race condition in refresh flow', 'Test coverage gaps'. NOT a file name — chapters span concepts, not files. " +
        PLAIN_TEXT_FIELD,
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
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      "Index of the parent chapter — must reference a `semantic_step_index` already created via `add_semantic_step`. Required. Use the same value for every block in a chapter.",
    ),
  step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      "Monotonic zero-based index for this atomic block *within* its parent chapter. Restart at 0 in each new chapter. Required. Upsert key: a retry with the same (semantic_step_index, step_index) replaces (not duplicates) the prior row.",
    ),
  /** One of four mutually-exclusive block shapes. Agent picks which to send. */
  markdown: z
    .object({
      content: z
        .string()
        .describe(
          `GitHub-flavored markdown, budget 150 WORDS. Use the toolkit for STRUCTURE, not for volume: headings (## / ###), **bold** labels, \`inline code\` for identifiers and paths, bulleted / numbered lists, tables, > blockquotes, [links](url), and \`\`\`fenced\`\`\` snippets for tiny illustrative code. Give each fact its own line or list item. A dense paragraph the reader must parse linearly is the failure mode. Over 150 words, split into two blocks or cut the weaker half. ${PROSE_VOICE_CONTRACT}`,
        ),
    })
    .nullable()
    .optional()
    .describe(
      "Use for narrative/explanatory content. Mutually exclusive with `code`, `diff`, and `artifact`.",
    ),
  code: z
    .object({
      file_path: z.string(),
      start_line: z.coerce.number().int(),
      end_line: z.coerce.number().int(),
      language: z.string(),
      content: z.string(),
      annotation: z.string().nullable(),
      annotation_position: z.enum(["left", "right"]),
    })
    .nullable()
    .optional()
    .describe(
      "Use for source-code excerpts. Mutually exclusive with `markdown`, `diff`, and `artifact`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
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
      "Use for unified-diff hunks. Mutually exclusive with `markdown`, `code`, and `artifact`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
    ),
  artifact: artifactBlockSchema,
});

/**
 * Reference to a single atomic block by its composite position. Used by
 * `flag_issue.block_refs` and `rate_axis.block_refs` to point at the
 * `add_diff_step` calls that explain a concern/rating. The handler
 * resolves these to canonical `block-{walkthroughId}-{semantic}-{step}` ids
 * and persists them in the row's `blockIds` JSON.
 */
const blockRefSchema = z.object({
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Parent chapter's semantic_step_index."),
  step_index: z.coerce
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
      "Two decisions, kept separate. (1) WHETHER TO FLAG — a HIGH bar: flag only if ALL hold — meaningful impact (accuracy/perf/security/maintainability); discrete & actionable with a clear fix; rigor matching the surrounding codebase; introduced by THIS diff (not pre-existing); the author would likely fix it; rests on verifiable facts (no speculation); provably affects specific code (not theoretical); not an intentional design choice. If any fails, do not flag. (2) SEVERITY ONCE FLAGGED — a LOW bar: DEFAULT TO 'warning'; don't hedge a real finding down to 'info'. 'critical' = blocks release / causes an incident (RCE, hardcoded prod secret, auth bypass, unauthenticated privileged endpoint, data-loss path, broken migration, breaking API change without a shim, race on shared state, crash-on-unhandled-error). 'warning' (the common tier) = address before merge / next cycle (SQLi behind auth, stored XSS, sensitive-data IDOR, CSRF on state change, info disclosure, prompt injection behind auth, very-new dependency, missed edge case, missing test for new behavior, unhandled error path, off-by-one). 'info' = RARE genuine nitpick / low-impact hardening the author can defer — most reviews have zero. Security examples are illustrative per tier, not a narrowing — correctness/perf/tests/maintainability map the same way.",
    ),
  title: z.string().describe(`Short title of the concern (10 words max). ${PLAIN_TEXT_FIELD}`),
  description: z
    .string()
    .describe(
      `MINIMAL one-sentence label for the issues-list card (≤ ~15 words). Do not explain the concern here — the full explanation belongs in the annotation of the linked diff step. ${PLAIN_TEXT_FIELD}`,
    ),
  block_refs: z
    .array(blockRefSchema)
    .min(1)
    .describe(
      "Composite identifiers of the diff step(s) that explain this concern, in the form { semantic_step_index, step_index }. Must reference blocks already added via add_diff_step. Provide every block the reviewer should read to understand the issue.",
    ),
  file_path: z.string().nullable().describe("Path to the relevant file, or null if PR-wide"),
  start_line: z.coerce
    .number()
    .int()
    .nullable()
    .describe("Starting line number of the concern, or null"),
  end_line: z.coerce
    .number()
    .int()
    .nullable()
    .describe("Ending line number of the concern, or null"),
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
  start_line: z.coerce
    .number()
    .int()
    .describe(
      "1-based start line of the anchor range. Must be inside a hunk present in the PR diff (same rule as human review comments on GitHub).",
    ),
  end_line: z.coerce
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
      `Markdown body of the comment. ${ISSUE_COMMENT_CONTRACT} ${PROSE_VOICE_CONTRACT} Idempotency: a retry with the same anchor (issue_id + file_path + start_line + end_line + diff_side) replaces the body of the existing comment rather than creating a duplicate.`,
    ),
});

const setSentimentSchema = z.object({
  markdown: z
    .string()
    .describe(
      `GitHub-flavored markdown. ${SENTIMENT_CONTRACT} ${PROSE_VOICE_CONTRACT} Replaces the old convention of emitting a '## Overall Sentiment' markdown block.`,
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
      "Which scorecard axis this rating is for. correctness: logic errors, off-by-ones, race conditions, unhandled errors. scope: is the PR doing one thing, or has it absorbed drive-by refactors / unrelated formatting — several unrelated concerns is at least a concern, with the concrete split named in details. tests: new behavior has tests, no suspiciously deleted/weakened assertions. clarity: naming, function length, nesting depth, comment quality, dead code, magic numbers. safety: touches auth, payments, migrations, deletes, public APIs, shared packages (a risk-surface signal, not a quality score). consistency: follows existing codebase patterns (layering, module boundaries, conventions). api_changes: breaking changes to routes, schemas, event payloads, exported types. performance: N+1 queries, unbounded loops, sync work in hot paths, missing indexes. description: does the PR explain why (not just what), link issues, call out deployment concerns.",
    ),
  // Optional rather than required. When `get_walkthrough_state` returns
  // `assignedVerdicts`, the call has already been made and this argument is
  // ignored outright — asking for it anyway would spend the agent's
  // deliberation on a decision it does not own, and invite prose that argues
  // for a verdict the row does not carry. It stays in the schema because the
  // no-TypeSafe path (off, unconfigured, unreachable) still needs it.
  verdict: z
    .enum(["pass", "concern", "blocker"])
    .nullable()
    .optional()
    .describe(
      "OMIT when get_walkthrough_state returned `assignedVerdicts` — the verdict is already decided and anything sent here is discarded; your job is the reasoning for the verdict listed there. REQUIRED otherwise. pass: no meaningful concern on this axis (or n/a for this PR). concern: should be addressed before merge. blocker: do not merge until fixed.",
    ),
  confidence: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .describe(
      "OMIT when `assignedVerdicts` was returned — it carries the confidence too. REQUIRED otherwise: how confident you are in this verdict. Use low when you couldn't find the caller / adjacent tests / relevant config — honest low confidence is more useful than a confident wrong rating.",
    ),
  rationale: z
    .string()
    .describe(
      `1–2 sentences, 35 words. Required. Lead with what drove the verdict, then the evidence: 'No tests cover the new \`refresh\` failure path', not 'While the existing suite is thorough, there is one area…'. If the axis doesn't apply (e.g. performance on a docs-only PR), emit verdict=pass with a rationale starting 'n/a for this PR — '. ${PROSE_VOICE_CONTRACT}`,
    ),
  details: z
    .string()
    .describe(
      `GitHub-flavored markdown expanding on the rationale, budget 80 WORDS. Use the toolkit for STRUCTURE: **bold** labels, \`inline code\` for identifiers/paths, one bullet per finding. For pass: one or two sentences naming what you checked. Do not pad a clean axis; nine padded axes are a wall of text nobody reads. For concern/blocker: what breaks, the affected code path, the fix, then a concrete effort estimate (\`~15 min\`, \`about a day\`), as a short bullet list rather than a paragraph. ${PROSE_VOICE_CONTRACT}`,
    ),
  citations: z
    .array(
      z.object({
        file_path: z.string(),
        start_line: z.coerce.number().int(),
        end_line: z.coerce.number().int(),
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
  disputed: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Set ONLY when this axis was HANDED a non-pass verdict (get_walkthrough_state listed it under assignedVerdicts) that you genuinely cannot cite. There it stands in for the citation requirement and must come with a rationale explaining the absence; it is recorded as a disagreement signal and never changes the verdict. On an axis whose verdict you chose yourself it is ignored, and the citation requirement still applies — cite the evidence or downgrade to pass. Do not use it to avoid looking for evidence.",
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
  ArtifactBlock,
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
