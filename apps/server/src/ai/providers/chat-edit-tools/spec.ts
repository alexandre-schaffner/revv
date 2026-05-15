// ── chat-edit-tool-spec ─────────────────────────────────────────────────────
//
// Zod input schemas + context types for the chat agent's walkthrough-edit
// MCP tools. Mirrors `walkthrough-tool-spec.ts` (generation pipeline) but for
// the post-completion edit path that lets the right-pane chat agent mutate
// the latest completed walkthrough for a PR.
//
// See CLAUDE.md invariant #7 — these tools are the only authorized
// post-completion mutation path for a walkthrough. They never touch `status`
// or `lastCompletedPhase`; they stamp `lastEditedAt` / `lastEditedBy` on the
// parent row and broadcast `walkthrough:edited` envelopes via WebSocketHub
// (not the generation SSE stream, which dies on `done`).

import type { WalkthroughStreamEvent, WsServerMessage } from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";

// ── Handler execution context ───────────────────────────────────────────────

/**
 * Actor identifier stamped on `walkthroughs.lastEditedBy`. The two values
 * map to the two transports: the in-process Claude SDK and the HTTP MCP
 * route used by the opencode daemon.
 */
export type ChatEditActor = "chat:claude" | "chat:opencode";

export interface ChatWalkthroughEditContext {
  /** Direct DB handle (Bun sqlite + drizzle). */
  readonly db: Db;
  /**
   * The PR this chat session is scoped to. Each handler resolves the
   * target walkthrough as "latest `status='complete'` walkthrough for this
   * PR" — lazy per call so a chat that outlives a regenerate naturally
   * retargets the fresh walkthrough.
   */
  readonly prId: string;
  /** Authenticated chat user. Reserved for future audit/permission checks. */
  readonly userId: string;
  /** Source transport — stamped on `walkthroughs.lastEditedBy`. */
  readonly actor: ChatEditActor;
  /**
   * Event sink. Handlers call this AFTER the DB commit so subscribers never
   * see an event without a durable row. The walkthroughId is passed at call
   * time (handlers resolve it lazily — see {@link resolveActiveWalkthroughId})
   * because chat sessions outlive any one walkthrough; the route wraps this
   * to broadcast a `walkthrough:edited` envelope via WebSocketHub.
   */
  readonly emit: (walkthroughId: string, event: WalkthroughStreamEvent) => void;
  /**
   * General WebSocket broadcast hook for `comment_threads` /
   * `thread_messages` events (mirrors `WalkthroughToolContext`). Used by
   * add_issue_comment / update_issue_comment / delete_issue_comment so any
   * open DiffViewerInner picks up the inline-comment change.
   */
  readonly broadcastThreadEvent: (msg: WsServerMessage) => void;
}

export interface ChatEditToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // MCP SDK's tool() signature uses an open-ended response type with a
  // string index signature. This extra field lets our narrower type unify
  // with that shape when the SDK wraps us; it's never populated.
  [k: string]: unknown;
}

export type ChatEditToolHandler<TInput> = (
  ctx: ChatWalkthroughEditContext,
  input: TInput,
) => Promise<ChatEditToolResult>;

export interface ChatEditToolSpec<TShape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<TShape>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: ChatEditToolHandler<any>;
}

// ── Shared content sub-schemas (mirror walkthrough-tool-spec.ts shapes) ─────

/**
 * Atomic block content variant. Same shape used by the generation pipeline's
 * `add_diff_step` / `add_semantic_step.initial_block`. Exactly one of
 * `markdown`, `code`, or `diff` must be provided.
 */
export const blockContentSchema = z
  .object({
    markdown: z
      .object({ content: z.string() })
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
      .describe("Use for source-code excerpts. Mutually exclusive with `markdown` and `diff`."),
    diff: z
      .object({
        file_path: z.string(),
        patch: z.string(),
        annotation: z.string().nullable(),
        annotation_position: z.enum(["left", "right"]),
      })
      .nullable()
      .optional()
      .describe("Use for unified-diff hunks. Mutually exclusive with `markdown` and `code`."),
  })
  .describe(
    "REQUIRED. Exactly one of { markdown, code, diff } — the same shape add_diff_step uses.",
  );

/** Composite identifier for an existing diff block (matches walkthrough-tool-spec.ts). */
const blockRefSchema = z.object({
  semantic_step_index: z.number().int().nonnegative(),
  step_index: z.number().int().nonnegative(),
});

/** Rating axis enum, matched against `RATING_AXES`. */
const ratingAxisSchema = z.enum([
  "correctness",
  "scope",
  "tests",
  "clarity",
  "safety",
  "consistency",
  "api_changes",
  "performance",
  "description",
]);

// ── Tool input schemas ──────────────────────────────────────────────────────

export const getWalkthroughForEditSchema = z.object({});

export const updateOverviewSchema = z.object({
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New 2–3 sentence PR summary. Omit (or send null) to leave the existing summary unchanged.",
    ),
  risk_level: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .describe(
      "New overall risk assessment. Omit (or send null) to leave the existing risk unchanged.",
    ),
});

export const addSemanticStepEditSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Index at which to insert the new chapter. Must NOT already exist — call get_walkthrough_for_edit first to pick a free index. Gaps are allowed (e.g. existing indices 0,1,3 → you can insert 2, 4, 99 etc.).",
    ),
  title: z.string().min(1).describe("Chapter title (≤ ~60 chars)."),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe("Optional 1–2 sentence prelude rendered under the title."),
  initial_block: blockContentSchema,
});

export const updateSemanticStepSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe("Existing chapter to update — must already exist."),
  title: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe("New chapter title. Omit / null to leave unchanged."),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New chapter summary. Omit to leave unchanged; send null explicitly to clear an existing summary.",
    ),
});

export const deleteSemanticStepSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Chapter to remove. Cascades to all blocks inside the chapter. Rejected if any block in the chapter is the only blockId on a warning/critical issue, or if any affected issue has been pushed to GitHub (submittedAt!=null) — delete those issues first.",
    ),
});

export const addBlockSchema = z.object({
  semantic_step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Index of the parent chapter — must already exist. Use update_semantic_step or add_semantic_step first if you need a new chapter.",
    ),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe(
      "Position within the chapter. Omit to append (MAX(step_index)+1). Must NOT collide with an existing block — use update_block to modify an existing one.",
    ),
  content: blockContentSchema,
});

export const updateBlockSchema = z.object({
  semantic_step_index: z.number().int().nonnegative(),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .describe("Position of the existing block within its chapter. Must already exist."),
  content: blockContentSchema,
});

export const deleteBlockSchema = z.object({
  semantic_step_index: z.number().int().nonnegative(),
  step_index: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Position of the block to delete. Rejected if the block is the only blockId on a warning/critical issue, or if any referencing issue has submittedAt!=null.",
    ),
});

export const updateSentimentSchema = z.object({
  markdown: z
    .string()
    .describe(
      "New Overall Sentiment markdown. 2–4 sentences, direct verdict — replaces the current sentiment in full.",
    ),
});

export const updateRatingSchema = z.object({
  axis: ratingAxisSchema.describe(
    "Axis to update. Must already have a rating row — use get_walkthrough_for_edit to confirm.",
  ),
  verdict: z
    .enum(["pass", "concern", "blocker"])
    .nullable()
    .optional()
    .describe("New verdict. Omit/null to leave unchanged."),
  confidence: z
    .enum(["low", "medium", "high"])
    .nullable()
    .optional()
    .describe("New confidence. Omit/null to leave unchanged."),
  rationale: z
    .string()
    .nullable()
    .optional()
    .describe("New 1–2 sentence rationale. Omit/null to leave unchanged."),
  details: z
    .string()
    .nullable()
    .optional()
    .describe("New rich markdown details. Omit/null to leave unchanged."),
  citations: z
    .array(
      z.object({
        file_path: z.string(),
        start_line: z.number().int(),
        end_line: z.number().int(),
        note: z.string().nullable(),
      }),
    )
    .nullable()
    .optional()
    .describe(
      "Replacement citations array. Omit/null to leave existing citations unchanged. Required (>=1) when the resulting verdict is 'concern' or 'blocker'.",
    ),
  block_refs: z
    .array(blockRefSchema)
    .nullable()
    .optional()
    .describe(
      "Replacement block_refs array. Omit/null to leave existing references unchanged. Each entry must reference an existing diff block.",
    ),
});

export const deleteRatingSchema = z.object({
  axis: ratingAxisSchema.describe(
    "Axis whose rating row should be removed. Does NOT regress lastCompletedPhase — the walkthrough's `status` stays 'complete' even with a missing axis. `get_walkthrough_for_edit` will surface `validation.passesCompletenessGate: false` until another rate-axis is added (or the axis is re-added via add_issue's sibling path is not yet implemented — for v1, deleted ratings stay deleted).",
  ),
});

export const addIssueEditSchema = z.object({
  severity: z.enum(["info", "warning", "critical"]),
  title: z.string(),
  description: z.string(),
  block_refs: z
    .array(blockRefSchema)
    .min(1)
    .describe(
      "Composite identifiers of existing diff block(s) the issue is anchored to. Must reference blocks that already exist.",
    ),
  file_path: z.string().nullable(),
  start_line: z.number().int().nullable(),
  end_line: z.number().int().nullable(),
});

export const updateIssueSchema = z.object({
  issue_id: z.string().describe("Existing walkthrough_issues.id."),
  severity: z.enum(["info", "warning", "critical"]).nullable().optional(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  block_refs: z.array(blockRefSchema).nullable().optional(),
  file_path: z.string().nullable().optional(),
  start_line: z.number().int().nullable().optional(),
  end_line: z.number().int().nullable().optional(),
});

export const deleteIssueSchema = z.object({
  issue_id: z
    .string()
    .describe(
      "walkthrough_issues.id to delete. Rejected if submittedAt!=null. Cascades to any comment threads linked to the issue.",
    ),
});

export const addIssueCommentEditSchema = z.object({
  issue_id: z.string(),
  file_path: z.string(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  diff_side: z.enum(["old", "new"]).default("new"),
  body: z.string(),
});

export const updateIssueCommentSchema = z.object({
  thread_message_id: z.string().describe("thread_messages.id of the comment to update."),
  body: z.string().describe("New markdown body."),
});

export const deleteIssueCommentSchema = z.object({
  thread_message_id: z
    .string()
    .describe(
      "thread_messages.id of the comment to delete. If this was the only message on the thread, the thread is also removed. Rejected if the parent issue has submittedAt!=null.",
    ),
});

// ── Type exports ────────────────────────────────────────────────────────────

export type GetWalkthroughForEditInput = z.infer<typeof getWalkthroughForEditSchema>;
export type UpdateOverviewInput = z.infer<typeof updateOverviewSchema>;
export type AddSemanticStepEditInput = z.infer<typeof addSemanticStepEditSchema>;
export type UpdateSemanticStepInput = z.infer<typeof updateSemanticStepSchema>;
export type DeleteSemanticStepInput = z.infer<typeof deleteSemanticStepSchema>;
export type AddBlockInput = z.infer<typeof addBlockSchema>;
export type UpdateBlockInput = z.infer<typeof updateBlockSchema>;
export type DeleteBlockInput = z.infer<typeof deleteBlockSchema>;
export type UpdateSentimentInput = z.infer<typeof updateSentimentSchema>;
export type UpdateRatingInput = z.infer<typeof updateRatingSchema>;
export type DeleteRatingInput = z.infer<typeof deleteRatingSchema>;
export type AddIssueEditInput = z.infer<typeof addIssueEditSchema>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;
export type DeleteIssueInput = z.infer<typeof deleteIssueSchema>;
export type AddIssueCommentEditInput = z.infer<typeof addIssueCommentEditSchema>;
export type UpdateIssueCommentInput = z.infer<typeof updateIssueCommentSchema>;
export type DeleteIssueCommentInput = z.infer<typeof deleteIssueCommentSchema>;

export type BlockContentInput = z.infer<typeof blockContentSchema>;
