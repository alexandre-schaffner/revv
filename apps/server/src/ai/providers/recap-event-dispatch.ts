// Translates the recap agent's normalized ACP events into recap SSE envelopes:
// the one place that decides throttling, phase heartbeats and discard rules.

import type { RecapStreamEvent } from "@revv/shared";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { isAgentBuiltinTool } from "../agent-stream/tool-activity";
import { buildRecapActivity } from "./recap-activity";

/** Keeps "Model is thinking…" from repeating on every token while still showing
 *  progress during extended thinking. */
export const REASONING_HEARTBEAT_MS = 30_000;

export interface RecapDispatchState {
  lastReasoningPushAt: number;
}

export function createRecapDispatchState(): RecapDispatchState {
  return { lastReasoningPushAt: 0 };
}

/**
 * Visible text is discarded: content flows through tool args. MCP tool calls
 * are reported by the `/mcp/recap` route, which knows their names.
 */
export function dispatchRecapStreamEvent(
  ev: NormalizedAgentEvent,
  state: RecapDispatchState,
  emit: (event: RecapStreamEvent) => void,
  now: () => number = Date.now,
): void {
  if (ev.kind === "text-delta") {
    return;
  }
  if (ev.kind === "reasoning-delta") {
    if (ev.data.length > 0) {
      emit({ type: "thought", data: { text: ev.data } });
    }
    const t = now();
    if (t - state.lastReasoningPushAt >= REASONING_HEARTBEAT_MS) {
      state.lastReasoningPushAt = t;
      emit({
        type: "phase",
        data: { phase: "analyzing", message: "Model is thinking…" },
      });
    }
    return;
  }
  if (ev.kind === "tool-call" && isAgentBuiltinTool(ev.toolName)) {
    emit({ type: "activity", data: buildRecapActivity(ev.toolName, ev.input) });
    return;
  }
}
