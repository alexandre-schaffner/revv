// ─── Shared recap stream-event dispatcher ───────────────────────────────────
//
// CLAUDE.md invariant #13 demands byte-identical externally-observable
// behavior between the Claude SDK and opencode recap transports. Both
// transports decode their native frames into the same `NormalizedAgentEvent`
// union; this module is the single place that translates those normalized
// events into recap SSE envelopes. Adding a new emission policy (throttling,
// extra phase heartbeats, discard rules) only has to happen once.

import type { RecapStreamEvent } from "@revv/shared";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { buildRecapActivity, normalizeRecapToolName } from "./recap-activity";

/** Minimum gap between `phase: "analyzing"` heartbeats emitted from
 *  reasoning-delta bursts. Keeps the UI from spamming "Model is thinking…"
 *  on every token while still showing progress during extended thinking. */
export const REASONING_HEARTBEAT_MS = 30_000;

export interface RecapDispatchState {
  /** Last `Date.now()` we emitted a reasoning heartbeat. */
  lastReasoningPushAt: number;
}

export function createRecapDispatchState(): RecapDispatchState {
  return { lastReasoningPushAt: 0 };
}

/**
 * Translate one normalized agent event into zero or more recap SSE envelopes.
 * Both transports call this for every event off the wire. Visible text is
 * discarded — content flows through tool args under the structured pipeline.
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
  if (ev.kind === "tool-call") {
    const toolName = normalizeRecapToolName(ev.bareName);
    emit({ type: "activity", data: buildRecapActivity(toolName, ev.input) });
    return;
  }
  // task-list-update / subagent-* / user-question / plan-presented / error
  // → ignored by recap.
}
