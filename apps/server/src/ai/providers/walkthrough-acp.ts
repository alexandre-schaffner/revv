// ─── walkthrough-acp ────────────────────────────────────────────────────────
//
// ACP (Agent Client Protocol) driver for walkthrough generation. This is the
// single transport that replaces the bespoke claude-SDK / opencode / codex
// walkthrough drivers — exactly as `chat-acp.ts` replaced the bespoke chat
// drivers. It talks to whichever ACP agent is configured (see
// `ai/acp/presets.ts`) over the stdio JSON-RPC connection pooled per worktree
// (`ai/acp/acp-connection.ts`).
//
// Like the opencode driver it returns an `AsyncGenerator<WalkthroughStreamEvent>`
// fed by a push-queue, so nothing downstream (the stream guard, WalkthroughJobs,
// the SSE encoder, the web walkthrough panel) changes. All walkthrough CONTENT
// (overview, diff steps, ratings, …) is written by the shared MCP tool handlers
// behind the HTTP route `/mcp/walkthrough` and reaches this stream via the
// activity-notifier (`WalkthroughJobs.emitEvent` → registered callback) — the
// same path the opencode/codex drivers used (doctrine invariants #2, #8, #13).
//
// What this file adds on top of those notifier events:
//   • a forward-only phase machine driven off the RELIABLE content events
//     (`summary` → analyzing, `block`/`semantic-step` → writing, `rating` →
//     rating) rather than off the agent's MCP tool-call names — ACP gives MCP
//     tool calls no machine name (only a human title), so decoding them would
//     be fragile;
//   • built-in exploration pills (Read / Grep / Bash) decoded from the agent's
//     own ACP `session/update` stream (ACP DOES tag these with a `kind`);
//   • streamed reasoning (`thought`) + a periodic heartbeat that keeps the
//     stream guard's inactivity timer alive (the only liveness signal — there
//     is no SSE side-channel);
//   • context-window occupancy from ACP `usage_update` (throughput token
//     fields are unavailable over ACP and stay zero — an accepted regression).

import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  AcpAgentId,
  RatingAxis,
  UserSettings,
  WalkthroughBlock,
  WalkthroughLifecyclePhase,
  WalkthroughMode,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS, WALKTHROUGH_HEARTBEAT_MS } from "../../constants";
import type { Db } from "../../db";
import { walkthroughs as walkthroughsTable } from "../../db/schema/walkthroughs";
import { debug, logError } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import { type AcpConnectionHandle, getAcpConnection } from "../acp/acp-connection";
import { withAgentKeychainHint } from "../acp/agent-keychain";
import {
  buildActivity,
  decodeAcpSessionUpdate,
  makeAcpDecodeState,
  mergeContextOccupancy,
  type NormalizedAgentEvent,
  relativizeToolInput,
  withAgentTurn,
  ZERO_TOKEN_USAGE,
} from "../agent-stream";
import { buildWalkthroughPrompt, buildWalkthroughSystemPrompt } from "../prompts/walkthrough";

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";
const ACP_CANCEL_GRACE_MS = 1_500;

// Built-in exploration tools the agent runs natively (NOT via our MCP route).
// ACP tags these with a `kind` the decoder maps onto canonical names, so they
// arrive here with a real name. MCP content tools arrive with `kind=undefined`
// (→ human title) and are surfaced by the HTTP route instead, so anything not
// in this set is ignored here.
const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Write", "Edit", "WebFetch"]);

// ── Continuation context ─────────────────────────────────────────────────────

/**
 * Informational context passed into the provider on resume. Under the agent
 * doctrine the agent no longer CONSUMES this — it calls `get_walkthrough_state`
 * via MCP instead (invariant #6). Kept for the prompt builder (so the agent is
 * told it is continuing) and for back-compat with `WalkthroughJobs`, which still
 * populates `opencodeSessionId` / `codexThreadId` (harmless, unused by the ACP
 * transport — every ACP run is a fresh `newSession`).
 */
export interface ContinuationContext {
  walkthroughId: string;
  existingHasReportContent: boolean;
  existingBlocks: WalkthroughBlock[];
  existingIssueCount: number;
  existingRatedAxes: RatingAxis[];
  opencodeSessionId?: string;
  /** Codex thread id — retained only for back-compat; unused over ACP. */
  codexThreadId?: string;
}

// ── Deps injected by the caller (AiService) ──────────────────────────────────

export interface AcpWalkthroughDeps {
  /** Mint a session token bound to this walkthroughId (HTTP MCP bearer). */
  issueSessionToken: (walkthroughId: string) => Promise<string>;
  /** Invalidate the token when we're done. */
  clearSessionToken: (token: string) => Promise<void>;
  /**
   * Register the heartbeat/content notifier in WalkthroughJobs so the MCP tool
   * handlers' emitted content events flow into this stream (and the stream
   * guard's inactivity timer resets on each tool call).
   */
  registerActivityNotifier: (
    walkthroughId: string,
    callback: (event: WalkthroughStreamEvent) => void,
  ) => Promise<void>;
  /** Unregister the notifier (called from finally). */
  unregisterActivityNotifier: (walkthroughId: string) => Promise<void>;
}

export interface AcpWalkthroughStreamParams {
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
  /** Informational only — passed into the prompt; NOT used for session resume. */
  continuation?: ContinuationContext;
  onSessionId?: (sessionId: string) => void;
  /**
   * Caller-owned abort signal (user cancel, scope finalizer, shutdown). Routed
   * to `handle.cancel(sessionId)` so the ACP agent stops producing output. The
   * 10-minute hard timeout layers on top via the same controller.
   */
  abortController?: AbortController;
  /** Resolved ACP registry agent id that drives this generation. */
  acpAgentId: AcpAgentId;
  deps: AcpWalkthroughDeps;
}

/**
 * Stream a walkthrough through the configured ACP agent. The ACP connection is
 * pooled per worktree by `getAcpConnection`; this driver opens a fresh session,
 * hands the agent the `/mcp/walkthrough` HTTP endpoint, prompts, and maps the
 * normalized session updates onto `WalkthroughStreamEvent`s.
 */
export function streamWalkthroughViaAcp(
  params: AcpWalkthroughStreamParams,
  model?: string,
  settings?: UserSettings,
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
  let anySummaryEmitted = false;
  // Tracked outside the harness so the notifier closure (registered before
  // `withAgentTurn`) can suppress late events after regenerate/hard-timeout.
  let cancelled = false;
  // Running context-occupancy gauge. Throughput fields stay zero — ACP doesn't
  // report them (accepted regression vs. the pre-migration drivers).
  let tokenUsage: WalkthroughTokenUsage = ZERO_TOKEN_USAGE;

  // Forward-only phase machine — identical lifecycle to the pre-migration
  // drivers (invariant #13 parity with PRE-migration behavior).
  let currentPhase: WalkthroughLifecyclePhase = "connecting";
  let lastPhaseMessage = "Starting up...";
  let lastReasoningPush = 0;
  // Exploration tool-call ids we surfaced as pills, so their later `tool-result`
  // can be forwarded as an `exploration-result` (and others dropped).
  const surfacedExplorationCallIds = new Set<string>();
  const PHASE_ORDER: WalkthroughLifecyclePhase[] = [
    "connecting",
    "exploring",
    "analyzing",
    "writing",
    "rating",
    "finishing",
  ];
  const transitionPhase = (next: WalkthroughLifecyclePhase, message: string): void => {
    if (currentPhase === next) return;
    // Forward-only: never roll the phase machine back (heartbeats and late
    // exploration must not override a "writing" phase with "exploring").
    if (PHASE_ORDER.indexOf(next) < PHASE_ORDER.indexOf(currentPhase)) return;
    currentPhase = next;
    lastPhaseMessage = message;
    push({ type: "phase", data: { phase: next, message } });
  };

  // Content + MCP-tool exploration events emitted by the shared HTTP MCP route
  // handlers (transport-independent). We drive the phase machine off these
  // because they are the RELIABLE signal — unlike the agent's ACP tool-call
  // names, which carry no machine identifier for MCP tools.
  const onContentEvent = (event: WalkthroughStreamEvent): void => {
    if (queryDone || errorEmitted || cancelled) return;
    switch (event.type) {
      case "summary":
        anySummaryEmitted = true;
        transitionPhase("analyzing", "Forming assessment and risk analysis...");
        break;
      case "semantic-step":
      case "block":
        transitionPhase("writing", "Building walkthrough...");
        break;
      case "rating":
        transitionPhase("rating", "Scoring the PR across 9 axes...");
        break;
      case "exploration":
        // The route emits an exploration event for each MCP phase tool; the
        // final `complete_walkthrough` call is our "finishing" signal.
        if (event.data.toolName === "complete_walkthrough") {
          transitionPhase("finishing", "Wrapping up...");
        }
        break;
      default:
        break;
    }
    push(event);
  };

  // Agent's own ACP `session/update` stream: reasoning, built-in exploration
  // pills, context-occupancy. MCP content tool calls are ignored here (they're
  // surfaced by the route via `onContentEvent`).
  const handleAgentEvent = (ev: NormalizedAgentEvent): void => {
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
          transitionPhase("exploring", "Model is thinking...");
        } else {
          push({ type: "phase", data: { phase: currentPhase, message: "Model is thinking..." } });
        }
      }
      return;
    }

    if (ev.kind === "text-delta") {
      // Visible assistant text signals an active session; nudge into exploring.
      transitionPhase("exploring", "Reading files and understanding changes...");
      return;
    }

    if (ev.kind === "tool-call") {
      if (EXPLORATION_TOOLS.has(ev.toolName)) {
        transitionPhase("exploring", "Reading files and understanding changes...");
        if (ev.callId) surfacedExplorationCallIds.add(ev.callId);
        push({
          type: "exploration",
          data: buildActivity(ev.toolName, ev.input, params.worktreePath, ev.callId),
        });
      }
      return;
    }

    if (ev.kind === "tool-result") {
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
  // ACP has no separate system-prompt channel — prepend it (chat-acp / opencode
  // driver both do this; the prepend is the load-bearing copy).
  const userMessage = `${systemPrompt}\n\n---\n\n${buildWalkthroughPrompt(
    params,
    undefined,
    params.continuation,
  )}`;

  const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
    let sessionToken: string | null = null;
    let sessionId: string | null = null;
    let handle: AcpConnectionHandle | null = null;

    await params.deps.registerActivityNotifier(params.walkthroughId, onContentEvent);

    // Periodic phase heartbeat — guarantees the stream guard sees an event every
    // WALKTHROUGH_HEARTBEAT_MS while the prompt is in flight. With no SSE
    // side-channel, this (plus the initial "connecting" push) is the ONLY
    // liveness signal during long extended-thinking gaps.
    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted || cancelled) return;
      push({ type: "phase", data: { phase: currentPhase, message: lastPhaseMessage } });
    }, WALKTHROUGH_HEARTBEAT_MS);

    try {
      // Acquire the connection BEFORE `withAgentTurn` so `jobStarted`/`jobEnded`
      // /`abortSession` close over a live handle (the chat-acp ordering).
      handle = await getAcpConnection(params.worktreePath, params.acpAgentId, {
        model,
        thinkingEffort: settings?.aiThinkingEffort,
        contextWindow: settings?.aiContextWindow,
      });
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
          // ── 1. Issue session token + hand the agent our HTTP MCP endpoint ──
          sessionToken = await params.deps.issueSessionToken(params.walkthroughId);
          const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/walkthrough`;
          const mcpServers: McpServer[] = [
            {
              type: "http",
              name: `${WALKTHROUGH_MCP_SERVER}-${params.walkthroughId}`,
              url: mcpUrl,
              headers: [{ name: "Authorization", value: `Bearer ${sessionToken}` }],
            },
          ];
          debug("walkthrough-acp", `registering MCP ${WALKTHROUGH_MCP_SERVER} → ${mcpUrl}`);

          // ── 2. Open a FRESH session (never loadSession) ──────────────────
          // Auto-continuations rely on `get_walkthrough_state` (invariant #6),
          // not session memory, so every run is a clean session.
          const created = await h.newSession(mcpServers);
          sessionId = created.sessionId;
          debug("walkthrough-acp", "created session:", sessionId);
          if (params.onSessionId) params.onSessionId(sessionId);

          // Push a phase event immediately so the stream guard's first-event
          // timer resets — the model may take minutes to produce its first
          // tool call (extended thinking), but the session is alive.
          lastPhaseMessage = "Waiting for model response...";
          push({ type: "phase", data: { phase: "connecting", message: lastPhaseMessage } });

          // ── 3. Stream session updates into the normalized pipeline ───────
          const decodeState = makeAcpDecodeState();
          h.setListener(sessionId, (update) => {
            for (const ev of decodeAcpSessionUpdate(update, decodeState)) handleAgentEvent(ev);
          });

          // ── 4. Prompt and await the turn ─────────────────────────────────
          debug(
            "walkthrough-acp",
            `prompting session ${sessionId}`,
            "model:",
            model ?? "(default)",
          );
          const stopReason = await h.prompt(sessionId, [{ type: "text", text: userMessage }]);

          if (ctx.wasCancelled() || ctx.wasTimeout()) {
            cancelled = true;
            anySummaryEmitted = false;
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
      logError("walkthrough-acp", "queryTask error:", message);
      if (!errorEmitted) {
        errorEmitted = true;
        push({ type: "error", data: { code: "AiGenerationError", message } });
      }
      return ZERO_TOKEN_USAGE;
    } finally {
      clearInterval(heartbeatInterval);
      if (handle && sessionId) handle.setListener(sessionId, null);
      await params.deps.unregisterActivityNotifier(params.walkthroughId).catch(() => {
        /* ignore */
      });
      if (sessionToken) {
        try {
          await params.deps.clearSessionToken(sessionToken);
        } catch {
          /* ignore */
        }
      }
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

    // Parity with the pre-migration drivers: a resumed run past Phase A skips
    // `set_overview`, so the in-memory `anySummaryEmitted` flag stays false even
    // though the row is fully populated. DB is authoritative (invariant #1) —
    // fall back to the persisted summary before emitting the fallback error.
    // Skip the fallback when the run was cancelled/timed out (explicit semantics
    // owned by `withAgentTurn`).
    let summaryPersisted = anySummaryEmitted;
    if (!summaryPersisted && !cancelled) {
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
      yield {
        type: "error" as const,
        data: {
          code: "NoSummaryGenerated",
          message:
            "The AI finished without producing a walkthrough. This can happen with complex PRs. Try regenerating.",
        },
      };
    }
  })();
}
