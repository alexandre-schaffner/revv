// Project-recap generation over the turn runner. All recap content (lede,
// entries, theme summaries) is written by the shared MCP tool handlers behind
// `/mcp/recap`, which also report each tool call as an activity. The agent's
// own session updates supply reasoning (`thought` events and a heartbeat) and
// pills for its built-in tools.

import type { RecapStreamEvent } from "@revv/shared";
import { SPAN_ATTR } from "@revv/shared/telemetry";
import { logError } from "../../logger";
import type { AgentLaunch } from "../acp/agent-launch";
import { projectlessAgentCwd } from "../acp/package-runner-dir";
import type { ActivityBeacon, TurnSettle } from "../acp/run-turn";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { makeReasoningFeed } from "../agent-stream/reasoning-feed";
import { buildActivity, isExplorationTool } from "../agent-stream/tool-activity";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
import { type McpAgentRunError, runMcpAgentViaAcp } from "./mcp-agent-acp";
import { turnMcpServer } from "./mcp-tool-gateway";
import { RECAP_TOOL_BUNDLE, type RecapToolContext } from "./recap-tools";

export interface RunRecapAgentAcpParams {
  readonly ctx: RecapToolContext;
  /** Bearer token the orchestrator issued for `ctx` on `/mcp/recap`. */
  readonly sessionToken: string;
  readonly launch: AgentLaunch;
  readonly abortController: AbortController;
  readonly activity: ActivityBeacon;
  readonly calledAnyTool: () => boolean;
  /** Fired once `complete_recap` passed during this run. */
  readonly completion: TurnSettle;
}

export async function runRecapAgentViaAcp(
  params: RunRecapAgentAcpParams,
): Promise<McpAgentRunError> {
  const userMessage = `${RECAP_SYSTEM_PROMPT}\n\n---\n\n${buildRecapUserMessage(
    params.ctx.sourceBundle,
    params.ctx.priorRecaps,
  )}`;

  const fanOut = (event: RecapStreamEvent): void => {
    if (params.completion.settled()) return;
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
  const reasoning = makeReasoningFeed({
    thought: (text) => fanOut({ type: "thought", data: { text } }),
    heartbeat: () =>
      fanOut({ type: "phase", data: { phase: "analyzing", message: "Model is thinking…" } }),
  });
  // Visible text is discarded: content flows through tool args. MCP tool calls
  // are reported by the `/mcp/recap` route, which knows their names.
  const onAgentEvent = (ev: NormalizedAgentEvent): void => {
    if (ev.kind === "reasoning-delta") reasoning(ev.data);
    else if (ev.kind === "tool-call" && isExplorationTool(ev.toolName)) {
      fanOut({
        type: "activity",
        data: buildActivity(ev.toolName, ev.input, projectlessAgentCwd(), ev.callId),
      });
    }
  };
  const decodeState = makeAcpDecodeState();

  const error = await runMcpAgentViaAcp({
    launch: params.launch,
    abortController: params.abortController,
    activity: params.activity,
    settle: params.completion,
    trace: { key: params.ctx.recapId, attribute: SPAN_ATTR.recapId },
    mcp: turnMcpServer(RECAP_TOOL_BUNDLE, params.ctx.recapId, params.sessionToken, true),
    prompt: userMessage,
    calledAnyTool: params.calledAnyTool,
    debugLabel: "recap-acp",
    onSessionUpdate: (update) => {
      for (const ev of decodeAcpSessionUpdate(update, decodeState)) onAgentEvent(ev);
    },
  });
  if (error?.kind === "no_tool_calls") {
    params.ctx.emit({ type: "error", data: { code: "GENERATION_ERROR", message: error.message } });
  }
  return error;
}
