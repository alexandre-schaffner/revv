import { createHash } from "node:crypto";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import type { WalkthroughTokenUsage } from "@revv/shared";
import { resolveCliBin } from "./cli-agent";

const CODEX_MCP_STARTUP_TIMEOUT_SEC = 30;

export type CodexMcpServers = Record<
  string,
  { url: string; http_headers: Record<string, string>; startup_timeout_sec: number }
>;

export interface CodexThreadParams {
  readonly workingDirectory: string;
  readonly model?: string | undefined;
  readonly sandboxMode: NonNullable<ThreadOptions["sandboxMode"]>;
  readonly approvalPolicy: NonNullable<ThreadOptions["approvalPolicy"]>;
  readonly modelReasoningEffort?: ThreadOptions["modelReasoningEffort"] | undefined;
  readonly mcpServers?: CodexMcpServers | undefined;
  readonly resumeThreadId?: string | undefined;
}

export function makeCodexMcpServer(url: string, token: string): CodexMcpServers[string] {
  return {
    url,
    http_headers: { Authorization: `Bearer ${token}` },
    startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
  };
}

/**
 * Codex SDK flattens config keys into dotted TOML paths, so MCP server names
 * must be safe bare-key segments. Revv ids often contain ":"; hash the suffix
 * rather than leaking raw ids into the config path.
 */
export function codexMcpServerName(prefix: string, scope?: string): string {
  if (!scope) return prefix;
  const digest = createHash("sha256").update(scope).digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

export function startCodexThread(params: CodexThreadParams) {
  const pinned = resolveCliBin("codex");
  const codex = new Codex({
    ...(pinned !== "codex" ? { codexPathOverride: pinned } : {}),
    ...(params.mcpServers ? { config: { mcp_servers: params.mcpServers } } : {}),
  });
  const threadOptions: ThreadOptions = {
    workingDirectory: params.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode: params.sandboxMode,
    approvalPolicy: params.approvalPolicy,
    ...(params.model ? { model: params.model } : {}),
    ...(params.modelReasoningEffort ? { modelReasoningEffort: params.modelReasoningEffort } : {}),
  };
  return params.resumeThreadId
    ? codex.resumeThread(params.resumeThreadId, threadOptions)
    : codex.startThread(threadOptions);
}

export function codexUsageRecord(
  usage: WalkthroughTokenUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens,
    cache_creation_input_tokens: usage.cacheCreationInputTokens,
  };
}
