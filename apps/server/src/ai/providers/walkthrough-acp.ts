// One walkthrough agent turn over the turn runner (`ai/acp/run-turn.ts`).
//
// All walkthrough content is written by the MCP tool handlers behind
// `/mcp/walkthrough`; none of it passes through here. The turn reports live
// events as they happen — the agent's built-in exploration pills (ACP tags
// those with a `kind`; MCP tool calls carry only a human title), streamed
// reasoning, context-window occupancy, a coarse connecting → exploring phase
// with a heartbeat — and resolves with how the turn ended. Whether the run is
// finished is the journal's call, made by WalkthroughJobs.

import type {
  WalkthroughLifecyclePhase,
  WalkthroughLiveEvent,
  WalkthroughMode,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { ZERO_TOKEN_USAGE } from "@revv/shared";
import { debug, logError } from "../../logger";
import { graftedSpan } from "../../observability/span-graft";
import type { PrFileMeta } from "../../services/github/pulls";
import type { AgentLaunch } from "../acp/agent-launch";
import { type AcpTurnOutcome, type ActivityBeacon, JOB_TURN, runAcpTurn } from "../acp/run-turn";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import { makeReasoningFeed } from "../agent-stream/reasoning-feed";
import {
  buildActivity,
  isExplorationTool,
  relativizeToolInput,
} from "../agent-stream/tool-activity";
import {
  buildWalkthroughPrompt,
  buildWalkthroughSystemPrompt,
  type WalkthroughPromptHints,
  type WalkthroughReviewMode,
} from "../prompts/walkthrough";
import { recordWalkthroughToken, startWalkthroughPrompt } from "./walkthrough-metrics";
import { mergeContextOccupancy } from "./walkthrough-token-usage";

/** A `phase` heartbeat while the prompt is in flight, so the client's stall watchdog sees a live run through long thinking gaps. */
const WALKTHROUGH_HEARTBEAT_MS = 45_000;

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";

export interface WalkthroughTurnParams extends WalkthroughPromptHints {
  walkthroughId: string;
  pr: {
    title: string;
    body: string | null;
    sourceBranch: string;
    targetBranch: string;
    url: string;
  };
  mode: WalkthroughMode;
  files: ReadonlyArray<PrFileMeta>;
  worktreePath: string;
  reviewMode: WalkthroughReviewMode;
  /** The row already has content from an earlier run; the prompt tells the agent so. */
  resumed: boolean;
  /** Bearer for `/mcp/walkthrough`, issued for this run. */
  mcpToken: string;
  /**
   * The run's liveness beacon. The MCP route notes every call the agent
   * authenticates; the runner notes every ACP session update.
   */
  activity: ActivityBeacon;
  /** User cancel, supersede, shutdown: cancels the agent's session. */
  abortController: AbortController;
  /** From the run's launch plan. */
  launch: AgentLaunch;
  onLive: (event: WalkthroughLiveEvent) => void;
}

/** How one agent turn ended. A timeout or failure is not a verdict on the review: everything written is committed. */
export type WalkthroughTurnEnd =
  | { readonly kind: "stopped"; readonly refused: boolean }
  | { readonly kind: "timeout"; readonly reason: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "failed"; readonly message: string; readonly auth: boolean };

export interface WalkthroughTurnResult {
  readonly end: WalkthroughTurnEnd;
  /** Context occupancy at the end of the turn; ACP reports no throughput tokens. */
  readonly tokenUsage: WalkthroughTokenUsage;
}

/**
 * One walkthrough turn through the configured ACP agent: a fresh session with
 * the `/mcp/walkthrough` endpoint. Every turn, auto-continuations included,
 * reads its state back over MCP (invariant #6), never session memory.
 */
export async function runWalkthroughTurn(
  params: WalkthroughTurnParams,
): Promise<WalkthroughTurnResult | { readonly notConfigured: true }> {
  const push = params.onLive;
  let finished = false;
  const activity = params.activity;
  let tokenUsage: WalkthroughTokenUsage = ZERO_TOKEN_USAGE;

  let currentPhase: Extract<WalkthroughLifecyclePhase, "connecting" | "exploring"> = "connecting";
  let lastPhaseMessage = "Starting up...";
  const surfacedExplorationCallIds = new Set<string>();
  // Without these, the agent's reads and greps in the worktree are
  // indistinguishable from model inference in the timeline.
  const openToolSpans = new Map<string, ReturnType<typeof graftedSpan>>();
  const enterExploring = (message: string): void => {
    if (currentPhase === "exploring") return;
    currentPhase = "exploring";
    lastPhaseMessage = message;
    push({ type: "phase", data: { phase: currentPhase, message } });
  };
  const reasoning = makeReasoningFeed({
    thought: (text) => push({ type: "thought", data: { text } }),
    heartbeat: () => {
      if (currentPhase === "connecting") {
        enterExploring("Model is thinking...");
      } else {
        push({ type: "phase", data: { phase: currentPhase, message: "Model is thinking..." } });
      }
    },
  });
  const handleAgentEvent = (ev: NormalizedAgentEvent): void => {
    if (ev.kind === "reasoning-delta" || ev.kind === "text-delta") {
      recordWalkthroughToken(params.walkthroughId, ev.data);
    }
    if (ev.kind === "usage") {
      tokenUsage = mergeContextOccupancy(tokenUsage, {
        ...ZERO_TOKEN_USAGE,
        contextTokens: ev.contextTokens,
        ...(ev.contextWindowTokens !== undefined
          ? { contextWindowTokens: ev.contextWindowTokens }
          : {}),
      });
      push({ type: "usage", data: { tokenUsage } });
      return;
    }

    if (ev.kind === "reasoning-delta") {
      reasoning(ev.data);
      return;
    }

    if (ev.kind === "text-delta") {
      enterExploring("Reading files and understanding changes...");
      return;
    }

    if (ev.kind === "tool-call") {
      if (isExplorationTool(ev.toolName)) {
        enterExploring("Reading files and understanding changes...");
        if (ev.callId) {
          surfacedExplorationCallIds.add(ev.callId);
          openToolSpans.set(
            ev.callId,
            graftedSpan(params.walkthroughId, `Agent.${ev.toolName}`, {
              attributes: {
                walkthrough_id: params.walkthroughId,
                agent_tool: ev.toolName,
                call_id: ev.callId,
              },
            }),
          );
        }
        push({
          type: "exploration",
          data: buildActivity(ev.toolName, ev.input, params.worktreePath, ev.callId),
        });
      }
      return;
    }

    if (ev.kind === "tool-result") {
      const toolSpan = openToolSpans.get(ev.callId);
      if (toolSpan) {
        openToolSpans.delete(ev.callId);
        if (ev.isError) toolSpan.fail(new Error("agent tool reported an error"));
        toolSpan.end();
      }
      if (surfacedExplorationCallIds.has(ev.callId)) {
        push({
          type: "exploration-result",
          data: { callId: ev.callId, output: ev.output, isError: ev.isError },
        });
      }
      return;
    }

    if (ev.kind === "tool-call-update") {
      // ACP can deliver a tool call's input after the call itself.
      if (surfacedExplorationCallIds.has(ev.callId)) {
        push({
          type: "exploration-input",
          data: { callId: ev.callId, payload: relativizeToolInput(ev.input, params.worktreePath) },
        });
      }
      return;
    }
  };

  const systemPrompt = buildWalkthroughSystemPrompt(params.mode);
  // ACP has no separate system-prompt channel — prepend it.
  const userMessage = `${systemPrompt}\n\n---\n\n${buildWalkthroughPrompt({ ...params, files: [...params.files] })}`;

  const heartbeatInterval = setInterval(() => {
    if (finished) return;
    push({ type: "phase", data: { phase: currentPhase, message: lastPhaseMessage } });
  }, WALKTHROUGH_HEARTBEAT_MS);
  const decodeState = makeAcpDecodeState();

  let end: AcpTurnOutcome;
  try {
    end = await runAcpTurn({
      label: "walkthrough-acp",
      launch: params.launch,
      cwd: params.worktreePath,
      mcp: {
        route: "/mcp/walkthrough",
        name: `${WALKTHROUGH_MCP_SERVER}-${params.walkthroughId}`,
        token: params.mcpToken,
        required: true,
      },
      deadlines: JOB_TURN,
      activity,
      signal: params.abortController.signal,
      trace: { key: params.walkthroughId, attribute: "walkthrough_id" },
      onSessionOpened: () => {
        // The model may take minutes to its first tool call; the session is alive.
        lastPhaseMessage = "Waiting for model response...";
        push({ type: "phase", data: { phase: "connecting", message: lastPhaseMessage } });
        startWalkthroughPrompt(params.walkthroughId);
      },
      prompt: () => [{ type: "text", text: userMessage }],
      onUpdate: (update) => {
        for (const ev of decodeAcpSessionUpdate(update, decodeState)) handleAgentEvent(ev);
      },
    });
  } finally {
    finished = true;
    clearInterval(heartbeatInterval);
    // A cancelled or timed-out turn can leave a tool call without its result;
    // an unended span never reaches the exporter.
    for (const span of openToolSpans.values()) span.end();
    openToolSpans.clear();
  }
  switch (end.kind) {
    case "timeout":
      debug("walkthrough-acp", "turn timed out:", end.reason);
      return { end, tokenUsage };
    case "cancelled":
      return { end, tokenUsage };
    case "stopped":
    case "settled":
      return {
        end: { kind: "stopped", refused: end.kind === "stopped" && end.stopReason === "refusal" },
        tokenUsage,
      };
    case "failed":
      logError("walkthrough-acp", "turn failed:", end.failure.message);
      return {
        end: { kind: "failed", message: end.failure.message, auth: end.failure.kind === "auth" },
        tokenUsage,
      };
    case "not_configured":
      return { notConfigured: true };
  }
}
