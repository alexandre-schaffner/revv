// ── chat-opencode ──────────────────────────────────────────────────────────
//
// Opencode driver for the right-pane chat. Talks to the opencode HTTP daemon
// via the `@opencode-ai/sdk` typed client, supplied by `OpencodeSupervisor`.
// Sessions live on the daemon side — we just remember the session id in
// `chat_sessions` and resume by re-using the same id on the next prompt.
//
// Mirrors the Claude path's shape (chat-claude.ts: import SDK directly, call
// typed methods, hand parts off to the shared agent-stream normalizer). The
// asymmetry is structural — Claude runs in-process; opencode runs against a
// long-lived HTTP daemon Revv owns — but the provider-level surface (param
// shape, normalized event union, emit→ChatStreamFrame mapping) is identical.

import type { InteractionMode } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_CHAT_TURN_TIMEOUT_MS } from "../../constants";
import { AiGenerationError } from "../../domain/errors";
import { debug, logError } from "../../logger";
import { recordSpan } from "../../observability/tracer";
import type { OpencodeClient, OpencodeEndpoint } from "../../services/OpencodeSupervisor";
import {
  buildActivity,
  extractOpencodeErrorMessage,
  fluidEmit,
  type NormalizedAgentEvent,
  parseOpencodeModel,
  subscribeOpencodeStream,
  walkOpencodePartsWithState,
  withAgentTurn,
} from "../agent-stream";
import { AgentUnavailableError } from "./chat-agent-errors";
import type { RawChatStreamFrame } from "./chat-claude";

export { AgentUnavailableError } from "./chat-agent-errors";

// ── Manual span helper for non-Effect async paths ─────────────────────────────

async function traced<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const startMs = performance.now();
  try {
    const result = await fn();
    recordSpan(name, startMs, performance.now() - startMs, attrs);
    return result;
  } catch (err) {
    recordSpan(
      name,
      startMs,
      performance.now() - startMs,
      attrs,
      err instanceof Error
        ? { name: err.name, message: err.message }
        : { name: "Error", message: String(err) },
    );
    throw err;
  }
}

export interface OpencodeChatDeps {
  readonly ensureDaemon: () => Promise<OpencodeEndpoint>;
  readonly jobStarted: () => Promise<void>;
  readonly jobEnded: () => Promise<void>;
  readonly client: () => Promise<OpencodeClient | null>;
  /**
   * Mint a bearer token bound to the current PR, user, actor, and
   * interaction mode for the chat MCP route. The route uses these to
   * stamp `walkthroughs.lastEditedBy` and to filter edit tools out of
   * `tools/list` in plan mode.
   */
  readonly issueChatMcpToken: (args: {
    prId: string;
    userId: string;
    actor: "chat:opencode";
    interactionMode: InteractionMode;
  }) => Promise<string>;
  /** Revoke the token once the turn ends. */
  readonly clearChatMcpToken: (token: string) => Promise<void>;
  /**
   * Check whether the running daemon exposes an agent with this name.
   * Used to gate plan mode: if the user's opencode install has no `plan`
   * agent (custom .opencode/opencode.toml), the driver falls back to the
   * default agent and emits a structured AgentUnavailableError instead of
   * silently degrading.
   */
  readonly hasAgent: (name: string) => Promise<boolean>;
}

/**
 * Thrown when the chat driver is asked for plan mode but the daemon has no
 * `plan` agent configured. Carried up to the route which surfaces it as a
 * 422 with a `code: 'AGENT_UNAVAILABLE'` body the client can interpret.
 */
export interface StreamChatViaOpencodeOptions {
  readonly message: string;
  readonly systemPrompt: string;
  readonly resumeSessionId?: string | undefined;
  readonly cwd: string;
  /**
   * Awaited by the driver before posting the user message, so the route's
   * SQLite upsert of `(prId, agent, headSha) → sessionId` commits before
   * any user-visible content streams. Closes the race where a follow-up
   * turn would otherwise see no row and create a fresh agent session.
   */
  readonly onSessionId?: ((id: string) => Promise<void> | void) | undefined;
  readonly abortController?: AbortController | undefined;
  readonly model?: string | undefined;
  readonly deps: OpencodeChatDeps;
  /** Used in the daemon-side session title for tracing. */
  readonly prId: string;
  /**
   * Authenticated user id from the chat session. Threaded through to the
   * MCP token registry so the chat-context HTTP route can stamp
   * `walkthroughs.lastEditedBy` when edit tools fire.
   */
  readonly userId: string;
  /**
   * Session-level interaction toggle. When `'plan'`, the driver requests
   * the named `plan` agent for this turn. The agent's full assistant text
   * is buffered and synthesized into a `plan-presented` event before
   * the stream closes (opencode's plan agent doesn't emit a structured
   * delimiter — the entire turn IS the plan). Also gates which MCP tools
   * are exposed: edit tools are hidden in plan mode.
   */
  readonly interactionMode?: InteractionMode | undefined;
}

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";

export function streamChatViaOpencode(
  opts: StreamChatViaOpencodeOptions,
): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream<RawChatStreamFrame>({
    async start(controller) {
      let chatMcpToken: string | null = null;
      let sessionId: string | null = opts.resumeSessionId ?? null;

      try {
        await opts.deps.ensureDaemon();
        const client = await opts.deps.client();
        if (!client) {
          throw new Error("OpencodeSupervisor reports daemon-running but no HTTP client available");
        }

        // Plan-mode gate. The named `plan` agent must exist on the
        // running daemon. If absent we surface a structured error
        // instead of silently running the default agent (which would
        // happily mutate the worktree against the user's request).
        const planMode = opts.interactionMode === "plan";
        if (planMode) {
          const planAvailable = await opts.deps.hasAgent("plan");
          if (!planAvailable) {
            throw new AgentUnavailableError("plan");
          }
        }

        // Mint a token + register the chat-context MCP server with the
        // daemon so the agent can call `get_review_context` AND the
        // walkthrough-edit tools for this PR. The token registry
        // carries (prId, userId, actor, interactionMode) so the
        // route can stamp lastEditedBy and filter edit tools by mode.
        // Token is revoked in `finally`.
        chatMcpToken = await opts.deps.issueChatMcpToken({
          prId: opts.prId,
          userId: opts.userId,
          actor: "chat:opencode",
          interactionMode: opts.interactionMode ?? "default",
        });
        // Use the runtime port (dev mode is 45679, prod is API_PORT 45678).
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/chat-context`;
        const registrationName = `${CHAT_CONTEXT_MCP_SERVER}-${opts.prId}`;
        try {
          // `mcp.add` returns 200 with `{ [name]: McpStatus }`. We
          // omit `throwOnError` so we can inspect the status — the
          // daemon also returns 200 for failed connections, and the
          // only structured signal is the embedded status.
          const result = await traced("opencode.mcp.add", { name: registrationName }, () =>
            client.mcp.add({
              directory: opts.cwd,
              name: registrationName,
              config: {
                type: "remote",
                url: mcpUrl,
                headers: {
                  Authorization: `Bearer ${chatMcpToken}`,
                },
              },
            }),
          );
          if (result.error) {
            throw new Error(
              `opencode mcp.add failed: ${
                (result.error as { data?: { message?: string } }).data?.message ?? "unknown error"
              }`,
            );
          }
          const entry = result.data?.[registrationName];
          if (entry && entry.status !== "connected") {
            throw new Error(
              `opencode mcp.add: '${registrationName}' status=${entry.status}${
                "error" in entry && typeof entry.error === "string" ? ` — ${entry.error}` : ""
              }`,
            );
          }
        } catch (err) {
          // Non-fatal — the agent still has Read/Grep/Edit/Bash. We
          // just lose the structured-context shortcut.
          debug(
            "chat-opencode",
            "chat-context MCP register failed:",
            err instanceof Error ? err.message : String(err),
          );
        }

        // Create a fresh session if no resume id was provided. The cwd is
        // passed to the daemon so its built-in tools (Read/Edit/Bash)
        // operate on our chat worktree.
        if (!sessionId) {
          const created = await traced(
            "opencode.session.create",
            { cwd: opts.cwd, title: `revv-chat-${opts.prId}` },
            () =>
              client.session.create(
                { directory: opts.cwd, title: `revv-chat-${opts.prId}` },
                { throwOnError: true },
              ),
          );
          sessionId = created.data.id;
          // Await: this commits the SQLite row that lets the next
          // chat turn resume this session. Posting before the row
          // lands risks a follow-up `find()` returning null and
          // silently starting a fresh session with no context.
          if (opts.onSessionId) await opts.onSessionId(sessionId);
        }

        const turnSessionId = sessionId;

        // Map normalized events → ChatStreamFrame. Reasoning is
        // surfaced; tool-calls become activities. The MCP server name
        // the chat-context tool is registered under varies per PR
        // (`revv-chat-context-<prId>`), so we accept any MCP source
        // here — the agent only has one MCP tool wired up, the
        // `get_review_context` one we just registered.
        //
        // `hasEmittedText` + `lastWasNonText` insert a paragraph break
        // before any text-delta that follows a non-text event so
        // "text → tool → text" sequences render as distinct paragraphs
        // in the assistant bubble instead of concatenating into one
        // blob. The separator lands in the persisted content too —
        // reloads stay legible. Note: text-deltas within a single
        // part are still appended seamlessly (lastWasNonText only
        // flips on tool/reasoning/error), so streaming a long answer
        // doesn't gain spurious breaks.
        let hasEmittedText = false;
        let lastWasNonText = false;
        // In plan mode we buffer the assistant text and synthesize a
        // single `plan-presented` event before closing the stream.
        // Opencode's `plan` agent doesn't emit a structured plan
        // delimiter — the entire assistant turn IS the plan.
        const planTextBuffer: string[] = planMode ? [] : [];
        const emit = (ev: NormalizedAgentEvent): void => {
          if (ev.kind === "text-delta") {
            if (planMode) planTextBuffer.push(ev.data);
            const needsSeparator = hasEmittedText && lastWasNonText && !ev.data.startsWith("\n");
            const data = needsSeparator ? `\n\n${ev.data}` : ev.data;
            controller.enqueue({ kind: "text", data });
            hasEmittedText = true;
            lastWasNonText = false;
          } else if (ev.kind === "reasoning-delta") {
            controller.enqueue({ kind: "reasoning", data: ev.data });
            lastWasNonText = true;
          } else if (ev.kind === "tool-call") {
            const activity = buildActivity(ev.toolName, ev.input);
            const frame = ev.subagentProviderCallId
              ? {
                  kind: "activity" as const,
                  ...activity,
                  subagentProviderCallId: ev.subagentProviderCallId,
                }
              : { kind: "activity" as const, ...activity };
            controller.enqueue(frame);
            lastWasNonText = true;
          } else if (ev.kind === "task-list-update") {
            controller.enqueue({
              kind: "task-list",
              tasks: ev.tasks,
            });
            lastWasNonText = true;
          } else if (ev.kind === "plan-presented") {
            controller.enqueue({
              kind: "plan-presented",
              providerPlanId: ev.providerPlanId,
              markdown: ev.markdown,
            });
            lastWasNonText = true;
          } else if (ev.kind === "subagent-start") {
            controller.enqueue({
              kind: "subagent-start",
              providerCallId: ev.providerCallId,
              subagentType: ev.subagentType,
              description: ev.description,
              prompt: ev.prompt,
            });
            lastWasNonText = true;
          } else if (ev.kind === "subagent-end") {
            controller.enqueue({
              kind: "subagent-end",
              providerCallId: ev.providerCallId,
              result: ev.result,
              ok: ev.ok,
            });
            lastWasNonText = true;
          } else if (ev.kind === "user-question-asked") {
            controller.enqueue({
              kind: "user-question",
              providerRequestId: ev.providerRequestId,
              questions: ev.questions,
              previewFormat: ev.previewFormat,
              ...(ev.providerToolCallId ? { providerToolCallId: ev.providerToolCallId } : {}),
            });
            lastWasNonText = true;
          } else if (ev.kind === "user-question-resolved") {
            controller.enqueue({
              kind: "user-question-resolved",
              providerRequestId: ev.providerRequestId,
              status: ev.status,
              ...(ev.answers !== undefined ? { answers: ev.answers } : {}),
            });
            lastWasNonText = true;
          } else if (ev.kind === "error") {
            logError("chat-opencode", "session.error:", ev.message);
            controller.enqueue({
              kind: "text",
              data: `\n\n_Error: ${ev.message}_`,
            });
            hasEmittedText = true;
            lastWasNonText = false;
          }
        };

        // `fluidEmit` chunks any oversized text/reasoning delta into
        // smaller word-aligned pieces before they reach `emit`. Used
        // for both the live SSE subscription and the post-response
        // backstop so the chat bubble streams at a typewriter pace
        // regardless of how the daemon batches frames. The wrapped
        // `emit` retains its `hasEmittedText` / `lastWasNonText`
        // separator state — only the first sub-chunk receives the
        // `\n\n` prefix, which is exactly the desired behaviour.
        const wrappedEmit = fluidEmit(emit);

        await withAgentTurn({
          externalAbort: opts.abortController,
          hardTimeoutMs: CLI_CHAT_TURN_TIMEOUT_MS,
          jobStarted: opts.deps.jobStarted,
          jobEnded: opts.deps.jobEnded,
          debugLabel: "chat-opencode",
          abortSession: async () => {
            const c = await opts.deps.client();
            if (!c) return;
            // Omitting `throwOnError` lets the 404-when-already-done
            // race surface as `result.error` instead of an exception
            // we'd have to swallow. The SDK types the 404 path as
            // NotFoundError — we ignore both branches since either
            // way the daemon side has stopped.
            const abortResult = await traced(
              "opencode.session.abort",
              { sessionID: turnSessionId },
              () =>
                c.session.abort({
                  sessionID: turnSessionId,
                }),
            );
            if (abortResult.error) {
              const status = abortResult.response.status;
              if (status !== 404) {
                logError("chat-opencode", `abortSession non-ok (${status})`);
              }
            }
          },
          run: async (ctx) => {
            // Shared dedup state between the SSE subscription and the
            // post-hoc `walkOpencodePartsWithState` backstop. SSE
            // delivers events in real-time; the backstop catches
            // anything SSE missed (subscription timing, late connect,
            // dropped frames). Same maps → events emitted once.
            const emittedTextLen = new Map<string, number>();
            const seenToolPartIds = new Set<string>();
            // Shared with the SSE subscription so it learns user
            // message IDs from `message.updated` events and skips
            // their parts. Also shared with the backstop walk so
            // the same filter applies to the synchronous
            // `response.parts` body — without this, opencode echoes
            // the user's input back into the assistant bubble.
            const userMessageIDs = new Set<string>();
            // Sub-agent / todo dedup state — shared with backstop
            // walk so we don't double-emit start/end events or
            // stale task snapshots.
            const seenAgentStartPartIds = new Set<string>();
            const lastTodoSnapshotHash: { value: string | null } = {
              value: null,
            };
            const subagentMessageIdMap = new Map<string, string>();

            // Subscribe to /global/event SSE in parallel with prompt.
            const sseAbort = new AbortController();
            const sseDone = subscribeOpencodeStream(
              client,
              turnSessionId,
              sseAbort.signal,
              wrappedEmit,
              {
                emittedTextLen,
                seenToolPartIds,
                userMessageIDs,
                seenAgentStartPartIds,
                lastTodoSnapshotHash,
                subagentMessageIdMap,
              },
            );

            // Compose the turn signal: if the harness aborts (timeout
            // or external cancel), tear down the SSE subscription
            // immediately rather than waiting for prompt.
            const onTurnAbort = (): void => sseAbort.abort();
            if (ctx.signal.aborted) onTurnAbort();
            else ctx.signal.addEventListener("abort", onTurnAbort, { once: true });

            const wireModel = parseOpencodeModel(opts.model);
            const promptResult = await traced(
              "opencode.session.prompt",
              { sessionID: turnSessionId, model: wireModel, agent: planMode ? "plan" : undefined },
              () =>
                client.session
                  .prompt(
                    {
                      sessionID: turnSessionId,
                      directory: opts.cwd,
                      parts: [{ type: "text", text: opts.message }],
                      ...(opts.resumeSessionId ? {} : { system: opts.systemPrompt }),
                      ...(wireModel !== undefined ? { model: wireModel } : {}),
                      // Plan-mode: route through the named `plan`
                      // agent. We pre-flighted its existence above,
                      // so a daemon missing the agent has already
                      // failed with AgentUnavailableError.
                      ...(planMode ? { agent: "plan" } : {}),
                    },
                    {
                      // Thread the harness signal so a timeout or
                      // external cancel tears down the HTTP call even
                      // if the daemon's `/abort` endpoint doesn't
                      // promptly close the long-poll.
                      signal: ctx.signal,
                      throwOnError: true,
                    },
                  )
                  .finally(() => {
                    ctx.signal.removeEventListener("abort", onTurnAbort);
                    sseAbort.abort();
                  }),
            );
            await sseDone;

            const response = promptResult.data;

            // opencode returns 200 even when the agent loop fails
            // (e.g., model not found, provider auth missing). The
            // error is embedded under `info.error`. Surface it so
            // callers see a real error instead of silently empty
            // content.
            const errObj = response.info.error;
            if (errObj) {
              throw new Error(`opencode agent error: ${extractOpencodeErrorMessage(errObj)}`);
            }

            // Backstop: walk the full response parts with the SAME
            // dedup maps the SSE just used. Anything SSE already
            // streamed is a no-op here; anything it missed (e.g.
            // the SSE handshake landed after the first event) gets
            // emitted now from the synchronous response body.
            const tooledParts = response.parts.filter((p) => p.type === "tool").length;
            debug(
              "chat-opencode",
              `backstop walk: response.parts.length=${response.parts.length} tool-parts=${tooledParts} SSE-seen tools=${seenToolPartIds.size} / text-or-reasoning=${emittedTextLen.size}`,
            );
            walkOpencodePartsWithState(
              response.parts,
              {
                emittedTextLen,
                seenToolPartIds,
                userMessageIDs,
                // The turn's authoritative assistant message
                // ID. Anything in `response.parts` with a
                // different `messageID` is not assistant
                // output and must not be emitted — this is
                // what stops the user-message echo at the
                // backstop boundary, even if the
                // `message.updated` SSE event for the user
                // happened to race the parts walk.
                assistantMessageID: response.info.id,
                seenAgentStartPartIds,
                subagentMessageIdMap,
              },
              wrappedEmit,
            );
          },
        });

        // Plan-mode synthesis: emit a single plan-presented event
        // with the entire buffered assistant turn as its markdown.
        // One per turn — the route's persistence wrapper drops a
        // chat_plans row keyed on (session, turn) so a duplicate
        // synthesis (shouldn't happen, but defensive) would surface
        // as a unique-constraint violation rather than two cards.
        if (planMode) {
          const planMarkdown = planTextBuffer.join("").trim();
          if (planMarkdown.length > 0) {
            controller.enqueue({
              kind: "plan-presented",
              providerPlanId: `opencode-plan-${turnSessionId}-${Date.now()}`,
              markdown: planMarkdown,
            });
          }
        }

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError("chat-opencode", "queryTask error:", msg);
        controller.error(new AiGenerationError({ cause: err, message: msg }));
      } finally {
        if (chatMcpToken) {
          try {
            await opts.deps.clearChatMcpToken(chatMcpToken);
          } catch {
            /* ignore */
          }
        }
      }
    },
  });
}
