// The agent's own tools, as one table: the ACP `kind` that names each, its
// canonical name, its activity kind, its one-line summary, and whether the
// walkthrough and recap exploration feeds show it. Everything here reads
// through the table, so the chat timeline and both feeds agree.

import { isAbsolute, relative } from "node:path";
import type { ToolKind } from "@agentclientprotocol/sdk";
import type { ActivityKind } from "@revv/shared";
import { TOOL_PATH_INPUT_KEYS } from "@revv/shared";

/**
 * Agents are handed absolute worktree paths, which clip in the narrow
 * exploration feed. A path outside the worktree is left absolute rather than
 * surfaced as a confusing `../../` escape.
 */
function toRepoRelative(p: string, cwd?: string): string {
  if (!p || !cwd || !isAbsolute(p)) return p;
  const rel = relative(cwd, p);
  if (!rel || rel.startsWith("..")) return p;
  return rel;
}

interface ToolInput {
  readonly str: (key: string) => string;
  /** A path key, relative to the worktree. */
  readonly path: (key: string) => string;
}

interface AgentTool {
  readonly kind: ActivityKind;
  /**
   * The exploration feeds show it. An MCP tool call never matches the table
   * (ACP gives it only a human title): the MCP route, which knows the real
   * tool name, reports those.
   */
  readonly exploration: boolean;
  readonly summary: (input: ToolInput) => string;
}

const AGENT_TOOLS = {
  Read: {
    kind: "tool.read",
    exploration: true,
    summary: (i) => `Reading ${i.path("file_path") || "file"}`,
  },
  Grep: {
    kind: "tool.grep",
    exploration: true,
    summary: (i) => `Searching for '${i.str("pattern")}' in ${i.path("path") || "codebase"}`,
  },
  Glob: {
    kind: "tool.glob",
    exploration: true,
    summary: (i) => `Finding files matching ${i.str("pattern") || "*"}`,
  },
  LS: { kind: "tool.ls", exploration: true, summary: (i) => `Listing ${i.path("path") || "."}` },
  Bash: {
    kind: "tool.bash",
    exploration: true,
    summary: (i) => {
      // The full command is in the agent transcript.
      const cmd = i.str("command");
      if (!cmd) return "Running shell command";
      const firstLine = cmd.split("\n")[0] ?? cmd;
      return `$ ${firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine}`;
    },
  },
  Write: {
    kind: "tool.write",
    exploration: true,
    summary: (i) => `Wrote ${i.path("file_path") || "file"}`,
  },
  Edit: {
    kind: "tool.edit",
    exploration: true,
    summary: (i) => `Edited ${i.path("file_path") || "file"}`,
  },
  WebFetch: { kind: "tool.other", exploration: true, summary: () => "Using WebFetch" },
  TodoRead: { kind: "tool.todo", exploration: false, summary: () => "Using TodoRead" },
  TodoWrite: { kind: "tool.todo", exploration: false, summary: () => "Using TodoWrite" },
} as const satisfies Record<string, AgentTool>;

type AgentToolName = keyof typeof AGENT_TOOLS;

/**
 * ACP carries no machine tool name (only a human `title` + a `kind` enum), but
 * the `rawInput` of adapters that wrap a known SDK (e.g. claude-agent-acp)
 * uses that SDK's parameter names, so a canonical name yields correct activity
 * icons and summaries.
 */
const TOOL_BY_ACP_KIND: Partial<Record<ToolKind, AgentToolName>> = {
  read: "Read",
  edit: "Edit",
  search: "Grep",
  execute: "Bash",
  delete: "Bash",
  move: "Bash",
  fetch: "WebFetch",
};

/** opencode titles its built-in tools in lowercase (`read`, `grep`, `list`, …). */
const TOOL_BY_LOWERCASE_NAME: ReadonlyMap<string, AgentToolName> = new Map([
  ...(Object.keys(AGENT_TOOLS) as AgentToolName[]).map(
    (name) => [name.toLowerCase(), name] as const,
  ),
  ["list", "LS"],
]);

/** The tool name for an ACP tool call: canonical when its `kind` names one, else its title. */
export function acpToolName(kind: ToolKind | undefined, title: string): string {
  return (kind && TOOL_BY_ACP_KIND[kind]) || title || "Tool";
}

function agentTool(rawName: string): { readonly name: string; readonly tool: AgentTool | null } {
  const name = TOOL_BY_LOWERCASE_NAME.get(rawName.toLowerCase());
  return name ? { name, tool: AGENT_TOOLS[name] } : { name: rawName, tool: null };
}

/** The agent's own exploration tools, which the walkthrough and recap feeds show. */
export function isExplorationTool(rawName: string): boolean {
  return agentTool(rawName).tool?.exploration ?? false;
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

export function buildActivity(
  rawToolName: string,
  input: unknown,
  cwd?: string,
  callId?: string,
): BuiltActivity {
  const { name, tool } = agentTool(rawToolName);
  const inp = input as Record<string, unknown> | null | undefined;
  const str = (k: string): string => (typeof inp?.[k] === "string" ? (inp[k] as string) : "");
  const fields: ToolInput = { str, path: (k) => toRepoRelative(str(k), cwd) };
  return {
    activityKind: tool?.kind ?? (name.startsWith("mcp__") ? "tool.mcp" : "tool.other"),
    toolName: name,
    summary: tool?.summary(fields) ?? `Using ${name}`,
    ...(input !== undefined ? { payload: relativizeToolInput(input, cwd) } : {}),
    ...(callId !== undefined ? { callId } : {}),
  };
}
