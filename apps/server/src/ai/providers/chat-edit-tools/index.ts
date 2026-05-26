// ── chat-edit-tools ─────────────────────────────────────────────────────────
//
// Barrel that re-exports chat-edit helpers/handlers and assembles the
// canonical EDIT_TOOL_SPECS array consumed by chat-context.ts,
// chat-claude.ts, and chat-mcp-tools.ts.

import {
  addBlockHandler,
  addSemanticStepEditHandler,
  deleteBlockHandler,
  deleteSemanticStepHandler,
  updateBlockHandler,
  updateOverviewHandler,
  updateSemanticStepHandler,
  updateSentimentHandler,
} from "./content-handlers";
import { getWalkthroughForEditHandler } from "./read-handler";
import {
  addIssueCommentEditHandler,
  addIssueEditHandler,
  deleteIssueCommentHandler,
  deleteIssueHandler,
  deleteRatingHandler,
  updateIssueCommentHandler,
  updateIssueHandler,
  updateRatingHandler,
} from "./review-handlers";
import type { ChatEditToolSpec } from "./spec";
import {
  addBlockSchema,
  addIssueCommentEditSchema,
  addIssueEditSchema,
  addSemanticStepEditSchema,
  deleteBlockSchema,
  deleteIssueCommentSchema,
  deleteIssueSchema,
  deleteRatingSchema,
  deleteSemanticStepSchema,
  getWalkthroughForEditSchema,
  updateBlockSchema,
  updateIssueCommentSchema,
  updateIssueSchema,
  updateOverviewSchema,
  updateRatingSchema,
  updateSemanticStepSchema,
  updateSentimentSchema,
} from "./spec";

export { resolveActiveWalkthroughId } from "./helpers";
export type { ChatEditToolResult, ChatWalkthroughEditContext } from "./spec";

// ── Canonical spec list ─────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: heterogenous tool spec array
export const EDIT_TOOL_SPECS: Array<ChatEditToolSpec<any>> = [
  {
    name: "get_walkthrough_for_edit",
    description:
      "Read-only. Returns the full editable walkthrough state — walkthroughId, summary, risk, sentiment, every chapter + block + issue + comment + axis rating — plus a `validation` block. Call this FIRST before any edit so you have exact targeting keys (semantic_step_index, step_index, issue_id, axis, thread_message_id). The target is always the latest `status='complete'` walkthrough for this PR.",
    inputSchema: getWalkthroughForEditSchema,
    handler: getWalkthroughForEditHandler,
  },
  {
    name: "update_overview",
    description:
      "Update the walkthrough's summary and/or risk_level. Partial — supply one or both. Walkthrough stays status='complete'.",
    inputSchema: updateOverviewSchema,
    handler: updateOverviewHandler,
  },
  {
    name: "add_semantic_step",
    description:
      "Insert a new chapter (semantic step) into the walkthrough. Requires a free semantic_step_index, a title, and exactly one initial_block. Gaps in the index sequence are allowed (e.g. 0,1,3 → can insert 2 or 99).",
    inputSchema: addSemanticStepEditSchema,
    handler: addSemanticStepEditHandler,
  },
  {
    name: "update_semantic_step",
    description:
      "Update a chapter's title and/or summary. Chapter must already exist. Partial — at least one of title/summary required.",
    inputSchema: updateSemanticStepSchema,
    handler: updateSemanticStepHandler,
  },
  {
    name: "delete_semantic_step",
    description:
      "Delete a chapter and all its blocks. Rejected if any block is the only reference for a warning/critical issue (delete those issues first), or if any referencing issue has been pushed to GitHub.",
    inputSchema: deleteSemanticStepSchema,
    handler: deleteSemanticStepHandler,
  },
  {
    name: "add_block",
    description:
      "Insert an atomic block (markdown/code/diff) into an existing chapter. `step_index` defaults to MAX(step_index)+1 inside the chapter; supply it explicitly to insert at a specific position (rejected on collision).",
    inputSchema: addBlockSchema,
    handler: addBlockHandler,
  },
  {
    name: "update_block",
    description:
      "Replace an existing block's content. Same content shape as add_block; the block at (semantic_step_index, step_index) must already exist.",
    inputSchema: updateBlockSchema,
    handler: updateBlockHandler,
  },
  {
    name: "delete_block",
    description:
      "Delete a single block. Rejected if it is the only reference for a warning/critical issue, or if any referencing issue has been pushed to GitHub.",
    inputSchema: deleteBlockSchema,
    handler: deleteBlockHandler,
  },
  {
    name: "update_sentiment",
    description: "Replace the 'Overall Sentiment' markdown. 2–4 sentences, direct verdict.",
    inputSchema: updateSentimentSchema,
    handler: updateSentimentHandler,
  },
  {
    name: "update_rating",
    description:
      "Update an existing axis rating (verdict, confidence, rationale, details, citations, block_refs). Partial — only supplied fields are written.",
    inputSchema: updateRatingSchema,
    handler: updateRatingHandler,
  },
  {
    name: "delete_rating",
    description:
      "Remove the rating row for an axis. Does NOT regress lastCompletedPhase — the walkthrough's status stays 'complete'. `validation.passesCompletenessGate` will surface false on the next get_walkthrough_for_edit call until a future tool re-adds an axis (not yet supported in v1).",
    inputSchema: deleteRatingSchema,
    handler: deleteRatingHandler,
  },
  {
    name: "add_issue",
    description:
      "Add a new flagged issue. Same shape as the generation flag_issue tool — severity, title, description, block_refs (must reference existing blocks), file_path/start_line/end_line. Refused if an issue with the same (title, file, start_line) already exists; use update_issue with that issue_id instead.",
    inputSchema: addIssueEditSchema,
    handler: addIssueEditHandler,
  },
  {
    name: "update_issue",
    description:
      "Update fields on an existing issue, keyed by issue_id. Partial — any subset of severity/title/description/block_refs/file_path/start_line/end_line. The issue_id is preserved even when canonicalizing fields change. Rejected if the issue has been pushed to GitHub.",
    inputSchema: updateIssueSchema,
    handler: updateIssueHandler,
  },
  {
    name: "delete_issue",
    description:
      "Delete an issue and cascade-delete any comment threads linked to it. Rejected if the issue has been pushed to GitHub.",
    inputSchema: deleteIssueSchema,
    handler: deleteIssueHandler,
  },
  {
    name: "add_issue_comment",
    description:
      "Add a line-anchored inline comment to an existing issue. Same shape as the generation add_issue_comment tool. Idempotent on the deterministic anchor (issue_id + file + line range + diff_side) — a retry replaces the body.",
    inputSchema: addIssueCommentEditSchema,
    handler: addIssueCommentEditHandler,
  },
  {
    name: "update_issue_comment",
    description:
      "Replace the body of an existing AI-authored issue comment. Rejected if the parent issue has been pushed to GitHub.",
    inputSchema: updateIssueCommentSchema,
    handler: updateIssueCommentHandler,
  },
  {
    name: "delete_issue_comment",
    description:
      "Delete an AI-authored issue comment. If it was the last message in its thread, the thread is removed too. Rejected if the parent issue has been pushed to GitHub.",
    inputSchema: deleteIssueCommentSchema,
    handler: deleteIssueCommentHandler,
  },
];

// The SDK adapter lives in chat-mcp-tools.ts (`createChatMcpServer`), which
// iterates the unified CHAT_TOOL_SPECS array (read + edit) and wraps each
// spec via the Claude SDK's `tool()` helper. The HTTP route in
// chat-context.ts dispatches off the same CHAT_TOOL_SPECS list. Both
// transports share one source of truth.
