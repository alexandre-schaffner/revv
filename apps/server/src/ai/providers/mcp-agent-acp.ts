// Recap and stack brief: an agent turn whose whole output is MCP writes,
// judged by the job's own completion gate. ACP gives MCP tool calls only a
// human title, so "did the model call any tools?" is the MCP route's record
// (`calledAnyTool`), never the agent stream.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { logError } from "../../logger";
import type { AgentLaunch } from "../acp/agent-launch";
import { type ActivityBeacon, JOB_TURN, runAcpTurn } from "../acp/run-turn";

export interface RunMcpAgentAcpParams {
  readonly launch: AgentLaunch;
  readonly workingDir: string;
  readonly abortController: AbortController;
  /** The job's liveness beacon; its MCP route notes every call it authenticates. */
  readonly activity: ActivityBeacon;
  /** The job id its trace anchor is published under. */
  readonly traceKey: string;
  readonly route: string;
  readonly mcpServerName: string;
  readonly sessionToken: string;
  /** System prompt and user message in one: ACP has no separate system channel. */
  readonly prompt: string;
  readonly calledAnyTool: () => boolean;
  readonly isValidated: () => boolean;
  readonly debugLabel: string;
  readonly onSessionUpdate?: (update: SessionUpdate) => void;
}

export interface McpAgentAcpResult {
  readonly validated: boolean;
  readonly noToolCalls?: boolean;
  readonly error?: string;
}

export async function runMcpAgentViaAcp(params: RunMcpAgentAcpParams): Promise<McpAgentAcpResult> {
  const { launch } = params;
  try {
    const { end } = await runAcpTurn({
      label: params.debugLabel,
      launch,
      cwd: params.workingDir,
      mcp: {
        route: params.route,
        name: params.mcpServerName,
        token: params.sessionToken,
        required: true,
      },
      deadlines: JOB_TURN,
      activity: params.activity,
      signal: params.abortController.signal,
      traceKey: params.traceKey,
      prompt: () => [{ type: "text", text: params.prompt }],
      onUpdate: (update) => params.onSessionUpdate?.(update),
    });
    // The completion gate aborts the turn on purpose once it passes.
    if (params.isValidated()) return { validated: true };
    if (end.kind !== "stopped") {
      logError(params.debugLabel, "run ended early:", end.reason);
      return { validated: false, error: end.reason };
    }
    if (!params.calledAnyTool()) {
      const error =
        `The model finished without calling any tools. This usually means the selected ` +
        `model (${launch.model}) does not support tool calling through the '${launch.agent}' ` +
        `ACP agent, or the provider is not configured for it.`;
      logError(params.debugLabel, error);
      return { validated: false, noToolCalls: true, error };
    }
    return { validated: false };
  } catch (err) {
    if (params.isValidated()) return { validated: true };
    const message = err instanceof Error ? err.message : String(err);
    logError(params.debugLabel, "run failed:", message);
    return { validated: false, error: message };
  }
}
