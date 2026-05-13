// ── chat-opencode ──────────────────────────────────────────────────────────
//
// Opencode driver for the right-pane chat. Talks to the opencode HTTP daemon
// via the supervisor. Sessions live on the daemon side — we just remember
// the session id in `chat_sessions` and resume by `postMessage`-ing to the
// same id.
//
// Streaming decode (SSE event handling, per-partId dedup, the 100ms drain)
// and the abort + hard-timeout envelope live in `../agent-stream.ts`. This
// file owns chat-specific concerns: MCP review-context registration, session
// creation, and the mapping from `NormalizedAgentEvent` → `ChatStreamFrame`.

import type { InteractionMode } from "@revv/shared";
import { AiGenerationError } from "../../domain/errors";
import { serverEnv } from "../../config";
import { CLI_CHAT_TURN_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import type {
	OpencodeEndpoint,
	OpencodeHttpClient,
} from "../../services/OpencodeSupervisor";
import {
	buildActivity,
	subscribeOpencodeStream,
	walkOpencodePartsWithState,
	withAgentTurn,
	type NormalizedAgentEvent,
} from "../agent-stream";
import type { RawChatStreamFrame } from "./chat-claude";

export interface OpencodeChatDeps {
	readonly ensureDaemon: () => Promise<OpencodeEndpoint>;
	readonly jobStarted: () => Promise<void>;
	readonly jobEnded: () => Promise<void>;
	readonly client: () => Promise<OpencodeHttpClient | null>;
	/** Mint a bearer token bound to the current PR for the chat MCP route. */
	readonly issueChatMcpToken: (prId: string) => Promise<string>;
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
export class AgentUnavailableError extends Error {
	readonly code = "AGENT_UNAVAILABLE";
	constructor(public readonly agentName: string) {
		super(
			`opencode daemon has no agent named '${agentName}'. Install or configure one in .opencode/opencode.toml.`,
		);
		this.name = "AgentUnavailableError";
	}
}

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
	readonly onSessionId?:
		| ((id: string) => Promise<void> | void)
		| undefined;
	readonly abortController?: AbortController | undefined;
	readonly model?: string | undefined;
	readonly deps: OpencodeChatDeps;
	/** Used in the daemon-side session title for tracing. */
	readonly prId: string;
	/**
	 * Session-level interaction toggle. When `'plan'`, the driver requests
	 * the named `plan` agent for this turn. The agent's full assistant text
	 * is buffered and synthesized into a `plan-presented` event before
	 * the stream closes (opencode's plan agent doesn't emit a structured
	 * delimiter — the entire turn IS the plan).
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
					throw new Error(
						"OpencodeSupervisor reports daemon-running but no HTTP client available",
					);
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

				// Mint a token + register the read-only chat-context MCP server
				// with the daemon so the agent can call `get_review_context`
				// for this PR. Token is revoked in `finally`.
				chatMcpToken = await opts.deps.issueChatMcpToken(opts.prId);
				// Use the runtime port (dev mode is 45679, prod is API_PORT 45678).
				const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/chat-context`;
				const registrationName = `${CHAT_CONTEXT_MCP_SERVER}-${opts.prId}`;
				try {
					await client.registerMcp({
						name: registrationName,
						directory: opts.cwd,
						config: {
							type: "remote",
							url: mcpUrl,
							headers: {
								Authorization: `Bearer ${chatMcpToken}`,
							},
						},
					});
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
					const created = await client.createSession({
						title: `revv-chat-${opts.prId}`,
						directory: opts.cwd,
					});
					sessionId = created.id;
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
						const needsSeparator =
							hasEmittedText && lastWasNonText && !ev.data.startsWith("\n");
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
							source: ev.source,
							tasks: ev.tasks,
						});
						lastWasNonText = true;
					} else if (ev.kind === "plan-presented") {
						controller.enqueue({
							kind: "plan-presented",
							providerPlanId: ev.providerPlanId,
							markdown: ev.markdown,
							source: ev.source,
						});
						lastWasNonText = true;
					} else if (ev.kind === "subagent-start") {
						controller.enqueue({
							kind: "subagent-start",
							providerCallId: ev.providerCallId,
							subagentType: ev.subagentType,
							description: ev.description,
							prompt: ev.prompt,
							source: ev.source,
						});
						lastWasNonText = true;
					} else if (ev.kind === "subagent-end") {
						controller.enqueue({
							kind: "subagent-end",
							providerCallId: ev.providerCallId,
							result: ev.result,
							ok: ev.ok,
							source: ev.source,
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

				await withAgentTurn({
					externalAbort: opts.abortController,
					hardTimeoutMs: CLI_CHAT_TURN_TIMEOUT_MS,
					jobStarted: opts.deps.jobStarted,
					jobEnded: opts.deps.jobEnded,
					debugLabel: "chat-opencode",
					abortSession: async () => {
						const c = await opts.deps.client();
						if (!c) return;
						await c.abortSession(turnSessionId);
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
						const agentEndedPartIds = new Set<string>();
						const lastTodoSnapshotHash: { value: string | null } = {
							value: null,
						};
						const subagentMessageIdMap = new Map<string, string>();

						// Subscribe to /event SSE in parallel with postMessage.
						const sseAbort = new AbortController();
						const sseDone = subscribeOpencodeStream(
							client,
							turnSessionId,
							sseAbort.signal,
							emit,
							{
								emittedTextLen,
								seenToolPartIds,
								userMessageIDs,
								seenAgentStartPartIds,
								agentEndedPartIds,
								lastTodoSnapshotHash,
								subagentMessageIdMap,
							},
						);

						// Compose the turn signal: if the harness aborts (timeout
						// or external cancel), tear down the SSE subscription
						// immediately rather than waiting for postMessage.
						const onTurnAbort = (): void => sseAbort.abort();
						if (ctx.signal.aborted) onTurnAbort();
						else ctx.signal.addEventListener("abort", onTurnAbort, { once: true });

						const postParams: Record<string, unknown> = {
							sessionId: turnSessionId,
							parts: [{ type: "text", text: opts.message }],
							// Thread the harness signal so a timeout or
							// external cancel tears down the HTTP call even
							// if the daemon's `/abort` endpoint doesn't
							// promptly close the long-poll. Without this,
							// `timeout: false` on the underlying fetch could
							// hang the turn indefinitely after a cancel.
							signal: ctx.signal,
						};
						if (!opts.resumeSessionId) {
							postParams["system"] = opts.systemPrompt;
						}
						if (opts.model !== undefined) {
							postParams["model"] = opts.model;
						}
						postParams["directory"] = opts.cwd;
						// Plan-mode: route through the named `plan` agent.
						// We pre-flighted its existence above, so a daemon
						// missing the agent has already failed with
						// AgentUnavailableError.
						if (planMode) {
							postParams["agent"] = "plan";
						}

						let response: Awaited<ReturnType<typeof client.postMessage>> | null = null;
						try {
							response = await client.postMessage(
								postParams as unknown as Parameters<typeof client.postMessage>[0],
							);
						} finally {
							ctx.signal.removeEventListener("abort", onTurnAbort);
							sseAbort.abort();
							await sseDone;
						}

						// Backstop: walk the full response parts with the SAME
						// dedup maps the SSE just used. Anything SSE already
						// streamed is a no-op here; anything it missed (e.g.
						// the SSE handshake landed after the first event) gets
						// emitted now from the synchronous response body. This
						// is what unsticks the "agent ended with empty bubble"
						// failure mode on opencode-backed chats.
						if (response && Array.isArray(response.parts)) {
							// Always-on (no REV_DEBUG required): the
							// "agent silent / no tool calls visible"
							// failure mode is the load-bearing question
							// for this driver, so we surface the SSE-vs-
							// response-parts counts unconditionally.
							const tooledParts = response.parts.filter(
								(p) =>
									typeof (p as { type?: unknown }).type === "string" &&
									(p as { type: string }).type === "tool",
							).length;
							logError(
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
									agentEndedPartIds,
									subagentMessageIdMap,
								},
								emit,
							);
						}
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
							source: "opencode",
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
