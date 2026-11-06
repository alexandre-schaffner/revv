// ACP (Agent Client Protocol) driver for walkthrough generation, over the
// stdio JSON-RPC connection pooled per worktree (`ai/acp/acp-connection.ts`).
//
// All walkthrough content is written by the MCP tool handlers behind
// `/mcp/walkthrough` and broadcast by WalkthroughJobs; it never passes through
// this stream. What this stream carries: the agent's built-in exploration pills
// (ACP tags those with a `kind`; MCP tool calls carry only a human title),
// streamed reasoning, context-window occupancy from `usage_update` (ACP reports
// no throughput tokens), a coarse connecting → exploring phase with a periodic
// heartbeat, and the terminal `done` / `error`.

import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AcpAgentId,
  WalkthroughLifecyclePhase,
  WalkthroughMode,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { serverEnv } from "../../config";
import {
  AGENT_IDLE_TIMEOUT_MS,
  CLI_WALKTHROUGH_TIMEOUT_MS,
  WALKTHROUGH_HEARTBEAT_MS,
} from "../../constants";
import type { Db } from "../../db";
import { walkthroughs as walkthroughsTable } from "../../db/schema/walkthroughs";
import { debug, logError } from "../../logger";
import { graftedSpan, publishTraceAnchor } from "../../observability/span-graft";
import {
  recordWalkthroughToken,
  startWalkthroughPrompt,
} from "../../observability/walkthrough-metrics";
import type { PrFileMeta } from "../../services/GitHub";
import { type AcpConnectionHandle, getAcpConnection } from "../acp/acp-connection";
import { withAgentKeychainHint } from "../acp/agent-keychain";
import type { AcpLaunchConfig } from "../acp/presets";
import {
  type ActivityBeacon,
  buildActivity,
  decodeAcpSessionUpdate,
  makeAcpDecodeState,
  mergeContextOccupancy,
  type NormalizedAgentEvent,
  relativizeToolInput,
  withAgentTurn,
  ZERO_TOKEN_USAGE,
} from "../agent-stream";
import {
  buildWalkthroughPrompt,
  buildWalkthroughSystemPrompt,
  type WalkthroughPromptHints,
  type WalkthroughReviewMode,
} from "../prompts/walkthrough";

/** Avoid "Internal error.. Nothing had been written" when joining clauses. */
function trimTrailingPeriod(message: string): string {
  return message.replace(/\.\s*$/, "");
}

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";
const ACP_CANCEL_GRACE_MS = 1_500;

// Built-in exploration tools the agent runs natively (NOT via our MCP route).
// ACP tags these with a `kind` the decoder maps onto canonical names, so they
// arrive here with a real name. MCP content tools arrive with `kind=undefined`
// (→ human title) and are surfaced by the HTTP route instead, so anything not
// in this set is ignored here.
const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Write", "Edit", "WebFetch"]);

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
   * authenticates; this driver notes every ACP session update.
   */
  activity: ActivityBeacon;
  /**
   * Caller-owned abort signal (user cancel, scope finalizer, shutdown). Routed
   * to `handle.cancel(sessionId)` so the ACP agent stops producing output. The
   * idle deadline and the absolute ceiling layer on top inside `withAgentTurn`.
   */
  abortController: AbortController;
  acpAgentId: AcpAgentId;
}

/**
 * Stream a walkthrough through the configured ACP agent. The ACP connection is
 * pooled per worktree by `getAcpConnection`; this driver opens a fresh session,
 * hands the agent the `/mcp/walkthrough` HTTP endpoint, prompts, and maps the
 * normalized session updates onto `WalkthroughStreamEvent`s.
 */
export function streamWalkthroughViaAcp(
  params: AcpWalkthroughStreamParams,
  launch: AcpLaunchConfig,
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
  // Distinguishes a timeout from a user cancel in the catch below: a timeout
  // keeps whatever was already committed and defers to auto-continuation.
  let timedOut = false;
  // The harness' timeout message, kept so the zero-content path can say WHY the
  // run produced nothing instead of blaming the PR's complexity.
  let timeoutReason: string | null = null;
  /** Message from a non-abort mid-turn failure; surfaced only when the run committed nothing. */
  let failureReason: string | null = null;
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
      if (EXPLORATION_TOOLS.has(ev.toolName)) {
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
    let sessionId: string | null = null;
    let handle: AcpConnectionHandle | null = null;

    // Periodic phase heartbeat — guarantees the stream guard (and the client's
    // stall watchdog) sees an event every WALKTHROUGH_HEARTBEAT_MS while the
    // prompt is in flight, including long extended-thinking gaps. Synthetic, so
    // it never notes `activity`.
    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted || cancelled) return;
      push({ type: "phase", data: { phase: currentPhase, message: lastPhaseMessage } });
    }, WALKTHROUGH_HEARTBEAT_MS);

    try {
      // Acquire the connection BEFORE `withAgentTurn` so `jobStarted`/`jobEnded`
      // /`abortSession` close over a live handle (the chat-acp ordering).
      // Cold-start cost of the agent subprocess. Pooled per worktree, so this
      // is ~0 on a warm handle and seconds on a cold one — a difference worth
      // seeing rather than guessing at.
      const connectSpan = graftedSpan(params.walkthroughId, "Acp.connect", {
        attributes: { walkthrough_id: params.walkthroughId, acp_agent: params.acpAgentId },
      });
      try {
        handle = await getAcpConnection(params.worktreePath, params.acpAgentId, launch);
      } catch (err) {
        connectSpan.fail(err);
        throw err;
      } finally {
        connectSpan.end();
      }
      const h = handle;
      if (!h.httpMcpSupported) {
        // HTTP MCP is MANDATORY here (all content flows through it), unlike chat
        // where it degrades. Fail loudly.
        throw new Error(
          `ACP agent '${params.acpAgentId}' does not advertise HTTP MCP support; walkthrough generation requires it`,
        );
      }

      return await withAgentTurn({
        externalAbort: params.abortController,
        hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        activity,
        jobStarted: async () => {
          h.jobStarted();
        },
        jobEnded: async () => {
          h.jobEnded();
        },
        debugLabel: "walkthrough-acp",
        onCancel: () => {
          cancelled = true;
        },
        onTimeout: () => {
          cancelled = true;
          timedOut = true;
        },
        abortSession: async () => {
          if (sessionId) {
            await Promise.race([
              h.cancel(sessionId),
              new Promise<void>((resolve) => setTimeout(resolve, ACP_CANCEL_GRACE_MS)),
            ]);
          }
          h.stop();
        },
        run: async (ctx) => {
          // ── 1. Hand the agent our HTTP MCP endpoint ──
          const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/walkthrough`;
          const mcpServers: McpServer[] = [
            {
              type: "http",
              name: `${WALKTHROUGH_MCP_SERVER}-${params.walkthroughId}`,
              url: mcpUrl,
              headers: [{ name: "Authorization", value: `Bearer ${params.mcpToken}` }],
            },
          ];
          debug("walkthrough-acp", `registering MCP ${WALKTHROUGH_MCP_SERVER} → ${mcpUrl}`);

          // ── 2. Open a FRESH session (never loadSession) ──────────────────
          // Auto-continuations rely on `get_walkthrough_state` (invariant #6),
          // not session memory, so every run is a clean session.
          // Session creation includes the agent's own MCP handshake against
          // `/mcp/walkthrough` (initialize + tools/list), which is a real
          // round-trip through our own HTTP server, not a local no-op.
          const sessionSpan = graftedSpan(params.walkthroughId, "Acp.newSession", {
            attributes: { walkthrough_id: params.walkthroughId, acp_agent: params.acpAgentId },
          });
          let created: Awaited<ReturnType<typeof h.newSession>>;
          try {
            created = await h.newSession(mcpServers);
          } catch (err) {
            sessionSpan.fail(err);
            throw err;
          } finally {
            sessionSpan.end();
          }
          sessionId = created.sessionId;
          debug("walkthrough-acp", "created session:", sessionId);

          // Push a phase event immediately so the stream guard's first-event
          // timer resets — the model may take minutes to produce its first
          // tool call (extended thinking), but the session is alive.
          lastPhaseMessage = "Waiting for model response...";
          push({ type: "phase", data: { phase: "connecting", message: lastPhaseMessage } });

          // ── 3. Stream session updates into the normalized pipeline ───────
          const decodeState = makeAcpDecodeState();
          h.setListener(sessionId, (update) => {
            // Note liveness off the RAW update: some updates decode to zero
            // normalized events (MCP tool calls carry no machine name) yet
            // still prove the agent is alive.
            activity.note();
            for (const ev of decodeAcpSessionUpdate(update, decodeState)) handleAgentEvent(ev);
          });

          // ── 4. Prompt and await the turn ─────────────────────────────────
          debug(
            "walkthrough-acp",
            `prompting session ${sessionId}`,
            "model:",
            launch.model ?? "(default)",
          );
          // The agent turn itself. Re-anchored so everything the turn provokes
          // — the agent's own tool calls above, and the MCP content writes
          // arriving over HTTP — nests inside this span rather than beside it.
          // Whatever wall clock this span does NOT account for through a child
          // is model inference; the dashboard reports that residue directly.
          const promptSpan = graftedSpan(params.walkthroughId, "Acp.prompt", {
            attributes: {
              walkthrough_id: params.walkthroughId,
              acp_agent: params.acpAgentId,
              prompt_chars: userMessage.length,
              "gen_ai.operation.name": "invoke_agent",
              "gen_ai.agent.name": params.acpAgentId,
              "gen_ai.conversation.id": sessionId,
              ...(launch.model
                ? { model: launch.model, "gen_ai.request.model": launch.model }
                : {}),
            },
          });
          const restoreAnchor = publishTraceAnchor(params.walkthroughId, promptSpan.anchor);
          let stopReason: Awaited<ReturnType<typeof h.prompt>>;
          try {
            startWalkthroughPrompt(params.walkthroughId);
            stopReason = await h.prompt(sessionId, [{ type: "text", text: userMessage }]);
            promptSpan.setAttributes({ stop_reason: String(stopReason) });
          } catch (err) {
            promptSpan.fail(err);
            throw err;
          } finally {
            restoreAnchor();
            promptSpan.end();
          }

          if (ctx.wasCancelled() || ctx.wasTimeout()) {
            cancelled = true;
          } else if (stopReason === "refusal" && !errorEmitted) {
            errorEmitted = true;
            push({
              type: "error",
              data: { code: "AiGenerationError", message: "The agent declined to continue." },
            });
          }
          return tokenUsage;
        },
      });
    } catch (err) {
      const message = withAgentKeychainHint(
        params.acpAgentId,
        err instanceof Error ? err.message : String(err),
      );
      if (timedOut) {
        // A timeout is not a failure. Everything the agent already wrote is
        // committed (invariant #1), so end the stream WITHOUT an error event:
        // the tail below yields `done` and `WalkthroughJobs` resumes from the
        // DB out of its auto-continuation budget instead of burning the run and
        // showing the user a red chip over a half-written walkthrough.
        debug("walkthrough-acp", "turn timed out — deferring to auto-continuation:", message);
        timeoutReason = message;
        return tokenUsage;
      }
      logError("walkthrough-acp", "queryTask error:", message);

      // Same reasoning as the timeout above: a mid-turn failure here is the
      // transport's fault, not a verdict on the review, and everything
      // committed is already durable (invariant #1). Record the reason and
      // let the tail read the DB — content persisted falls into
      // auto-continuation, nothing written surfaces this as a terminal
      // error. Abort is excluded: WalkthroughJobs.handleFailure already
      // classifies deliberate cancel/supersede.
      if (params.abortController?.signal.aborted !== true) {
        failureReason = message;
        return tokenUsage;
      }
      if (!errorEmitted) {
        errorEmitted = true;
        push({ type: "error", data: { code: "AiGenerationError", message } });
      }
      return ZERO_TOKEN_USAGE;
    } finally {
      clearInterval(heartbeatInterval);
      // A cancelled or timed-out turn can leave a tool call without its result.
      // End those spans rather than leaking them — an unended span never
      // reaches the exporter, so the timeline would silently lose the call.
      for (const span of openToolSpans.values()) span.end();
      openToolSpans.clear();
      if (handle && sessionId) handle.setListener(sessionId, null);
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
    if (!cancelled || timedOut || failureReason !== null) {
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
          : failureReason
            ? {
                code: "AiGenerationError",
                message: `${trimTrailingPeriod(failureReason)}. Nothing had been written yet. Try regenerating.`,
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
