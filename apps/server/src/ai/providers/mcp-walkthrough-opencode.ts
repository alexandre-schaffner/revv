// ─── mcp-walkthrough-opencode ───────────────────────────────────────────────
//
// Opencode driver. Delegates all tool handling to the shared HTTP MCP route
// (apps/server/src/routes/mcp/walkthrough.ts) which runs the SAME handlers the
// Claude SDK path uses. Per doctrine invariant #13 (agent-path parity), there
// is no "opencode-side tool logic" anymore — this file is purely a session
// driver that:
//
//   1. Asks the OpencodeSupervisor for a running daemon (lazy-started).
//   2. Obtains a one-time session token from WalkthroughJobs for the job.
//   3. Calls `client.mcp.add` to register `/mcp/walkthrough` on the daemon
//      as a remote MCP server, passing the bearer token in the connection
//      headers.
//   4. Calls `client.session.create`, then `client.session.prompt` and walks
//      the returned `response.parts` via the shared agent-stream decoder.
//      Tool-call content does NOT come through here — the tool handlers on
//      the HTTP MCP route already emitted the corresponding events via
//      WalkthroughJobs.emitEvent (commit-first; doctrine invariant #8).
//   5. Wires the caller's AbortController into `client.session.abort` via
//      the shared `withAgentTurn` harness.
//
// Streaming decode (`walkOpencodeParts` / `subscribeOpencodeStream`) and the
// abort + hard-timeout envelope (`withAgentTurn`) live in `../agent-stream.ts`.

import type {
  UserSettings,
  WalkthroughLifecyclePhase,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS, WALKTHROUGH_HEARTBEAT_MS } from "../../constants";
import type { Db } from "../../db";
import { debug, logError } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import type { OpencodeClient, OpencodeEndpoint } from "../../services/OpencodeSupervisor";
import {
  buildActivity,
  extractOpencodeErrorMessage,
  type NormalizedAgentEvent,
  parseOpencodeModel,
  subscribeOpencodeStream,
  walkOpencodePartsWithState,
  withAgentTurn,
} from "../agent-stream";
import { buildWalkthroughPrompt, WALKTHROUGH_MCP_SYSTEM_PROMPT } from "../prompts/walkthrough";
import type { ContinuationContext } from "./mcp-walkthrough";
import { TOOL_SPECS } from "./walkthrough-tools";

// ── Built-in exploration tool surface ───────────────────────────────────────
//
// The HTTP MCP route handlers emit their own content events; we only need to
// surface exploration here (Read / Grep / Glob / Bash plus Write / Edit /
// TodoRead / TodoWrite for visibility into mutating tools) so the UI can
// show what the model is looking at. Tool-name normalisation lives in
// `@revv/shared/activity.ts` and is applied inside `buildActivity`.
const EXPLORATION_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Write",
  "Edit",
  "TodoRead",
  "TodoWrite",
]);

const WALKTHROUGH_MCP_SERVER = "revv-walkthrough";

// ── Deps injected by the caller (AiService) ──────────────────────────────────

export interface OpencodeProviderDeps {
  /** Ensure the daemon is running; returns credentials + port. */
  ensureDaemon: () => Promise<OpencodeEndpoint>;
  /** Bump active-job ref count on the supervisor. */
  jobStarted: () => Promise<void>;
  /** Decrement ref count so the supervisor can idle-stop. */
  jobEnded: () => Promise<void>;
  /** Fetch the current supervisor SDK client (may be null if daemon died). */
  client: () => Promise<OpencodeClient | null>;
  /** Mint a session token bound to this walkthroughId. */
  issueSessionToken: (walkthroughId: string) => Promise<string>;
  /** Invalidate the token when we're done. */
  clearSessionToken: (token: string) => Promise<void>;
  /** Register a heartbeat notifier in WalkthroughJobs so the stream guard timer resets on each MCP tool call. */
  registerActivityNotifier: (
    walkthroughId: string,
    callback: (event: WalkthroughStreamEvent) => void,
  ) => Promise<void>;
  /** Unregister the heartbeat notifier (called from finally). */
  unregisterActivityNotifier: (walkthroughId: string) => Promise<void>;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export interface OpencodeStreamParams {
  walkthroughId: string;
  db: Db;
  pr: {
    title: string;
    body: string | null;
    sourceBranch: string;
    targetBranch: string;
    url: string;
  };
  files: PrFileMeta[];
  worktreePath: string;
  continuation?: ContinuationContext;
  onSessionId?: (sessionId: string) => void;
  /**
   * Caller-owned abort signal. When `.abort()` is called upstream (user
   * cancel, scope finalizer, shutdown), we invoke `client.session.abort` on
   * the daemon so the model stops producing output. The 10-minute timeout
   * layers on top, routing through the same controller.
   */
  abortController?: AbortController;
  /** Injected dependencies (supervisor + session-token accessors). */
  deps: OpencodeProviderDeps;
}

/**
 * Stream a walkthrough through the persistent opencode daemon. Replaces the
 * prior "spawn `opencode run` per job + stdio MCP" design.
 */
export function streamWalkthroughViaOpencodeMCP(
  params: OpencodeStreamParams,
  model?: string,
  _settings?: UserSettings,
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
  // Tracked outside the harness so the activity-notifier closure (registered
  // before `withAgentTurn`) can suppress late events that arrive after the
  // user hit "regenerate" or the hard-timeout fired.
  let cancelled = false;
  // Phase tracking mirrors the Claude SDK path so both providers emit the
  // same phase lifecycle (invariant #13). We key off MCP tool-call bare
  // names since that's what the agent actually does.
  let currentPhase: WalkthroughLifecyclePhase = "connecting";
  // Last message paired with `currentPhase`. Re-emitted by the periodic
  // heartbeat (see WALKTHROUGH_HEARTBEAT_MS) so the UI doesn't churn while
  // we keep the stream guard's inactivity timer alive.
  let lastPhaseMessage = "Starting up...";
  let lastReasoningPush = 0;
  // Mirrors the Claude SDK path (invariant #13 agent-path parity).
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
    // Forward-only: never roll the phase machine back (e.g. heartbeats must not
    // override a "writing" phase with "exploring"). Matches the Claude SDK path.
    if (PHASE_ORDER.indexOf(next) < PHASE_ORDER.indexOf(currentPhase)) return;
    currentPhase = next;
    lastPhaseMessage = message;
    push({ type: "phase", data: { phase: next, message } });
  };

  const userMessage =
    WALKTHROUGH_MCP_SYSTEM_PROMPT +
    "\n\n---\n\n" +
    buildWalkthroughPrompt(params, undefined, params.continuation);

  const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
    let sessionToken: string | null = null;
    let sessionId: string | null = null;

    // Register a heartbeat so the stream guard's inactivity timer resets on
    // every MCP tool call, even if opencode events are processed synchronously.
    await params.deps.registerActivityNotifier(params.walkthroughId, (event) => {
      if (!queryDone && !errorEmitted && !cancelled) {
        push(event);
      }
    });

    // Periodic phase heartbeat — guarantees the stream guard sees an event
    // every WALKTHROUGH_HEARTBEAT_MS while the prompt is in flight, even when
    // SSE reasoning-delta events are temporarily silent (e.g. between turns
    // or before the first reasoning burst in extended-thinking mode). Re-emits
    // the current phase + last meaningful message so the UI stays stable.
    const heartbeatInterval = setInterval(() => {
      if (queryDone || errorEmitted || cancelled) return;
      push({
        type: "phase",
        data: { phase: currentPhase, message: lastPhaseMessage },
      });
    }, WALKTHROUGH_HEARTBEAT_MS);

    try {
      return await withAgentTurn({
        externalAbort: params.abortController,
        hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
        jobStarted: params.deps.jobStarted,
        jobEnded: params.deps.jobEnded,
        debugLabel: "walkthrough-opencode-mcp",
        onCancel: () => {
          cancelled = true;
        },
        onTimeout: () => {
          cancelled = true;
        },
        abortSession: async () => {
          if (!sessionId) return;
          const client = await params.deps.client();
          if (!client) return;
          // Omitting `throwOnError` lets the 404-when-already-done
          // race surface as `result.error` instead of an exception.
          const abortResult = await client.session.abort({
            sessionID: sessionId,
          });
          if (abortResult.error) {
            const status = abortResult.response.status;
            if (status !== 404) {
              logError("walkthrough-opencode-mcp", `abortSession non-ok (${status})`);
            }
          }
        },
        run: async (ctx) => {
          const endpoint = await params.deps.ensureDaemon();
          const client = await params.deps.client();
          if (!client) {
            throw new Error(
              "OpencodeSupervisor reports daemon-running but no HTTP client available",
            );
          }

          // ── 1. Issue session token + register MCP server ─────────
          sessionToken = await params.deps.issueSessionToken(params.walkthroughId);
          // Use the runtime port (`serverEnv.port` reads `PORT` env var with
          // 45678 default) — dev mode runs on 45679 via `make dev`, and
          // hardcoding `API_PORT` would point opencode at the wrong port.
          const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/walkthrough`;
          debug(
            "walkthrough-opencode-mcp",
            `registering MCP ${WALKTHROUGH_MCP_SERVER} → ${mcpUrl}`,
            "endpoint:",
            `${endpoint.hostname}:${endpoint.port}`,
          );
          // `mcp.add` returns 200 with `{ [name]: McpStatus }`. We
          // must verify the embedded status — the daemon returns 200
          // even when the connection fails. Surface anything that's
          // not `connected` so the user sees a real error instead of
          // the keepalive's "waiting" rows with no progress.
          const mcpResult = await client.mcp.add({
            directory: params.worktreePath,
            name: WALKTHROUGH_MCP_SERVER,
            config: {
              type: "remote",
              url: mcpUrl,
              headers: {
                Authorization: `Bearer ${sessionToken}`,
              },
            },
          });
          if (mcpResult.error) {
            const detail =
              (mcpResult.error as { data?: { message?: string } }).data?.message ?? "unknown error";
            throw new Error(`opencode mcp.add failed: ${detail}`);
          }
          const mcpEntry = mcpResult.data?.[WALKTHROUGH_MCP_SERVER];
          if (!mcpEntry) {
            throw new Error(`opencode mcp.add returned no status for '${WALKTHROUGH_MCP_SERVER}'`);
          }
          if (mcpEntry.status !== "connected") {
            throw new Error(
              `opencode mcp.add: '${WALKTHROUGH_MCP_SERVER}' status=${mcpEntry.status}${
                "error" in mcpEntry && typeof mcpEntry.error === "string"
                  ? ` — ${mcpEntry.error}`
                  : ""
              }`,
            );
          }
          debug(
            "walkthrough-opencode-mcp",
            `MCP registration result: name=${WALKTHROUGH_MCP_SERVER} status=connected (registration succeeded)`,
          );

          // ── 2. Create opencode session ──────────────────────────
          const created = await client.session.create(
            {
              directory: params.worktreePath,
              title: `walkthrough-${params.walkthroughId}`,
              ...(params.continuation?.opencodeSessionId !== undefined
                ? { parentID: params.continuation.opencodeSessionId }
                : {}),
            },
            { throwOnError: true },
          );
          sessionId = created.data.id;
          debug("walkthrough-opencode-mcp", "created session:", sessionId);
          if (params.onSessionId) params.onSessionId(sessionId);

          // Immediately push a phase event so the stream guard's first-event
          // timer resets — the model may take minutes to produce its first
          // tool call (extended thinking), but the session is alive.
          lastPhaseMessage = "Waiting for model response...";
          push({
            type: "phase",
            data: { phase: "connecting", message: lastPhaseMessage },
          });

          // ── 3. Post the user message and process response parts ──
          //
          // opencode 1.14.x returns the full agent turn synchronously
          // in `response.parts`. MCP tool calls (set_overview,
          // add_diff_step, etc.) still flow through the HTTP MCP
          // route (doctrine invariant #8); we only handle exploration
          // tool feedback + reasoning-keepalive here.
          debug(
            "walkthrough-opencode-mcp",
            `posting message to session ${sessionId}`,
            "model:",
            model ?? "(default)",
          );

          // Map normalized events → WalkthroughStreamEvents. Text is
          // dropped; reasoning fires a throttled phase heartbeat to
          // keep the stream guard alive; tool calls route through
          // the phase machine + exploration emit.
          const emit = (ev: NormalizedAgentEvent): void => {
            if (ev.kind === "text-delta") {
              // Text from the model signals an active session;
              // nudge into "exploring" if we're still warming up.
              transitionPhase("exploring", "Reading files and understanding changes...");
              return;
            }

            if (ev.kind === "reasoning-delta") {
              // Extended reasoning — keep stream guard alive
              // (throttled to once per 30s). The opencode driver
              // owns this heartbeat because the agent-side
              // reasoning may run for 60+ s without producing a
              // tool call, which would otherwise look like a
              // stalled stream to the guard.
              const now = Date.now();
              if (now - lastReasoningPush >= 30_000) {
                lastReasoningPush = now;
                if (currentPhase === "connecting") {
                  transitionPhase("exploring", "Model is thinking...");
                } else {
                  push({
                    type: "phase",
                    data: {
                      phase: currentPhase,
                      message: "Model is thinking...",
                    },
                  });
                }
              }
              return;
            }

            if (ev.kind !== "tool-call") return;

            if (ev.source === "builtin" && EXPLORATION_TOOLS.has(ev.toolName)) {
              transitionPhase("exploring", "Reading files and understanding changes...");
              const activity = buildActivity(ev.toolName, ev.input);
              push({ type: "exploration", data: activity });
              return;
            }

            // MCP tool call — drive phase transitions. Opencode emits
            // MCP tool names without the `mcp__<server>__` prefix
            // (just the bare tool name, or sometimes prefixed with
            // the server name like `revv-walkthrough_set_overview`).
            // `classifyToolCallShape` puts the full name in
            // `bareName` when there's no `mcp__` prefix, so we
            // match against the trailing suffix.
            //
            // Constrain to the TOOL_SPECS allowlist (P6) so a rogue
            // or hallucinated tool name can't drive bogus phase transitions.
            const ALLOWED_PHASE_SUFFIXES = new Set(TOOL_SPECS.map((s) => s.name));
            const matchSuffix = (s: string): boolean => {
              if (!ALLOWED_PHASE_SUFFIXES.has(s)) {
                debug(
                  "opencode-phase",
                  `matchSuffix rejected unknown tool '${s}' — not in TOOL_SPECS`,
                );
                return false;
              }
              return ev.bareName === s || ev.bareName.endsWith(`_${s}`);
            };

            if (matchSuffix("set_overview")) {
              anySummaryEmitted = true;
              transitionPhase("analyzing", "Forming assessment and risk analysis...");
            } else if (matchSuffix("add_semantic_step") || matchSuffix("add_diff_step")) {
              transitionPhase("writing", "Building walkthrough...");
            } else if (matchSuffix("rate_axis")) {
              transitionPhase("rating", "Scoring the PR across 9 axes...");
            } else if (matchSuffix("complete_walkthrough")) {
              transitionPhase("finishing", "Wrapping up...");
            } else if (currentPhase === "connecting") {
              transitionPhase("exploring", "Reading files and understanding changes...");
            }
          };

          // ── SSE subscription for real-time builtin tool calls ──
          //
          // MCP tool events (set_overview, add_diff_step, …) reach
          // the UI in real-time via WalkthroughJobs.emitEvent → the
          // activity notifier registered above. Built-in tool
          // events (Read/Grep/Glob/Bash) DO NOT — they only show up
          // in the synchronous `response.parts` after prompt
          // returns. That's why the UI used to render MCP work
          // live but show no exploration pills until the agent
          // finished.
          //
          // Subscribing to /global/event in parallel with the prompt
          // surfaces those built-in events as soon as the daemon
          // emits them. The dedup state is shared with the backstop
          // walk below so events SSE already streamed are no-ops in
          // the post-hoc pass.
          const emittedTextLen = new Map<string, number>();
          const seenToolPartIds = new Set<string>();
          // Share with backstop walk so user-message parts (which
          // opencode includes in both the SSE stream and the
          // synchronous response body) don't leak through the
          // normalized-event pipeline as assistant text.
          const userMessageIDs = new Set<string>();
          const sseAbort = new AbortController();
          // Per-message latest tokens snapshot, keyed by assistant
          // messageId. Opencode's `info.tokens` (and step-finish
          // `part.tokens`) is per-CALL: within one agent turn the daemon
          // produces multiple assistant messages (one per tool-call
          // cycle), and each message's `output` only covers that single
          // LLM call. Treating the LATEST snapshot as the turn total
          // (the previous behavior) under-counted output by ~99% on
          // multi-step turns — the final "I'm done" message has ~50
          // output tokens while the actual turn produced thousands of
          // tool-argument bytes across many calls.
          //
          // Aggregation rules:
          //   - `output` / `reasoning` / `cache.write`: SUM across
          //     messages — each call produces new tokens of these.
          //   - `input` / `cache.read`: take the LATEST message's value
          //     — both grow monotonically with conversation history, so
          //     the latest call's prompt size is the meaningful "context
          //     window usage" figure (summing would double-count history).
          type MsgSnap = {
            input: number;
            output: number;
            reasoning: number;
            cacheRead: number;
            cacheWrite: number;
          };
          const perMessageSnap = new Map<string, MsgSnap>();
          const messageOrder: string[] = [];

          const updateMsgSnap = (
            messageId: string,
            tokens: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            },
          ): void => {
            if (!perMessageSnap.has(messageId)) {
              messageOrder.push(messageId);
            }
            perMessageSnap.set(messageId, {
              input: tokens.input,
              output: tokens.output,
              reasoning: tokens.reasoning,
              cacheRead: tokens.cache.read,
              cacheWrite: tokens.cache.write,
            });
          };

          const computeAggregateTokens = (): WalkthroughTokenUsage => {
            let outputSum = 0;
            let cacheWriteSum = 0;
            for (const m of perMessageSnap.values()) {
              outputSum += m.output + m.reasoning;
              cacheWriteSum += m.cacheWrite;
            }
            const latestId = messageOrder[messageOrder.length - 1];
            const latest = latestId !== undefined ? perMessageSnap.get(latestId) : undefined;
            return {
              inputTokens: latest?.input ?? 0,
              outputTokens: outputSum,
              cacheReadInputTokens: latest?.cacheRead ?? 0,
              cacheCreationInputTokens: cacheWriteSum,
            };
          };

          // Dedupe by *value*, not time. Opencode resends
          // `message.updated` (and step-finish parts) verbatim across
          // state transitions, so a time-throttle would either
          // suppress legitimate updates or pass redundant ones. A
          // snapshot key lets every real change through instantly
          // while collapsing no-op resends.
          let lastUsageKey = "";
          let tokenCallbackHits = 0;
          const onAssistantTokens = (
            messageId: string,
            tokens: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            },
          ): void => {
            tokenCallbackHits += 1;
            updateMsgSnap(messageId, tokens);
            const aggregate = computeAggregateTokens();
            const key = `${aggregate.inputTokens}|${aggregate.outputTokens}|${aggregate.cacheReadInputTokens}|${aggregate.cacheCreationInputTokens}`;
            logError(
              "walkthrough-opencode-mcp",
              `[usage-diag] onAssistantTokens hit=${tokenCallbackHits} msg=${messageId} key=${key} skip=${key === lastUsageKey}`,
            );
            if (key === lastUsageKey) return;
            lastUsageKey = key;
            push({
              type: "usage",
              data: { tokenUsage: aggregate },
            });
          };
          const sseDone = subscribeOpencodeStream(client, sessionId, sseAbort.signal, emit, {
            emittedTextLen,
            seenToolPartIds,
            userMessageIDs,
            onAssistantTokens,
          });

          const onTurnAbort = (): void => sseAbort.abort();
          if (ctx.signal.aborted) onTurnAbort();
          else ctx.signal.addEventListener("abort", onTurnAbort, { once: true });

          const wireModel = parseOpencodeModel(model);
          const promptResult = await client.session
            .prompt(
              {
                sessionID: sessionId,
                directory: params.worktreePath,
                parts: [{ type: "text", text: userMessage }],
                system: WALKTHROUGH_MCP_SYSTEM_PROMPT,
                ...(wireModel !== undefined ? { model: wireModel } : {}),
              },
              {
                // Thread the harness signal so timeout/cancel tears
                // down the HTTP call even if the daemon `/abort`
                // doesn't promptly close the long-poll.
                signal: ctx.signal,
                throwOnError: true,
              },
            )
            .finally(() => {
              ctx.signal.removeEventListener("abort", onTurnAbort);
              sseAbort.abort();
            });
          await sseDone;

          const response = promptResult.data;

          // opencode returns 200 even when the agent loop fails
          // (model not found, provider auth missing). Surface
          // embedded errors so callers see a real error instead of
          // silently empty content.
          const errObj = response.info.error;
          if (errObj) {
            throw new Error(`opencode agent error: ${extractOpencodeErrorMessage(errObj)}`);
          }

          // Log each part for observability — historically helpful
          // when the daemon shipped a new part shape.
          for (const part of response.parts) {
            debug(
              "walkthrough-opencode-mcp",
              "response part:",
              part.type,
              JSON.stringify(part).slice(0, 200),
            );
          }

          // SSE-vs-response-parts summary. Behind REV_DEBUG=1 — the
          // "agent ran but no vanilla tool calls" failure mode is no
          // longer the day-to-day concern it was during the SDK
          // migration; promote back to always-on if a regression
          // resurfaces.
          const tooledParts = response.parts.filter((p) => p.type === "tool").length;
          debug(
            "walkthrough-opencode-mcp",
            `backstop walk: response.parts.length=${response.parts.length} tool-parts=${tooledParts} SSE-seen tools=${seenToolPartIds.size} / text-or-reasoning=${emittedTextLen.size}`,
          );

          // Backstop walk: emit anything SSE missed via the synchronous
          // response body. Shared dedup maps make this a no-op for
          // anything SSE already streamed.
          walkOpencodePartsWithState(
            response.parts,
            {
              emittedTextLen,
              seenToolPartIds,
              userMessageIDs,
              assistantMessageID: response.info.id,
            },
            emit,
          );

          // Honour `wasCancelled` / `wasTimeout` distinction so the
          // terminal error message at the bottom of the generator
          // can be precise. `cancelled` means the user hit
          // "regenerate"; `timeout` means we hit the 10-minute wall.
          if (ctx.wasCancelled() || ctx.wasTimeout()) {
            cancelled = true;
            anySummaryEmitted = false;
          } else {
            anySummaryEmitted = !errorEmitted;
          }

          // Surface token usage from the opencode response (parity with
          // the Claude path, doctrine #13). The SDK reports input,
          // output, reasoning, and cache.{read,write} PER CALL — and
          // a turn contains multiple LLM calls (one per tool-use
          // cycle), each producing its own assistant message. We fold
          // `reasoning` into `outputTokens` because Claude's
          // `output_tokens` already includes its reasoning tokens —
          // keeping the four-field shape stable across agents.
          //
          // Backstop the per-message map from `response.parts` for any
          // step-finish parts SSE may have missed (drain race, dropped
          // frames). Then return the aggregate so the turn total
          // reflects ALL messages, not just the final closing one.
          for (const part of response.parts) {
            if (part.type === "step-finish") {
              updateMsgSnap(part.messageID, part.tokens);
            }
          }
          // Final-message backstop. `response.info` is the last
          // assistant message; its `tokens` is the most-recent snapshot
          // for that message and supersedes any earlier step-finish
          // value for the same messageID.
          updateMsgSnap(response.info.id, response.info.tokens);
          return computeAggregateTokens();
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("walkthrough-opencode-mcp", "queryTask error:", message);
      if (!errorEmitted) {
        errorEmitted = true;
        push({
          type: "error",
          data: { code: "AiGenerationError", message },
        });
      }
      return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
    } finally {
      clearInterval(heartbeatInterval);
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

    const tokenUsage = await resultPromise;

    if (anySummaryEmitted) {
      yield {
        type: "done" as const,
        data: {
          walkthroughId: params.walkthroughId,
          tokenUsage,
        },
      };
    } else if (!errorEmitted) {
      debug(
        "walkthrough-opencode-mcp",
        "Session ended without producing content — emitting fallback error",
      );
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
