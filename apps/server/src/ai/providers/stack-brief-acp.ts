import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { buildStackBriefUserMessage, STACK_BRIEF_SYSTEM_PROMPT } from "../prompts/stack-brief";
import { type McpAgentAcpResult, runMcpAgentViaAcp } from "./mcp-agent-acp";
import type { StackBriefSnapshot, StackBriefToolContext } from "./stack-brief-tools";
import { STACK_BRIEF_MCP_SERVER } from "./stack-brief-tools";

export interface RunStackBriefAcpParams {
  readonly ctx: StackBriefToolContext;
  readonly snapshot: StackBriefSnapshot;
  readonly sessionToken: string;
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly calledAnyTool: () => boolean;
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
    calledAnyTool: params.calledAnyTool,
    isValidated: params.isValidated,
    purpose: "the stack brief",
    debugLabel: "stack-brief-acp",
  });
}
