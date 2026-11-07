// Recap and stack brief: an agent turn whose whole output is MCP writes,
// judged by the job's own completion gate. ACP gives MCP tool calls only a
// human title, so "did the model call any tools?" is the MCP route's record
// (`calledAnyTool`), never the agent stream.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentFailureKind } from "../../domain/errors";
import { logError } from "../../logger";
import type { AgentLaunch } from "../acp/agent-launch";
import { projectlessAgentCwd } from "../acp/package-runner-dir";
import {
  type ActivityBeacon,
  JOB_TURN,
  runAcpTurn,
  type TurnMcpServer,
  type TurnSettle,
} from "../acp/run-turn";

export interface RunMcpAgentAcpParams {
  readonly launch: AgentLaunch;
  readonly abortController: AbortController;
  /** The job's liveness beacon; its MCP route notes every call it authenticates. */
  readonly activity: ActivityBeacon;
  /** Fired by the job's completion gate tool once it passes. */
  readonly settle: TurnSettle;
  /** The job id its trace anchor is published under, and the span attribute naming it. */
  readonly trace: { readonly key: string; readonly attribute: string };
  readonly mcp: TurnMcpServer;
  /** System prompt and user message in one: ACP has no separate system channel. */
  readonly prompt: string;
  readonly calledAnyTool: () => boolean;
  readonly debugLabel: string;
  readonly onSessionUpdate?: (update: SessionUpdate) => void;
}

/** Why the run produced nothing the journal can complete on, or null when it did its part. */
export type McpAgentRunError = {
  readonly kind: AgentFailureKind | "no_tool_calls";
  readonly message: string;
} | null;

export async function runMcpAgentViaAcp(params: RunMcpAgentAcpParams): Promise<McpAgentRunError> {
  const { launch } = params;
  const end = await runAcpTurn({
    label: params.debugLabel,
    launch,
    cwd: projectlessAgentCwd(),
    mcp: params.mcp,
    deadlines: JOB_TURN,
    activity: params.activity,
    signal: params.abortController.signal,
    settle: params.settle,
    trace: params.trace,
    prompt: () => [{ type: "text", text: params.prompt }],
    onUpdate: (update) => params.onSessionUpdate?.(update),
  });
  if (params.settle.settled()) return null;
  switch (end.kind) {
    case "settled":
      return null;
    case "stopped": {
      if (params.calledAnyTool()) return null;
      const message =
        `The model finished without calling any tools. This usually means the selected ` +
        `model (${launch.model}) does not support tool calling through the '${launch.agent}' ` +
        `ACP agent, or the provider is not configured for it.`;
      logError(params.debugLabel, message);
      return { kind: "no_tool_calls", message };
    }
    case "cancelled":
    case "timeout":
      logError(params.debugLabel, "run ended early:", end.reason);
      return { kind: "other", message: end.reason };
    case "not_configured":
      logError(params.debugLabel, end.message);
      return { kind: "other", message: end.message };
    case "failed":
      logError(params.debugLabel, "run failed:", end.failure.message);
      return { kind: end.failure.kind, message: end.failure.message };
  }
}
