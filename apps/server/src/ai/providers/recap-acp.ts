// Project-recap generation over the turn runner. All recap content (lede,
// entries, theme summaries) is written by the shared MCP tool handlers behind
// `/mcp/recap`, which also report each tool call as an activity. The agent's
// own session updates supply reasoning (`thought` events and a heartbeat) and
// pills for its built-in tools.

import type { RecapStreamEvent } from "@revv/shared";
import { logError } from "../../logger";
import type { AgentLaunch } from "../acp/agent-launch";
import type { ActivityBeacon } from "../acp/run-turn";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
import { type McpAgentAcpResult, runMcpAgentViaAcp } from "./mcp-agent-acp";
import { createRecapDispatchState, dispatchRecapStreamEvent } from "./recap-event-dispatch";
import type { RecapToolContext } from "./recap-tools";
import { RECAP_MCP_SERVER } from "./recap-tools";

export interface RunRecapAgentAcpParams {
  readonly ctx: RecapToolContext;
  /** Bearer token the orchestrator issued for `ctx` on `/mcp/recap`. */
  readonly sessionToken: string;
  readonly launch: AgentLaunch;
  /** Working dir the ACP connection is pooled under (repo clone path / server cwd). */
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly activity: ActivityBeacon;
  readonly calledAnyTool: () => boolean;
  /** True once `complete_recap` passed during this run. */
  readonly isValidated: () => boolean;
}

export async function runRecapAgentViaAcp(
  params: RunRecapAgentAcpParams,
): Promise<McpAgentAcpResult> {
  const userMessage = `${RECAP_SYSTEM_PROMPT}\n\n---\n\n${buildRecapUserMessage(
    params.ctx.sourceBundle,
    params.ctx.priorRecaps,
  )}`;

  const dispatchState = createRecapDispatchState();
  const fanOut = (event: RecapStreamEvent): void => {
    if (params.isValidated()) return;
    try {
      params.ctx.emit(event);
    } catch (err) {
      logError(
        "recap-acp",
        `ctx.emit threw for event type=${event.type}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  const onAgentEvent = (ev: NormalizedAgentEvent): void =>
    dispatchRecapStreamEvent(ev, dispatchState, fanOut);
  const decodeState = makeAcpDecodeState();

  const outcome = await runMcpAgentViaAcp({
    launch: params.launch,
    workingDir: params.workingDir,
    abortController: params.abortController,
    activity: params.activity,
    traceKey: params.ctx.recapId,
    route: "/mcp/recap",
    mcpServerName: `${RECAP_MCP_SERVER}-${params.ctx.recapId}`,
    sessionToken: params.sessionToken,
    prompt: userMessage,
    calledAnyTool: params.calledAnyTool,
    isValidated: params.isValidated,
    debugLabel: "recap-acp",
    onSessionUpdate: (update) => {
      for (const ev of decodeAcpSessionUpdate(update, decodeState)) onAgentEvent(ev);
    },
  });
  if (outcome.noToolCalls && outcome.error) {
    params.ctx.emit({ type: "error", data: { code: "NoToolCalls", message: outcome.error } });
  }
  return outcome;
}
