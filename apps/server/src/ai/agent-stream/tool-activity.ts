// ── Tool-call activities ─────────────────────────────────────────────────────
//
// How an agent's tool call reads in the chat timeline and the walkthrough
// exploration feed: canonical name, kind, one-line summary, and an input whose
// paths are relative to the worktree.

import { isAbsolute, relative } from "node:path";
import type { ActivityKind } from "@revv/shared";
import { classifyTool, normalizeToolName, TOOL_PATH_INPUT_KEYS } from "@revv/shared";

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
function toRepoRelative(p: string, cwd?: string): string {
  if (!p || !cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}

function buildExplorationDescription(toolName: string, input: unknown, cwd?: string): string {
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

export interface BuiltActivity {
  readonly activityKind: ActivityKind;
  readonly toolName: string;
  readonly summary: string;
  readonly payload?: unknown;
  readonly callId?: string;
}

/**
 * Rewrite a tool input's path keys to repo-relative form when `cwd` is known,
 * so the persisted payload matches the (already relativized) summary, and so
 * the web file-peek can pass the path straight to `GET /api/prs/:id/repo-file`
 * (which resolves against the clone root, not an absolute worktree path).
 */
export function relativizeToolInput(input: unknown, cwd?: string): unknown {
  if (!cwd || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of TOOL_PATH_INPUT_KEYS) {
    const v = obj[key];
    if (typeof v !== "string") continue;
    const rel = toRepoRelative(v, cwd);
    if (rel === v) continue;
    next ??= { ...obj };
    next[key] = rel;
  }
  return next ?? input;
}

/**
 * Build a renderable Activity from a raw tool name + input. Composes
 * `normalizeToolName` (lowercase → canonical), `classifyTool`
 * (canonical → ActivityKind), and `buildExplorationDescription` (canonical +
 * input → user-friendly summary).
 *
 * Used by every provider that surfaces tool calls in the UI. Centralising
 * this means a future change to how we describe Bash commands or MCP tools
 * only needs to land in one place.
 *
 * `cwd` (the agent's working directory — the per-job git worktree) is optional:
 * when supplied, absolute path arguments are rendered relative to it so the
 * feed shows `apps/server/…` instead of the full `/Users/…/worktree/…` path.
 */
export function buildActivity(
  rawToolName: string,
  input: unknown,
  cwd?: string,
  callId?: string,
): BuiltActivity {
  const toolName = normalizeToolName(rawToolName);
  return {
    activityKind: classifyTool(toolName),
    toolName,
    summary: buildExplorationDescription(toolName, input, cwd),
    ...(input !== undefined ? { payload: relativizeToolInput(input, cwd) } : {}),
    ...(callId !== undefined ? { callId } : {}),
  };
}

/**
 * The agent's own tools, which ACP tags with a `kind` the decoder maps to
 * these names. An MCP tool call carries only a human title, so it never
 * matches: the MCP route, which knows the real tool name, reports those.
 */
const AGENT_BUILTIN_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Write", "Edit", "WebFetch"]);

export function isAgentBuiltinTool(toolName: string): boolean {
  return AGENT_BUILTIN_TOOLS.has(toolName);
}
