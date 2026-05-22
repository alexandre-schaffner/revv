import { readFileSync } from "node:fs";
import type { RatingAxis, WalkthroughBlock } from "@revv/shared";
import type { PrFileMeta } from "../../services/GitHub";
import { loadSkills } from "../skills/registry";

// ── Continuation context (imported here to avoid circular deps) ──────────────
//
// Retained for provider-level bookkeeping (e.g. opencode's session id for
// `--continue`). The agent itself no longer consumes this — per doctrine
// invariant #6, it calls `get_walkthrough_state` via MCP instead.

export interface PromptContinuationContext {
  walkthroughId: string;
  existingBlocks: WalkthroughBlock[];
  existingRatedAxes: RatingAxis[];
}

// ── MCP-based walkthrough prompt (phase-bound, A→B→C→D) ─────────────────────

export const WALKTHROUGH_MCP_SYSTEM_PROMPT: string =
  readFileSync(`${import.meta.dir}/walkthrough-system.md`, "utf-8") +
  "\n\n" +
  loadSkills(["beautiful-markdown"]);

// ── Helpers ─────────────────────────────────────────────────────────────────

export function buildExplorationDescription(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null | undefined;
  const str = (k: string): string => (typeof inp?.[k] === "string" ? (inp[k] as string) : "");
  switch (toolName) {
    case "Read":
      return `Reading ${str("file_path") || "file"}`;
    case "Grep":
      return `Searching for '${str("pattern")}' in ${str("path") || "codebase"}`;
    case "Glob":
      return `Finding files matching ${str("pattern") || "*"}`;
    case "LS":
      return `Listing ${str("path") || "."}`;
    case "Write":
      return `Wrote ${str("file_path") || "file"}`;
    case "Edit":
      return `Edited ${str("file_path") || "file"}`;
    case "Bash": {
      // Single-line, truncated. The first line of the command is enough
      // signal for the chat panel; full command is in the agent transcript.
      const cmd = str("command");
      if (!cmd) return "Running shell command";
      const firstLine = cmd.split("\n")[0] ?? cmd;
      const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
      return `$ ${truncated}`;
    }
    default:
      return `Using ${toolName}`;
  }
}

export function buildWalkthroughPrompt(
  params: {
    pr: {
      title: string;
      body: string | null;
      sourceBranch: string;
      targetBranch: string;
      url: string;
    };
    files: PrFileMeta[];
  },
  maxTokenBudget = 40000,
  continuation?: PromptContinuationContext,
): string {
  const lines: string[] = [
    `## Pull Request: ${params.pr.title}`,
    `Branch: ${params.pr.sourceBranch} → ${params.pr.targetBranch}`,
  ];
  if (params.pr.body) {
    lines.push("", "### Description", params.pr.body);
  }
  // Commit history is intentionally NOT inlined here. The orchestrator
  // persists it on the walkthrough row at job start; the agent fetches it
  // lazily via the `get_commit_history` MCP read tool when it's about to
  // open the required "How we got here" journey chapter (chapter 0). This
  // keeps the prompt token-bounded on long PRs (up to 300 commits) and
  // resume reruns of the prompt cheap.

  lines.push("", "### Changed Files (diff — you can read full file contents with your tools)", "");

  let approxTokens = 0;
  for (const file of params.files) {
    const header = `#### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})`;
    if (file.patch) {
      const patchTokens = file.patch.length / 4;
      if (approxTokens + patchTokens > maxTokenBudget) {
        lines.push(header, "[PATCH OMITTED — context limit reached]", "");
        continue;
      }
      lines.push(header, "```diff", file.patch, "```", "");
      approxTokens += patchTokens;
    } else {
      lines.push(header, "[No patch available — binary or too large]", "");
    }
  }

  lines.push(
    "",
    "## First actions",
    "",
    "1. Call `get_walkthrough_state` before any other tool. The response will tell you whether this is a fresh run or a resume, and exactly which phase + steps are persisted. Use it to decide where to pick up. Never assume you are starting from scratch.",
    "2. Call `get_repo_context` once during Phase A. It returns recent daily/weekly project recaps for this repository, which let you ground your overview in what shipped recently, recurring themes, and risk patterns. Empty list = no prior context, proceed without. Do not cite recap themes unless directly relevant to this PR — no padding.",
  );

  if (continuation) {
    lines.push(
      "",
      "(Informational only — authoritative state lives in get_walkthrough_state. Provider hint: continuation context was provided; if your state query shows a resume scenario, follow the resume discipline in the system prompt.)",
    );
  }

  return lines.join("\n");
}
