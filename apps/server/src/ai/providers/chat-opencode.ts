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
import type { ChatStreamFrame } from "./chat-claude";

export interface OpencodeChatDeps {
	readonly ensureDaemon: () => Promise<OpencodeEndpoint>;
	readonly jobStarted: () => Promise<void>;
	readonly jobEnded: () => Promise<void>;
	readonly client: () => Promise<OpencodeHttpClient | null>;
	/** Mint a bearer token bound to the current PR for the chat MCP route. */
	readonly issueChatMcpToken: (prId: string) => Promise<string>;
	/** Revoke the token once the turn ends. */
	readonly clearChatMcpToken: (token: string) => Promise<void>;
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
}

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";

export function streamChatViaOpencode(
	opts: StreamChatViaOpencodeOptions,
): ReadableStream<ChatStreamFrame> {
	return new ReadableStream<ChatStreamFrame>({
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
				const emit = (ev: NormalizedAgentEvent): void => {
					if (ev.kind === "text-delta") {
						controller.enqueue({ kind: "text", data: ev.data });
					} else if (ev.kind === "reasoning-delta") {
						controller.enqueue({ kind: "reasoning", data: ev.data });
					} else if (ev.kind === "tool-call") {
						const activity = buildActivity(ev.toolName, ev.input);
						controller.enqueue({ kind: "activity", ...activity });
					} else if (ev.kind === "error") {
						logError("chat-opencode", "session.error:", ev.message);
						controller.enqueue({
							kind: "text",
							data: `\n\n_Error: ${ev.message}_`,
						});
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

						// Subscribe to /event SSE in parallel with postMessage.
						const sseAbort = new AbortController();
						const sseDone = subscribeOpencodeStream(
							client,
							turnSessionId,
							sseAbort.signal,
							emit,
							{ emittedTextLen, seenToolPartIds },
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
								{ emittedTextLen, seenToolPartIds },
								emit,
							);
						}
					},
				});

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
