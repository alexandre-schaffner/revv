import type { ThreadEventMessage, WalkthroughStreamEvent } from "@revv/shared";
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
import {
  artifactBlockField,
  blockRefSchema,
  citationSchema,
  codeBlockSchema,
  confidenceSchema,
  diffBlockSchema,
  ratingAxisSchema,
  severityCalibration,
  severitySchema,
  verdictSchema,
} from "../walkthrough-content-schema";

// The content pipeline is strictly A → B → C → D (CLAUDE.md, "Agent Subsystem
// Invariants"). Each write tool belongs to one phase and refuses an
// out-of-order call with an error the agent can recover from; `phases.ts`
// holds the windows. Handlers write in one transaction and emit after the
// commit (invariant 8).

export interface WalkthroughToolContext {
  readonly db: Db;
  readonly walkthroughId: string;
  /** Called after the commit, so no subscriber sees an event without its row (invariant 8). */
  readonly emit: (event: WalkthroughStreamEvent) => void;
  /** After the commit, for `add_issue_comment`'s thread, which the diff view shows inline. */
  readonly broadcastThreadEvent: (msg: ThreadEventMessage) => void;
  /**
   * The Jev judgments the Phase-B tools defer to. Each degrades to "no
   * opinion" when Jev is unavailable.
   */
  readonly jev: WalkthroughToolJudgments;
}

export interface WalkthroughToolJudgments {
  /**
   * Schedules the relevance/severity judgment for a just-committed concern;
   * returns immediately, may later retract the row. See ai/jev/issue-relevance.ts.
   */
  readonly scheduleIssueJudgment: (issueId: string, candidate: IssueCandidate) => void;
  /**
   * Blocks until every scheduled judgment has landed. Used by
   * complete_walkthrough so the gate never checks a set about to change.
   */
  readonly awaitIssueJudgments: () => Promise<void>;
  readonly issueRetracted: (issueId: string) => boolean;
  /**
   * Holds an artifact to the craft bar. Awaited, unlike the issue judgment,
   * since a rejecting gate must answer before the write.
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

export type WalkthroughToolResult = McpToolResult;

export type WalkthroughToolHandler<TInput> = (
  ctx: WalkthroughToolContext,
  input: TInput,
) => Promise<WalkthroughToolResult>;

export type WalkthroughToolSpec = GatewayToolSpec<WalkthroughToolContext, WalkthroughToolResult> & {
  /** What the exploration feed shows while the call runs. */
  readonly activity: string;
};

const getWalkthroughStateSchema = z.object({});

const getRepoContextSchema = z.object({
  period: z.enum(["daily", "weekly"]).nullable().optional(),
  limit: z.coerce.number().int().positive().max(10).nullable().optional(),
});

const getCommitHistorySchema = z.object({});

const getStackContextSchema = z.object({});

const setOverviewSchema = z.object({
  summary: z.string().describe(`${SUMMARY_CONTRACT} ${PROSE_VOICE_CONTRACT}`),
  // Optional, not removed: ignored once the orchestrator has assigned the
  // tier (invariant 2's carve-out); otherwise still the only source of it.
  risk_level: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .describe(
      "Overall risk assessment. Omit when the prompt states the tier has already been assigned — a value sent then is ignored.",
    ),
});

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
    code: codeBlockSchema
      .nullable()
      .optional()
      .describe(
        `Use for source-code excerpts. Mutually exclusive with \`markdown\`, \`diff\`, and \`artifact\`. Annotation REQUIRED (1–3 sentences, 45 words); code without annotation is a wall of code. ${PROSE_VOICE_CONTRACT}`,
      ),
    diff: diffBlockSchema
      .nullable()
      .optional()
      .describe(
        `Use for unified-diff hunks. Mutually exclusive with \`markdown\`, \`code\`, and \`artifact\`. Annotation REQUIRED (1–3 sentences, 45 words). ${PROSE_VOICE_CONTRACT}`,
      ),
    artifact: artifactBlockField,
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
 * One block per call: batching is forbidden at the tool surface (invariant 4),
 * so a crash loses at most one in-flight step.
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
  code: codeBlockSchema
    .nullable()
    .optional()
    .describe(
      "Use for source-code excerpts. Mutually exclusive with `markdown`, `diff`, and `artifact`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
    ),
  diff: diffBlockSchema
    .nullable()
    .optional()
    .describe(
      "Use for unified-diff hunks. Mutually exclusive with `markdown`, `code`, and `artifact`. Annotations on issue-target blocks must be LONG (multi-paragraph).",
    ),
  artifact: artifactBlockField,
});

const flagIssueSchema = z.object({
  severity: severitySchema.describe(severityCalibration("flag_issue")),
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

/**
 * Keyed on `(walkthrough_id, lead_id)`: a later call replaces the verdict, so
 * a replay is a no-op and a changed mind is one more call.
 */
const resolveLeadSchema = z.object({
  lead_id: z.string().describe("The lead's id from the prompt's First-pass leads, e.g. `L3`."),
  verdict: z
    .enum(["confirmed", "rejected"])
    .describe(
      "confirmed: the lead held up once you read the code, and you raised an issue for it. rejected: it didn't hold up.",
    ),
  issue_id: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Required when confirmed: the id flag_issue returned for the issue this lead became. Several leads may share one issue.",
    ),
  reason: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Required when rejected: one sentence (≤ 40 words) naming what in the code answers the lead — the caller that guarantees the value, the test that already covers it. ${PLAIN_TEXT_FIELD}`,
    ),
});

const setSentimentSchema = z.object({
  markdown: z
    .string()
    .describe(`GitHub-flavored markdown. ${SENTIMENT_CONTRACT} ${PROSE_VOICE_CONTRACT}`),
});

const rateAxisSchema = z.object({
  axis: ratingAxisSchema.describe(
    "Which scorecard axis this rating is for. correctness: logic errors, off-by-ones, race conditions, unhandled errors. scope: is the PR doing one thing, or has it absorbed drive-by refactors / unrelated formatting — several unrelated concerns is at least a concern, with the concrete split named in details. tests: new behavior has tests, no suspiciously deleted/weakened assertions. clarity: naming, function length, nesting depth, comment quality, dead code, magic numbers. safety: touches auth, payments, migrations, deletes, public APIs, shared packages (a risk-surface signal, not a quality score). consistency: follows existing codebase patterns (layering, module boundaries, conventions). api_changes: breaking changes to routes, schemas, event payloads, exported types. performance: N+1 queries, unbounded loops, sync work in hot paths, missing indexes. description: does the PR explain why (not just what), link issues, call out deployment concerns.",
  ),
  verdict: verdictSchema.describe(
    "pass: no meaningful concern on this axis (or n/a for this PR). concern: should be addressed before merge. blocker: do not merge until fixed.",
  ),
  confidence: confidenceSchema.describe(
    "How confident you are in this verdict. Use low when you couldn't find the caller / adjacent tests / relevant config — honest low confidence is more useful than a confident wrong rating.",
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
    .array(citationSchema)
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

export type GetWalkthroughStateInput = z.infer<typeof getWalkthroughStateSchema>;
export type GetCommitHistoryInput = z.infer<typeof getCommitHistorySchema>;
export type GetRepoContextInput = z.infer<typeof getRepoContextSchema>;
export type GetStackContextInput = z.infer<typeof getStackContextSchema>;
export type SetOverviewInput = z.infer<typeof setOverviewSchema>;
export type AddSemanticStepInput = z.infer<typeof addSemanticStepSchema>;
export type AddDiffStepInput = z.infer<typeof addDiffStepSchema>;
export type FlagIssueInput = z.infer<typeof flagIssueSchema>;
export type AddIssueCommentInput = z.infer<typeof addIssueCommentSchema>;
export type ResolveLeadInput = z.infer<typeof resolveLeadSchema>;
export type SetSentimentInput = z.infer<typeof setSentimentSchema>;
export type RateAxisInput = z.infer<typeof rateAxisSchema>;
export type CompleteWalkthroughInput = z.infer<typeof completeWalkthroughSchema>;

export {
  addDiffStepSchema,
  addIssueCommentSchema,
  addSemanticStepSchema,
  completeWalkthroughSchema,
  flagIssueSchema,
  getCommitHistorySchema,
  getRepoContextSchema,
  getStackContextSchema,
  getWalkthroughStateSchema,
  rateAxisSchema,
  resolveLeadSchema,
  setOverviewSchema,
  setSentimentSchema,
};
