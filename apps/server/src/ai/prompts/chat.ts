/// <reference path="../../assets.d.ts" />
// Right-pane chat. The agent runs inside the PR's git worktree with write
// access so it can propose fixes as real commits on a working branch.
//
// The system prompt goes out only on a fresh ACP session; a resumed session
// already holds it.

import CHAT_RESOLVE_BASE_MERGE_TEMPLATE from "./chat-resolve-base-merge.md" with { type: "text" };
import CHAT_RESOLVE_BASE_REBASE_TEMPLATE from "./chat-resolve-base-rebase.md" with { type: "text" };
import CHAT_RESOLVE_CONFLICTS_TEMPLATE from "./chat-resolve-conflicts.md" with { type: "text" };
import CHAT_SYSTEM_TEMPLATE from "./chat-system.md" with { type: "text" };
import { fillTemplate } from "./fill-template";
import { WALKTHROUGH_ARTIFACT_SPEC } from "./walkthrough";

const ARTIFACT_SPEC_MARKER = "{{ARTIFACT_SPEC}}";
if (!CHAT_SYSTEM_TEMPLATE.includes(ARTIFACT_SPEC_MARKER)) {
  throw new Error(`chat-system.md is missing the ${ARTIFACT_SPEC_MARKER} marker`);
}

export interface ChatWalkthroughIssue {
  readonly severity: string; // 'info' | 'warning' | 'critical'
  readonly title: string;
  readonly description: string;
  readonly filePath?: string | null;
  readonly startLine?: number | null;
  readonly endLine?: number | null;
}

export interface ChatWalkthroughContext {
  readonly summary: string;
  readonly riskLevel: string;
  readonly sentiment: string | null;
  readonly issues: ReadonlyArray<ChatWalkthroughIssue>;
}

export interface ChatPrContext {
  readonly title: string;
  readonly body: string | null;
  readonly sourceBranch: string;
  readonly targetBranch: string;
}

export interface ChatSystemPromptParams {
  readonly pr: ChatPrContext;
  readonly walkthrough?: ChatWalkthroughContext | null;
  readonly branchName: string;
}

export function buildChatSystemPrompt(params: ChatSystemPromptParams): string {
  const prLines: string[] = [];
  prLines.push("## Pull Request");
  prLines.push(`**Title:** ${params.pr.title}`);
  prLines.push(`**Branch:** \`${params.pr.sourceBranch}\` → \`${params.pr.targetBranch}\``);
  if (params.pr.body?.trim()) {
    prLines.push("");
    prLines.push("**Description:**");
    prLines.push(params.pr.body.trim());
  }
  const prSection = prLines.join("\n");

  let walkthroughSection = "";
  if (params.walkthrough) {
    const wt = params.walkthrough;
    const wtLines: string[] = [];
    wtLines.push("## Walkthrough Analysis");
    wtLines.push(`**Risk Level:** ${wt.riskLevel}`);
    if (wt.summary.trim()) {
      wtLines.push("");
      wtLines.push("**Summary:**");
      wtLines.push(wt.summary.trim());
    }
    if (wt.sentiment?.trim()) {
      wtLines.push("");
      wtLines.push("**Overall Sentiment:**");
      wtLines.push(wt.sentiment.trim());
    }
    if (wt.issues.length > 0) {
      wtLines.push("");
      wtLines.push("**Issues Found:**");
      for (const issue of wt.issues) {
        const where = issue.filePath
          ? issue.startLine != null
            ? ` — \`${issue.filePath}:${issue.startLine}${
                issue.endLine != null && issue.endLine !== issue.startLine
                  ? `–${issue.endLine}`
                  : ""
              }\``
            : ` — \`${issue.filePath}\``
          : "";
        wtLines.push(
          `- [${issue.severity.toUpperCase()}]${where} **${issue.title}**: ${issue.description}`,
        );
      }
    }
    walkthroughSection = wtLines.join("\n");
  }

  // No walkthrough: the section goes, blank line and all.
  const template = walkthroughSection
    ? CHAT_SYSTEM_TEMPLATE
    : CHAT_SYSTEM_TEMPLATE.replace("\n\n{{WALKTHROUGH_SECTION}}", "");
  let prompt = fillTemplate(template, {
    PR_SECTION: prSection,
    BRANCH_NAME: params.branchName,
    ARTIFACT_SPEC: WALKTHROUGH_ARTIFACT_SPEC,
    WALKTHROUGH_SECTION: walkthroughSection,
  });

  prompt = prompt.replace(/\n{3,}/g, "\n\n");

  return prompt;
}

/**
 * Mirrors `ChatTimelineEntry` from `services/ChatSession`, declared locally so
 * this prompt module stays free of service-layer imports.
 */
export type ChatHistoryEntry =
  | {
      readonly entryKind: "message";
      readonly role: "user" | "assistant";
      readonly content: string;
    }
  | {
      readonly entryKind: "activity";
      readonly activityKind: string;
      readonly toolName: string | null;
      readonly summary: string;
    };

export interface ChatUserMessageParams {
  readonly message: string;
  /**
   * Persisted timeline of the session in sequence order, NOT including the
   * message being sent this turn. Replayed into the prompt so the agent sees
   * the transcript when native session resume isn't available.
   */
  readonly history?: ReadonlyArray<ChatHistoryEntry>;
}

export function buildChatUserMessage(params: ChatUserMessageParams): string {
  const history = params.history ?? [];
  if (history.length === 0) return params.message;

  const lines: string[] = ["## Conversation history", ""];
  for (const entry of history) {
    if (entry.entryKind === "message") {
      const role = entry.role === "user" ? "User" : "Assistant";
      const body = entry.content.trim();
      if (body.length === 0) continue;
      lines.push(`**${role}:**`);
      lines.push(body);
      lines.push("");
    } else {
      const tool = entry.toolName ? ` (${entry.toolName})` : "";
      lines.push(`_[${entry.activityKind}${tool}]_ ${entry.summary}`);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("");
  lines.push("## Current message");
  lines.push("");
  lines.push(params.message);
  return lines.join("\n");
}

/**
 * What a one-shot conflict-resolve run is resolving:
 *   push-merge  — the chat agent's branch merged into the PR's source branch
 *                 (the chat panel's "Push" hit a conflict);
 *   base-merge  — the PR's target branch merged into the PR branch;
 *   base-rebase — the PR branch replayed onto its target branch.
 */
export type ResolveConflictsTask =
  | { readonly kind: "push-merge"; readonly agentBranch: string; readonly sourceBranch: string }
  | { readonly kind: "base-merge"; readonly baseBranch: string; readonly sourceBranch: string }
  | { readonly kind: "base-rebase"; readonly baseBranch: string; readonly sourceBranch: string };

/**
 * One-shot and non-conversational: NOT persisted into the chat session — see
 * {@link AiService.resolveMergeConflict}.
 */
export function buildResolveConflictsPrompt(
  task: ResolveConflictsTask,
  conflictFiles: ReadonlyArray<string>,
): string {
  const fileLines =
    conflictFiles.length === 0
      ? "_(no specific files listed — check `git status` to find them)_"
      : conflictFiles.map((f) => `- \`${f}\``).join("\n");

  if (task.kind === "push-merge") {
    return fillTemplate(CHAT_RESOLVE_CONFLICTS_TEMPLATE, {
      AGENT_BRANCH: task.agentBranch,
      SOURCE_BRANCH: task.sourceBranch,
      CONFLICT_FILES: fileLines,
    });
  }
  return fillTemplate(
    task.kind === "base-merge"
      ? CHAT_RESOLVE_BASE_MERGE_TEMPLATE
      : CHAT_RESOLVE_BASE_REBASE_TEMPLATE,
    {
      BASE_BRANCH: task.baseBranch,
      SOURCE_BRANCH: task.sourceBranch,
      CONFLICT_FILES: fileLines,
    },
  );
}

export function buildResolveConflictsUserMessage(task: ResolveConflictsTask): string {
  return task.kind === "base-rebase"
    ? "Resolve the rebase conflicts described in your system prompt, continuing the rebase until it completes."
    : "Resolve the merge conflicts described in your system prompt, then run `git merge --continue`.";
}
