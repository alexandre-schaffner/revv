// The chat-edit tool surface (CLAUDE.md invariant 7), served to the in-app
// chat through `chat-mcp-tools.ts` and to external agents through
// `external-review-tools.ts`.

import { SENTIMENT_CONTRACT_SHORT } from "../../prompts/review-copy-contract";
import { defineTool } from "../mcp-tool-gateway";
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
import type { ChatWalkthroughEditContext } from "./spec";
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

export type { ChatWalkthroughEditContext } from "./spec";

const tool = defineTool<ChatWalkthroughEditContext>();

export const getWalkthroughForEditTool = tool({
  name: "get_walkthrough_for_edit",
  access: "read",
  description:
    "Read-only. Returns the full editable walkthrough state — walkthroughId, summary, risk, sentiment, every chapter + block + issue + comment + axis rating — plus a `validation` block. Call this FIRST before any edit so you have exact targeting keys (semantic_step_index, step_index, issue_id, axis, thread_message_id). The target is always the latest `status='complete'` walkthrough for this PR.",
  inputSchema: getWalkthroughForEditSchema,
  handler: getWalkthroughForEditHandler,
});

export const updateOverviewTool = tool({
  name: "update_overview",
  access: "write",
  description:
    "Update the walkthrough's summary and/or risk_level. Partial — supply one or both. Walkthrough stays status='complete'.",
  inputSchema: updateOverviewSchema,
  handler: updateOverviewHandler,
});

const addSemanticStepTool = tool({
  name: "add_semantic_step",
  access: "write",
  description:
    "Insert a new chapter (semantic step) into the walkthrough. Requires a free semantic_step_index, a title, and exactly one initial_block. Gaps in the index sequence are allowed (e.g. 0,1,3 → can insert 2 or 99).",
  inputSchema: addSemanticStepEditSchema,
  handler: addSemanticStepEditHandler,
});

export const updateSemanticStepTool = tool({
  name: "update_semantic_step",
  access: "write",
  description:
    "Update a chapter's title and/or summary. Chapter must already exist. Partial — at least one of title/summary required.",
  inputSchema: updateSemanticStepSchema,
  handler: updateSemanticStepHandler,
});

const deleteSemanticStepTool = tool({
  name: "delete_semantic_step",
  access: "write",
  description:
    "Delete a chapter and all its blocks. Rejected if any block is the only reference for a warning/critical issue (delete those issues first), or if any referencing issue has been pushed to GitHub.",
  inputSchema: deleteSemanticStepSchema,
  handler: deleteSemanticStepHandler,
});

const addBlockTool = tool({
  name: "add_block",
  access: "write",
  description:
    "Insert an atomic block (markdown/code/diff) into an existing chapter. `step_index` defaults to MAX(step_index)+1 inside the chapter; supply it explicitly to insert at a specific position (rejected on collision).",
  inputSchema: addBlockSchema,
  handler: addBlockHandler,
});

export const updateBlockTool = tool({
  name: "update_block",
  access: "write",
  description:
    "Replace an existing block's content. Same content shape as add_block; the block at (semantic_step_index, step_index) must already exist.",
  inputSchema: updateBlockSchema,
  handler: updateBlockHandler,
});

const deleteBlockTool = tool({
  name: "delete_block",
  access: "write",
  description:
    "Delete a single block. Rejected if it is the only reference for a warning/critical issue, or if any referencing issue has been pushed to GitHub.",
  inputSchema: deleteBlockSchema,
  handler: deleteBlockHandler,
});

export const updateSentimentTool = tool({
  name: "update_sentiment",
  access: "write",
  description: `Replace the 'Overall Sentiment' markdown. ${SENTIMENT_CONTRACT_SHORT}`,
  inputSchema: updateSentimentSchema,
  handler: updateSentimentHandler,
});

export const updateRatingTool = tool({
  name: "update_rating",
  access: "write",
  description:
    "Update an existing axis rating (verdict, confidence, rationale, details, citations, block_refs). Partial — only supplied fields are written.",
  inputSchema: updateRatingSchema,
  handler: updateRatingHandler,
});

const deleteRatingTool = tool({
  name: "delete_rating",
  access: "write",
  description:
    "Remove the rating row for an axis. Does NOT regress lastCompletedPhase — the walkthrough's status stays 'complete'. `validation.passesCompletenessGate` reads false on the next get_walkthrough_for_edit call; chat edits cannot re-add the axis.",
  inputSchema: deleteRatingSchema,
  handler: deleteRatingHandler,
});

const addIssueTool = tool({
  name: "add_issue",
  access: "write",
  description:
    "Add a new flagged issue. Same shape as the generation flag_issue tool — severity, title, description, block_refs (must reference existing blocks), file_path/start_line/end_line. Refused if an issue with the same (title, file, start_line) already exists; use update_issue with that issue_id instead.",
  inputSchema: addIssueEditSchema,
  handler: addIssueEditHandler,
});

export const updateIssueTool = tool({
  name: "update_issue",
  access: "write",
  description:
    "Update fields on an existing issue, keyed by issue_id. Partial — any subset of severity/title/description/block_refs/file_path/start_line/end_line. The issue_id is preserved even when canonicalizing fields change. Rejected if the issue has been pushed to GitHub.",
  inputSchema: updateIssueSchema,
  handler: updateIssueHandler,
});

const deleteIssueTool = tool({
  name: "delete_issue",
  access: "write",
  description:
    "Delete an issue and cascade-delete any comment threads linked to it. Rejected if the issue has been pushed to GitHub.",
  inputSchema: deleteIssueSchema,
  handler: deleteIssueHandler,
});

const addIssueCommentTool = tool({
  name: "add_issue_comment",
  access: "write",
  description:
    "Add a line-anchored inline comment to an existing issue. Same shape as the generation add_issue_comment tool. Idempotent on the deterministic anchor (issue_id + file + line range + diff_side) — a retry replaces the body.",
  inputSchema: addIssueCommentEditSchema,
  handler: addIssueCommentEditHandler,
});

const updateIssueCommentTool = tool({
  name: "update_issue_comment",
  access: "write",
  description:
    "Replace the body of an existing AI-authored issue comment. Rejected if the parent issue has been pushed to GitHub.",
  inputSchema: updateIssueCommentSchema,
  handler: updateIssueCommentHandler,
});

const deleteIssueCommentTool = tool({
  name: "delete_issue_comment",
  access: "write",
  description:
    "Delete an AI-authored issue comment. If it was the last message in its thread, the thread is removed too. Rejected if the parent issue has been pushed to GitHub.",
  inputSchema: deleteIssueCommentSchema,
  handler: deleteIssueCommentHandler,
});

export const EDIT_TOOL_SPECS = [
  getWalkthroughForEditTool,
  updateOverviewTool,
  addSemanticStepTool,
  updateSemanticStepTool,
  deleteSemanticStepTool,
  addBlockTool,
  updateBlockTool,
  deleteBlockTool,
  updateSentimentTool,
  updateRatingTool,
  deleteRatingTool,
  addIssueTool,
  updateIssueTool,
  deleteIssueTool,
  addIssueCommentTool,
  updateIssueCommentTool,
  deleteIssueCommentTool,
];
