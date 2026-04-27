// ── chat-opencode ──────────────────────────────────────────────────────────
//
// Opencode driver for the right-pane chat. Talks to the opencode HTTP daemon
// via the supervisor. Sessions live on the daemon side — we just remember
// the session id in `chat_sessions` and resume by `postMessage`-ing to the
// same id.
//
// Surfaces a unified frame stream (`{kind: 'text' | 'tool', data}`) shared
// with the Claude path so the chat route doesn't have to branch.

import { AiGenerationError } from "../../domain/errors";
import { API_PORT } from "@revv/shared";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import type {
	OpencodeEndpoint,
	OpencodeHttpClient,
} from "../../services/OpencodeSupervisor";
import { translateOpencodeEvent } from "./mcp-walkthrough-opencode";
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
	readonly onSessionId?: ((id: string) => void) | undefined;
	readonly abortController?: AbortController | undefined;
	readonly model?: string | undefined;
	readonly deps: OpencodeChatDeps;
	/** Used in the daemon-side session title for tracing. */
	readonly prId: string;
}

export function streamChatViaOpencode(
	opts: StreamChatViaOpencodeOptions,
): ReadableStream<ChatStreamFrame> {
	return new ReadableStream<ChatStreamFrame>({
		async start(controller) {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let jobStarted = false;
			let killed = false;
			const externalAbort = opts.abortController;
			let sessionId: string | null = opts.resumeSessionId ?? null;
			let onExternalAbort: (() => void) | null = null;
			const subscribeController = new AbortController();
			let chatMcpToken: string | null = null;

			try {
				await opts.deps.jobStarted();
				jobStarted = true;

				await opts.deps.ensureDaemon();
				const client = await opts.deps.client();
				if (!client) {
					throw new Error(
						"OpencodeSupervisor reports daemon-running but no HTTP client available",
					);
				}

				// Wall-clock hard timeout — same envelope the walkthrough uses.
				timeoutId = setTimeout(() => {
					killed = true;
					debug("chat-opencode", "hard timeout — aborting session");
					try {
						externalAbort?.abort(
							new Error(
								`Chat turn timed out after ${Math.round(
									CLI_WALKTHROUGH_TIMEOUT_MS / 60_000,
								)} minutes`,
							),
						);
					} catch {
						/* already aborted */
					}
				}, CLI_WALKTHROUGH_TIMEOUT_MS);

				if (externalAbort) {
					if (externalAbort.signal.aborted) {
						subscribeController.abort();
					} else {
						onExternalAbort = () => {
							subscribeController.abort();
							if (sessionId) {
								void (async () => {
									const c = await opts.deps.client();
									if (!c) return;
									try {
										await c.abortSession(sessionId!);
									} catch (err) {
										debug(
											"chat-opencode",
											"abortSession failed:",
											err instanceof Error ? err.message : String(err),
										);
									}
								})();
							}
						};
						externalAbort.signal.addEventListener("abort", onExternalAbort, {
							once: true,
						});
					}
				}

				// Mint a token + register the read-only chat-context MCP server
				// with the daemon so the agent can call `get_review_context`
				// for this PR. Token is revoked in `finally`.
				chatMcpToken = await opts.deps.issueChatMcpToken(opts.prId);
				const mcpUrl = `http://127.0.0.1:${API_PORT}/mcp/chat-context`;
				const registrationName = `revv-chat-context-${opts.prId}`;
				try {
					await client.registerMcp({
						name: registrationName,
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
					});
					sessionId = created.id;
					if (opts.onSessionId) opts.onSessionId(sessionId);
				}

				// Subscribe BEFORE posting so we never miss the leading deltas.
				const subscribePromise = client
					.subscribeToEvents({
						sessionId,
						signal: subscribeController.signal,
						onEvent: (ev: unknown) => {
							translateOpencodeEvent(ev, {
								onExploration: (_tool, description) => {
									controller.enqueue({ kind: "tool", data: description });
								},
								onError: (message) => {
									// Emit as a text frame so the user sees what went wrong;
									// the route will still forward [DONE] as normal afterwards.
									controller.enqueue({
										kind: "text",
										data: `\n\n_Error from agent: ${message}_`,
									});
								},
								onText: (chunk) => {
									controller.enqueue({ kind: "text", data: chunk });
								},
							});
						},
					})
					.catch((err) => {
						if (!subscribeController.signal.aborted) {
							debug(
								"chat-opencode",
								"SSE subscribe ended:",
								err instanceof Error ? err.message : String(err),
							);
						}
					});

				// Only attach the system prompt on session create — opencode
				// retains it across postMessage calls in the same session.
				const postParams: Record<string, unknown> = {
					sessionId,
					parts: [{ type: "text", text: opts.message }],
				};
				if (!opts.resumeSessionId) {
					postParams["system"] = opts.systemPrompt;
				}
				if (opts.model !== undefined) {
					postParams["model"] = opts.model;
				}

				await client.postMessage(
					postParams as unknown as Parameters<typeof client.postMessage>[0],
				);

				subscribeController.abort();
				await subscribePromise;
				controller.close();
			} catch (err) {
				if (killed) {
					controller.error(
						new AiGenerationError({
							cause: err,
							message:
								err instanceof Error ? err.message : "Chat turn timed out",
						}),
					);
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					logError("chat-opencode", "queryTask error:", msg);
					controller.error(new AiGenerationError({ cause: err, message: msg }));
				}
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
				if (externalAbort && onExternalAbort) {
					externalAbort.signal.removeEventListener("abort", onExternalAbort);
				}
				if (chatMcpToken) {
					try {
						await opts.deps.clearChatMcpToken(chatMcpToken);
					} catch {
						/* ignore */
					}
				}
				if (jobStarted) {
					try {
						await opts.deps.jobEnded();
					} catch {
						/* ignore */
					}
				}
			}
		},
	});
}
