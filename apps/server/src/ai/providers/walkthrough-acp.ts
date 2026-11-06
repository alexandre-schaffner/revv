// Walkthrough generation over the turn runner (`ai/acp/run-turn.ts`).
//
// All walkthrough content is written by the MCP tool handlers behind
// `/mcp/walkthrough` and broadcast by WalkthroughJobs; it never passes through
// this stream. What this stream carries: the agent's built-in exploration pills
// (ACP tags those with a `kind`; MCP tool calls carry only a human title),
// streamed reasoning, context-window occupancy from `usage_update` (ACP reports
// no throughput tokens), a coarse connecting → exploring phase with a periodic
// heartbeat, and the terminal `done` / `error`.

import type {
  WalkthroughLifecyclePhase,
  WalkthroughMode,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db";
import { walkthroughs as walkthroughsTable } from "../../db/schema/walkthroughs";
import { debug, logError } from "../../logger";
import { graftedSpan } from "../../observability/span-graft";
import type { PrFileMeta } from "../../services/GitHub";
import { AgentTurnError } from "../acp/agent-failure";
import type { AgentLaunch } from "../acp/agent-launch";
import { type ActivityBeacon, JOB_TURN, runAcpTurn } from "../acp/run-turn";
import { decodeAcpSessionUpdate, makeAcpDecodeState } from "../agent-stream/acp-decoders";
import type { NormalizedAgentEvent } from "../agent-stream/normalized-events";
import {
  buildActivity,
  isAgentBuiltinTool,
  relativizeToolInput,
} from "../agent-stream/tool-activity";
import {
  buildWalkthroughPrompt,
  buildWalkthroughSystemPrompt,
  type WalkthroughPromptHints,
  type WalkthroughReviewMode,
} from "../prompts/walkthrough";
import { recordWalkthroughToken, startWalkthroughPrompt } from "./walkthrough-metrics";
import { mergeContextOccupancy, ZERO_TOKEN_USAGE } from "./walkthrough-token-usage";

/** Cadence at which each provider pushes a `phase` heartbeat into its event queue
 *  while the prompt is in flight. Keeps the stream guard's inactivity timer reset
 *  even when the model is thinking deeply between tool calls or SSE reasoning-delta
 *  events are temporarily silent. */
const WALKTHROUGH_HEARTBEAT_MS = 45_000; // 45 seconds

/** Avoid "Internal error.. Nothing had been written" when joining clauses. */
function trimTrailingPeriod(message: string): string {
  return message.replace(/\.\s*$/, "");
}

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";

export interface AcpWalkthroughStreamParams extends WalkthroughPromptHints {
  walkthroughId: string;
  db: Db;
  pr: {
    title: string;
    body: string | null;
    sourceBranch: string;
    targetBranch: string;
    url: string;
  };
  mode: WalkthroughMode;
  files: PrFileMeta[];
  worktreePath: string;
  reviewMode: WalkthroughReviewMode;
  /** The row already has content from an earlier run; the prompt tells the agent so. */
  resumed: boolean;
  /** Bearer for `/mcp/walkthrough`, issued by WalkthroughJobs for this job. */
  mcpToken: string;
  /**
   * The job's liveness beacon. WalkthroughJobs notes every MCP call the agent
   * authenticates; the runner notes every ACP session update.
   */
  activity: ActivityBeacon;
  /** User cancel, scope finalizer, shutdown: cancels the agent's session. */
  abortController: AbortController;
  launch: AgentLaunch;
}

/**
 * Stream a walkthrough through the configured ACP agent: a fresh session with
 * the `/mcp/walkthrough` endpoint, its session updates mapped onto
 * `WalkthroughStreamEvent`s.
 */
export function streamWalkthroughViaAcp(
  params: AcpWalkthroughStreamParams,
): AsyncGenerator<WalkthroughStreamEvent> {
  const events: WalkthroughStreamEvent[] = [];
  let waiter: { resolve: () => void } | null = null;
  let queryDone = false;

  function push(event: WalkthroughStreamEvent) {
    events.push(event);
    if (waiter) {
      waiter.resolve();
      waiter = null;
    }
  }

  let errorEmitted = false;
  // Silences the heartbeat once the turn was cancelled or timed out.
  let cancelled = false;
  // A timeout, unlike a user cancel, keeps whatever was already committed and
  // defers to auto-continuation.
  let timedOut = false;
  // The runner's timeout message, kept so the zero-content path can say WHY the
  // run produced nothing instead of blaming the PR's complexity.
  let timeoutReason: string | null = null;
  /** A mid-turn failure; surfaced only when the run committed nothing. */
  const failed: { error: AgentTurnError | null } = { error: null };
  const activity = params.activity;
  // Running context-occupancy gauge. Throughput fields stay zero — ACP doesn't
  // report them.
  let tokenUsage: WalkthroughTokenUsage = ZERO_TOKEN_USAGE;

  let currentPhase: Extract<WalkthroughLifecyclePhase, "connecting" | "exploring"> = "connecting";
  let lastPhaseMessage = "Starting up...";
  let lastReasoningPush = 0;
  // Exploration tool-call ids we surfaced as pills, so their later `tool-result`
  // can be forwarded as an `exploration-result` (and others dropped).
  const surfacedExplorationCallIds = new Set<string>();
  // Open spans for the agent's own tool calls, keyed on ACP call id. The agent
  // reads and greps inside our worktree for as long as it likes; without these
  // that time is indistinguishable from model inference in the timeline. Closed
  // on the matching `tool-result`, and swept in the `finally` below so a turn
  // that dies mid-tool-call doesn't leak an unended span.
  const openToolSpans = new Map<string, ReturnType<typeof graftedSpan>>();
  const enterExploring = (message: string): void => {
    if (currentPhase === "exploring") return;
    currentPhase = "exploring";
    lastPhaseMessage = message;
    push({ type: "phase", data: { phase: currentPhase, message } });
  };

  // Agent's own ACP `session/update` stream: reasoning, built-in exploration
  // pills, context-occupancy. MCP content tool calls are ignored here (the
  // route surfaces them).
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
      if (ev.data.length > 0) push({ type: "thought", data: { text: ev.data } });
      // Throttled phase heartbeat — keeps the stream guard alive when reasoning
      // runs for 60+ s without producing a tool call.
      const now = Date.now();
      if (now - lastReasoningPush >= 30_000) {
        lastReasoningPush = now;
        if (currentPhase === "connecting") {
          enterExploring("Model is thinking...");
        } else {
          push({ type: "phase", data: { phase: currentPhase, message: "Model is thinking..." } });
        }
      }
      return;
    }

    if (ev.kind === "text-delta") {
      // Visible assistant text signals an active session; nudge into exploring.
      enterExploring("Reading files and understanding changes...");
      return;
    }

    if (ev.kind === "tool-call") {
      if (isAgentBuiltinTool(ev.toolName)) {
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
      // Only forward results for exploration pills we actually surfaced — the
      // feed keys peeks by callId and ignores unmatched ones anyway.
      if (surfacedExplorationCallIds.has(ev.callId)) {
        push({
          type: "exploration-result",
          data: { callId: ev.callId, output: ev.output, isError: ev.isError },
        });
      }
      return;
    }

    if (ev.kind === "tool-call-update") {
      // Late-arriving input — back-fill the surfaced pill's filename/command.
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
  const userMessage = `${systemPrompt}\n\n---\n\n${buildWalkthroughPrompt(params)}`;

  const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
    // Keeps the stream guard and the client's stall watchdog fed during long
    // thinking gaps. Synthetic, so it never notes `activity`.
    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted || cancelled) return;
      push({ type: "phase", data: { phase: currentPhase, message: lastPhaseMessage } });
    }, WALKTHROUGH_HEARTBEAT_MS);
    const decodeState = makeAcpDecodeState();

    try {
      const { end } = await runAcpTurn({
        label: "walkthrough-acp",
        launch: params.launch,
        cwd: params.worktreePath,
        // Required: all content flows through it. Every run, auto-continuations
        // included, is a fresh session that reads its state back over MCP
        // (invariant #6), never session memory.
        mcp: {
          route: "/mcp/walkthrough",
          name: `${WALKTHROUGH_MCP_SERVER}-${params.walkthroughId}`,
          token: params.mcpToken,
          required: true,
        },
        deadlines: JOB_TURN,
        activity,
        signal: params.abortController.signal,
        traceKey: params.walkthroughId,
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

      if (end.kind === "timeout") {
        // Not a failure: everything the agent wrote is committed (invariant
        // #1), so the stream ends without an error event, the tail yields
        // `done` off the DB, and WalkthroughJobs resumes from its
        // auto-continuation budget instead of a red chip over a half-written
        // walkthrough.
        debug("walkthrough-acp", "turn timed out — deferring to auto-continuation:", end.reason);
        cancelled = true;
        timedOut = true;
        timeoutReason = end.reason;
        return tokenUsage;
      }
      if (end.kind === "cancelled") {
        cancelled = true;
        if (!errorEmitted) {
          errorEmitted = true;
          push({ type: "error", data: { code: "AiGenerationError", message: end.reason } });
        }
        return ZERO_TOKEN_USAGE;
      }
      if (end.stopReason === "refusal" && !errorEmitted) {
        errorEmitted = true;
        push({
          type: "error",
          data: { code: "AiGenerationError", message: "The agent declined to continue." },
        });
      }
      return tokenUsage;
    } catch (err) {
      // The transport's fault, not a verdict on the review, and everything
      // committed is durable: the tail reads the DB, so persisted content
      // falls into auto-continuation and only an empty run surfaces this.
      failed.error = err instanceof AgentTurnError ? err : new AgentTurnError(String(err), "other");
      logError("walkthrough-acp", "turn failed:", failed.error.message);
      return tokenUsage;
    } finally {
      clearInterval(heartbeatInterval);
      // A cancelled or timed-out turn can leave a tool call without its result;
      // an unended span never reaches the exporter.
      for (const span of openToolSpans.values()) span.end();
      openToolSpans.clear();
    }
  })();

  return (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
    const resultPromise = queryTask.then((usage) => {
      queryDone = true;
      if (waiter) {
        waiter.resolve();
        waiter = null;
      }
      return usage;
    });

    while (true) {
      if (events.length > 0) {
        const batch = events.splice(0);
        for (const e of batch) {
          yield e;
        }
      } else if (queryDone) {
        break;
      } else {
        await new Promise<void>((resolve) => {
          waiter = { resolve };
        });
      }
    }

    for (const e of events.splice(0)) {
      yield e;
    }

    const finalTokenUsage = await resultPromise;

    // The DB is authoritative (invariant #1): a run (or an earlier run this one
    // resumes) that persisted a summary ends in `done`. Skipped when the caller
    // cancelled; a timeout still consults the DB — its whole point is to hand
    // the committed partial to auto-continuation.
    let summaryPersisted = false;
    const failure = failed.error;
    if (!cancelled || timedOut || failure !== null) {
      try {
        const row = params.db
          .select({ summary: walkthroughsTable.summary })
          .from(walkthroughsTable)
          .where(eq(walkthroughsTable.id, params.walkthroughId))
          .get();
        summaryPersisted = (row?.summary ?? "").length > 0;
      } catch (cause) {
        debug(
          "walkthrough-acp",
          "summary-persisted DB check failed:",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    }

    if (summaryPersisted) {
      yield {
        type: "done" as const,
        data: { walkthroughId: params.walkthroughId, tokenUsage: finalTokenUsage },
      };
    } else if (!errorEmitted) {
      debug("walkthrough-acp", "Session ended without producing content — emitting fallback error");
      // A timeout that wrote nothing has no partial for auto-continuation to
      // build on, so it surfaces as a terminal error — but say what actually
      // happened rather than blaming the PR.
      yield {
        type: "error" as const,
        data: timeoutReason
          ? {
              code: "AgentTimeout",
              message: `${timeoutReason}, and nothing had been written yet. Try regenerating.`,
            }
          : failure
            ? {
                code: failure.kind === "auth" ? "AGENT_AUTH_REQUIRED" : "AiGenerationError",
                message: `${trimTrailingPeriod(failure.message)}. Nothing had been written yet. Try regenerating.`,
              }
            : {
                code: "NoSummaryGenerated",
                message:
                  "The AI finished without producing a walkthrough. This can happen with complex PRs. Try regenerating.",
              },
      };
    }
  })();
}
