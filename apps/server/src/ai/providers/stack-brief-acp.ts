// ─── stack-brief-acp ─────────────────────────────────────────────────────────
//
// ACP driver for the stack brief, on the session driver it shares with the
// recap (`mcp-agent-acp.ts`). Every piece of content reaches SQLite through
// the shared handlers behind `/mcp/stack-brief` (CLAUDE.md invariants 2 and
// 13); the agent's own session stream only keeps the idle deadline alive. The
// brief has no live stream: the UI learns of it through
// `stack-brief:status-changed` and re-reads the stack.

import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { buildStackBriefUserMessage, STACK_BRIEF_SYSTEM_PROMPT } from "../prompts/stack-brief";
import { type McpAgentAcpResult, runMcpAgentViaAcp } from "./mcp-agent-acp";
import type { StackBriefSnapshot, StackBriefToolContext } from "./stack-brief-tools";
import { STACK_BRIEF_MCP_SERVER } from "./stack-brief-tools";

export interface RunStackBriefAcpParams {
  readonly ctx: StackBriefToolContext;
  readonly snapshot: StackBriefSnapshot;
  /** Bearer the `/mcp/stack-brief` route resolves back to `ctx`. */
  readonly sessionToken: string;
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  /** Working dir the ACP connection is pooled under (repo clone / server cwd). */
  readonly workingDir: string;
  /**
   * Aborted by the job when `complete_stack_brief` validates, so the run
   * ends at the gate instead of waiting out the model's sign-off.
   */
  readonly abortController: AbortController;
  /** True once `complete_stack_brief` has validated; an abort after it is success. */
  readonly isValidated: () => boolean;
}

export function runStackBriefAgentViaAcp(
  params: RunStackBriefAcpParams,
): Promise<McpAgentAcpResult> {
  return runMcpAgentViaAcp({
    acpAgentId: params.acpAgentId,
    modelUsed: params.modelUsed,
    thinkingEffort: params.thinkingEffort,
    workingDir: params.workingDir,
    abortController: params.abortController,
    route: "/mcp/stack-brief",
    mcpServerName: `${STACK_BRIEF_MCP_SERVER}-${params.ctx.briefId}`,
    sessionToken: params.sessionToken,
    prompt: `${STACK_BRIEF_SYSTEM_PROMPT}\n\n---\n\n${buildStackBriefUserMessage(params.snapshot)}`,
    toolCalls: params.ctx.toolCalls,
    isValidated: params.isValidated,
    purpose: "the stack brief",
    debugLabel: "stack-brief-acp",
  });
}
