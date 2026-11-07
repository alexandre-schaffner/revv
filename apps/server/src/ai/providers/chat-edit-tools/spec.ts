// The chat-edit tools are the single path that may change a walkthrough after
// it completed (CLAUDE.md invariant 7). They never touch `status` or
// `lastCompletedPhase`; `runChatEdit` stamps `lastEditedAt` / `lastEditedBy`
// and publishes the edit.

import type {
  ExternalAgentProvider,
  ThreadEventMessage,
  WalkthroughStreamEvent,
} from "@revv/shared";
import { z } from "zod";
import type { Db } from "../../../db";
import {
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

/**
 * Stamped on `walkthroughs.lastEditedBy`: in-app chat, or the external coding
 * agent that authored the edit.
 */
export type ChatEditActor = "chat:acp" | ExternalAgentProvider;

export interface ChatWalkthroughEditContext {
  readonly db: Db;
  /** Edits target the PR's newest complete walkthrough, resolved per call. */
  readonly prId: string;
  readonly actor: ChatEditActor;
  /** After the commit: `lifecycle:edited`, then `events`, then a team-cache push. */
  readonly publishEdit: (walkthroughId: string, events: readonly WalkthroughStreamEvent[]) => void;
  /** After the commit, for edits to `comment_threads` / `thread_messages`. */
  readonly broadcastThreadEvent: (msg: ThreadEventMessage) => void;
}

export type ChatEditToolResult = McpToolResult;

export type ChatEditToolHandler<TInput> = (
  ctx: ChatWalkthroughEditContext,
  input: TInput,
) => Promise<ChatEditToolResult>;

export type ChatEditToolSpecRecord = GatewayToolSpec<
  ChatWalkthroughEditContext,
  ChatEditToolResult
>;

/** Exactly one variant, as `add_diff_step` takes it. */
export const blockContentSchema = z
  .object({
    markdown: z
      .object({ content: z.string() })
      .nullable()
      .optional()
      .describe(
        `Use for narrative/explanatory content, budget 150 WORDS. Mutually exclusive with \`code\`, \`diff\`, and \`artifact\`. ${PROSE_VOICE_CONTRACT}`,
      ),
    code: codeBlockSchema
      .nullable()
      .optional()
      .describe(
        "Use for source-code excerpts. Mutually exclusive with `markdown`, `diff`, and `artifact`.",
      ),
    diff: diffBlockSchema
      .nullable()
      .optional()
      .describe(
        "Use for unified-diff hunks. Mutually exclusive with `markdown`, `code`, and `artifact`.",
      ),
    artifact: artifactBlockField,
  })
  .describe(
    "REQUIRED. Exactly one of { markdown, code, diff, artifact } — the same shape add_diff_step uses.",
  );

/**
 * Appended to every `semantic_step_index` that targets an existing chapter.
 * The user reads "Chapter 2" off the UI; the index behind it is usually 1, or
 * anything after a delete left a gap.
 */
const CHAPTER_INDEX_NOTE =
  "This is NOT the chapter number the user sees in the UI: map the user's 'chapter N' through `chapterNumber` in get_walkthrough_for_edit (the Overview is chapter 0, the walkthrough summary).";

export const getWalkthroughForEditSchema = z.object({});

export const updateOverviewSchema = z.object({
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      `New PR summary. ${SUMMARY_CONTRACT} ${PROSE_VOICE_CONTRACT} Omit (or send null) to leave the existing summary unchanged.`,
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
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      "Index at which to insert the new chapter. Must NOT already exist — call get_walkthrough_for_edit first to pick a free index. Gaps are allowed (e.g. existing indices 0,1,3 → you can insert 2, 4, 99 etc.).",
    ),
  title: z.string().min(1).describe(`Chapter title (≤ ~60 chars). ${PLAIN_TEXT_FIELD}`),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe("Optional 1–2 sentence prelude rendered under the title."),
  initial_block: blockContentSchema,
});

export const updateSemanticStepSchema = z.object({
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(`Existing chapter to update — must already exist. ${CHAPTER_INDEX_NOTE}`),
  title: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(`New chapter title. Omit / null to leave unchanged. ${PLAIN_TEXT_FIELD}`),
  summary: z
    .string()
    .nullable()
    .optional()
    .describe(
      "New chapter summary. Omit to leave unchanged; send null explicitly to clear an existing summary.",
    ),
});

export const deleteSemanticStepSchema = z.object({
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      `Chapter to remove. Cascades to all blocks inside the chapter. Rejected if any block in the chapter is the only blockId on a warning/critical issue, or if any affected issue has been pushed to GitHub (submittedAt!=null) — delete those issues first. ${CHAPTER_INDEX_NOTE}`,
    ),
});

export const addBlockSchema = z.object({
  semantic_step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe(
      `Index of the parent chapter — must already exist. Use update_semantic_step or add_semantic_step first if you need a new chapter. ${CHAPTER_INDEX_NOTE}`,
    ),
  step_index: z.coerce
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
  semantic_step_index: z.coerce.number().int().nonnegative().describe(CHAPTER_INDEX_NOTE),
  step_index: z.coerce
    .number()
    .int()
    .nonnegative()
    .describe("Position of the existing block within its chapter. Must already exist."),
  content: blockContentSchema,
});

export const deleteBlockSchema = z.object({
  semantic_step_index: z.coerce.number().int().nonnegative(),
  step_index: z.coerce
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
      `New Overall Sentiment markdown, replacing the current sentiment in full. ${SENTIMENT_CONTRACT} ${PROSE_VOICE_CONTRACT}`,
    ),
});

export const updateRatingSchema = z.object({
  axis: ratingAxisSchema.describe(
    "Axis to update. Must already have a rating row — use get_walkthrough_for_edit to confirm.",
  ),
  verdict: verdictSchema
    .nullable()
    .optional()
    .describe("New verdict. Omit/null to leave unchanged."),
  confidence: confidenceSchema
    .nullable()
    .optional()
    .describe("New confidence. Omit/null to leave unchanged."),
  rationale: z
    .string()
    .nullable()
    .optional()
    .describe(
      `New rationale, 1–2 sentences and 35 words. Omit/null to leave unchanged. ${PROSE_VOICE_CONTRACT}`,
    ),
  details: z
    .string()
    .nullable()
    .optional()
    .describe(
      `New markdown details, 80 words. Omit/null to leave unchanged. ${PROSE_VOICE_CONTRACT}`,
    ),
  citations: z
    .array(citationSchema)
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
    "Axis whose rating row should be removed. Does NOT regress lastCompletedPhase — the walkthrough's `status` stays 'complete' with the axis missing, and `get_walkthrough_for_edit` reports `validation.passesCompletenessGate: false` from then on. Chat edits cannot re-add a deleted rating; only a regenerate does.",
  ),
});

export const addIssueEditSchema = z.object({
  severity: severitySchema.describe(severityCalibration("add_issue")),
  title: z.string().describe(`Short title of the concern (10 words max). ${PLAIN_TEXT_FIELD}`),
  description: z
    .string()
    .describe(`One-sentence label for the issues-list card (≤ ~15 words). ${PLAIN_TEXT_FIELD}`),
  block_refs: z
    .array(blockRefSchema)
    .min(1)
    .describe(
      "Composite identifiers of existing diff block(s) the issue is anchored to. Must reference blocks that already exist.",
    ),
  file_path: z.string().nullable(),
  start_line: z.coerce.number().int().nullable(),
  end_line: z.coerce.number().int().nullable(),
});

export const updateIssueSchema = z.object({
  issue_id: z.string().describe("Existing walkthrough_issues.id."),
  severity: severitySchema.describe(severityCalibration("add_issue")).nullable().optional(),
  title: z.string().nullable().optional().describe(`New title. ${PLAIN_TEXT_FIELD}`),
  description: z.string().nullable().optional().describe(`New description. ${PLAIN_TEXT_FIELD}`),
  block_refs: z.array(blockRefSchema).nullable().optional(),
  file_path: z.string().nullable().optional(),
  start_line: z.coerce.number().int().nullable().optional(),
  end_line: z.coerce.number().int().nullable().optional(),
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
  start_line: z.coerce.number().int(),
  end_line: z.coerce.number().int(),
  diff_side: z.enum(["old", "new"]).default("new"),
  body: z.string(),
});

export const updateIssueCommentSchema = z.object({
  thread_message_id: z.string().describe("thread_messages.id of the comment to update."),
  body: z.string().describe(`New markdown body. ${PROSE_VOICE_CONTRACT}`),
});

export const deleteIssueCommentSchema = z.object({
  thread_message_id: z
    .string()
    .describe(
      "thread_messages.id of the comment to delete. If this was the only message on the thread, the thread is also removed. Rejected if the parent issue has submittedAt!=null.",
    ),
});

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
