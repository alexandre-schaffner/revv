import type { StackBriefSnapshot } from "../../db/schema/stack-briefs";
import type { AgentLaunch } from "../acp/agent-launch";
import type { ActivityBeacon, TurnSettle } from "../acp/run-turn";
import { buildStackBriefUserMessage, STACK_BRIEF_SYSTEM_PROMPT } from "../prompts/stack-brief";
import { type McpAgentRunError, runMcpAgentViaAcp } from "./mcp-agent-acp";
import type { StackBriefToolContext } from "./stack-brief-tools";
import { STACK_BRIEF_MCP_SERVER } from "./stack-brief-tools";

export interface RunStackBriefAcpParams {
  readonly ctx: StackBriefToolContext;
  readonly snapshot: StackBriefSnapshot;
  readonly sessionToken: string;
  readonly launch: AgentLaunch;
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly activity: ActivityBeacon;
  readonly calledAnyTool: () => boolean;
  /** Fired once `complete_stack_brief` passed during this run. */
  readonly completion: TurnSettle;
}

export function runStackBriefAgentViaAcp(
  params: RunStackBriefAcpParams,
): Promise<McpAgentRunError> {
  return runMcpAgentViaAcp({
    launch: params.launch,
    workingDir: params.workingDir,
    abortController: params.abortController,
    activity: params.activity,
    settle: params.completion,
    trace: { key: params.ctx.briefId, attribute: "briefId" },
    route: "/mcp/stack-brief",
    mcpServerName: `${STACK_BRIEF_MCP_SERVER}-${params.ctx.briefId}`,
    sessionToken: params.sessionToken,
    prompt: `${STACK_BRIEF_SYSTEM_PROMPT}\n\n---\n\n${buildStackBriefUserMessage(params.snapshot)}`,
    calledAnyTool: params.calledAnyTool,
    debugLabel: "stack-brief-acp",
  });
}
