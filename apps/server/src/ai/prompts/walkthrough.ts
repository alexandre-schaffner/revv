import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  type RatingAxis,
  REVIEW_MODE,
  type WalkthroughBlock,
  type WalkthroughMode,
} from "@revv/shared";
import type { PrFileMeta } from "../../services/GitHub";

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

const WALKTHROUGH_SYSTEM_COMMON_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-common.md`,
  "utf-8",
);
const WALKTHROUGH_SYSTEM_REVIEWER_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-reviewer.md`,
  "utf-8",
);
const WALKTHROUGH_SYSTEM_AUTHOR_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-system-author.md`,
  "utf-8",
);
const WALKTHROUGH_COMMON_PROMPT = readFileSync(`${import.meta.dir}/walkthrough-common.md`, "utf-8");
const WALKTHROUGH_REVIEWER_PROMPT = readFileSync(
  `${import.meta.dir}/walkthrough-reviewer.md`,
  "utf-8",
);
const WALKTHROUGH_AUTHOR_PROMPT = readFileSync(`${import.meta.dir}/walkthrough-author.md`, "utf-8");

// The common system prompt carries this marker where the perspective-specific
// block belongs (right after the intro, before the pipeline rules) so the mode
// prompt frames the whole document instead of trailing it. Validated at module
// load so a future edit that drops the marker fails fast rather than silently
// emitting a perspective-less system prompt.
const REVIEW_PERSPECTIVE_MARKER = "{{REVIEW_PERSPECTIVE}}";
if (!WALKTHROUGH_SYSTEM_COMMON_PROMPT.includes(REVIEW_PERSPECTIVE_MARKER)) {
  throw new Error(
    `walkthrough-system-common.md is missing the ${REVIEW_PERSPECTIVE_MARKER} marker`,
  );
}

export function buildWalkthroughSystemPrompt(mode: WalkthroughMode = REVIEW_MODE.reviewer): string {
  const modePrompt =
    mode === REVIEW_MODE.author
      ? WALKTHROUGH_SYSTEM_AUTHOR_PROMPT
      : WALKTHROUGH_SYSTEM_REVIEWER_PROMPT;

  return WALKTHROUGH_SYSTEM_COMMON_PROMPT.replace(REVIEW_PERSPECTIVE_MARKER, modePrompt.trim());
}

const WALKTHROUGH_SHARED_REVIEW_PRINCIPLES: string = readFileSync(
  `${import.meta.dir}/walkthrough-shared-review-principles.md`,
  "utf-8",
);

const WALKTHROUGH_INCREMENTAL_REFRESH_PROMPT: string = readFileSync(
  `${import.meta.dir}/walkthrough-incremental-refresh.md`,
  "utf-8",
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Render a tool's path argument relative to the agent's working directory
 * (the per-job git worktree). Agents are handed absolute worktree paths, so
 * the raw `file_path` is a long `/Users/…/worktree/apps/server/…` string that
 * clips in the narrow exploration feed. Relativizing against `cwd` yields the
 * familiar repo-relative form (`apps/server/…`). Falls back to the original
 * path when no `cwd` is supplied, the path isn't absolute (already relative,
 * e.g. Grep's `.`), or it resolves outside the worktree (so we never surface a
 * confusing `../../` escape).
 */
export function toRepoRelative(p: string, cwd?: string): string {
  if (!p || !cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}

export function buildExplorationDescription(
  toolName: string,
  input: unknown,
  cwd?: string,
): string {
  const inp = input as Record<string, unknown> | null | undefined;
  const str = (k: string): string => (typeof inp?.[k] === "string" ? (inp[k] as string) : "");
  const path = (k: string): string => toRepoRelative(str(k), cwd);
  switch (toolName) {
    case "Read":
      return `Reading ${path("file_path") || "file"}`;
    case "Grep":
      return `Searching for '${str("pattern")}' in ${path("path") || "codebase"}`;
    case "Glob":
      return `Finding files matching ${str("pattern") || "*"}`;
    case "LS":
      return `Listing ${path("path") || "."}`;
    case "Write":
      return `Wrote ${path("file_path") || "file"}`;
    case "Edit":
      return `Edited ${path("file_path") || "file"}`;
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
    mode?: WalkthroughMode;
    files: PrFileMeta[];
    reviewMode?: {
      readonly mode: "full" | "incremental";
      readonly parentWalkthroughId: string | null;
      readonly baseHeadSha: string | null;
      readonly headSha: string;
      readonly diffSource?: "full_pr" | "incremental_range" | "full_pr_fallback";
    };
  },
  maxTokenBudget = 40000,
  continuation?: PromptContinuationContext,
): string {
  const mode = params.mode ?? REVIEW_MODE.reviewer;
  const lines: string[] = [
    WALKTHROUGH_COMMON_PROMPT.trim(),
    "",
    mode === REVIEW_MODE.author
      ? WALKTHROUGH_AUTHOR_PROMPT.trim()
      : WALKTHROUGH_REVIEWER_PROMPT.trim(),
    "",
    `## Pull Request: ${params.pr.title}`,
    `Branch: ${params.pr.sourceBranch} → ${params.pr.targetBranch}`,
    mode === REVIEW_MODE.author
      ? "Review perspective: SELF-REVIEW — the reader is the PR's own author, reviewing their own changes before requesting (or continuing) human review. This is determined automatically by who is viewing; it is not a user-chosen mode."
      : "Review perspective: REVIEWER — the reader is a reviewer assessing a pull request authored by someone else. This is determined automatically by who is viewing; it is not a user-chosen mode.",
  ];
  if (params.pr.body) {
    lines.push("", "### Description", params.pr.body);
  }
  lines.push("", WALKTHROUGH_SHARED_REVIEW_PRINCIPLES);

  if (params.reviewMode?.mode === "incremental") {
    lines.push(
      "",
      WALKTHROUGH_INCREMENTAL_REFRESH_PROMPT,
      "",
      "### Incremental Range",
      `Previous reviewed head: ${params.reviewMode.baseHeadSha ?? "unknown"}`,
      `Current head: ${params.reviewMode.headSha}`,
      `Prior walkthrough id: ${params.reviewMode.parentWalkthroughId ?? "unknown"}`,
      `Diff input: ${
        params.reviewMode.diffSource === "full_pr_fallback"
          ? "full PR diff fallback because the incremental range could not be resolved locally"
          : params.reviewMode.diffSource === "incremental_range"
            ? "incremental range only"
            : "full PR diff"
      }`,
    );
  }

  // Commit history is intentionally NOT inlined here. The orchestrator
  // persists it on the walkthrough row at job start; the agent fetches it
  // lazily via the `get_commit_history` MCP read tool when it's about to
  // open the required "How we got here" journey chapter (chapter 0). This
  // keeps the prompt token-bounded on long PRs (up to 300 commits) and
  // resume reruns of the prompt cheap.

  const changedFilesHeading =
    params.reviewMode?.mode === "incremental"
      ? params.reviewMode.diffSource === "full_pr_fallback"
        ? "### Changed Files (full PR diff fallback — incremental range unavailable)"
        : "### Changed Files in Incremental Range (diff — prior reviewed head to current head)"
      : "### Changed Files (diff — you can read full file contents with your tools)";
  lines.push("", changedFilesHeading, "");

  if (params.files.length === 0) {
    lines.push(
      params.reviewMode?.mode === "incremental"
        ? "No files changed in the incremental range. Use the prior review state to confirm whether the current PR assessment still stands, then produce a concise updated report."
        : "No changed files were returned for this PR.",
      "",
    );
  }

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
    mode === REVIEW_MODE.author
      ? "2. Call `get_repo_context` once during Phase A. It returns recent daily/weekly project recaps for this repository. Use it only for risk patterns that are directly relevant to the current diff."
      : "2. Call `get_repo_context` once during Phase A. It returns recent daily/weekly project recaps for this repository, which let you ground your overview in what shipped recently, recurring themes, and risk patterns. Empty list = no prior context, proceed without. Do not cite recap themes unless directly relevant to this PR — no padding.",
  );

  if (continuation) {
    lines.push(
      "",
      "(Informational only — authoritative state lives in get_walkthrough_state. Provider hint: continuation context was provided; if your state query shows a resume scenario, follow the resume discipline in the system prompt.)",
    );
  }

  return lines.join("\n");
}
