import type { StackBriefSnapshot } from "../../db/schema/stack-briefs";
import type { AgentLaunch } from "../acp/agent-launch";
import { buildStackBriefUserMessage, STACK_BRIEF_SYSTEM_PROMPT } from "../prompts/stack-brief";
import { type McpAgentAcpResult, runMcpAgentViaAcp } from "./mcp-agent-acp";
import type { StackBriefToolContext } from "./stack-brief-tools";
import { STACK_BRIEF_MCP_SERVER } from "./stack-brief-tools";

export interface RunStackBriefAcpParams {
  readonly ctx: StackBriefToolContext;
  readonly snapshot: StackBriefSnapshot;
  readonly sessionToken: string;
  readonly launch: AgentLaunch;
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly calledAnyTool: () => boolean;
  readonly isValidated: () => boolean;
}

export function runStackBriefAgentViaAcp(
  params: RunStackBriefAcpParams,
): Promise<McpAgentAcpResult> {
  return runMcpAgentViaAcp({
    launch: params.launch,
    workingDir: params.workingDir,
    abortController: params.abortController,
    route: "/mcp/stack-brief",
    mcpServerName: `${STACK_BRIEF_MCP_SERVER}-${params.ctx.briefId}`,
    sessionToken: params.sessionToken,
    prompt: `${STACK_BRIEF_SYSTEM_PROMPT}\n\n---\n\n${buildStackBriefUserMessage(params.snapshot)}`,
    calledAnyTool: params.calledAnyTool,
    isValidated: params.isValidated,
    debugLabel: "stack-brief-acp",
  });
}
