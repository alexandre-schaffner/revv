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
//   3. Registers /mcp/walkthrough on the daemon as a remote MCP server,
//      passing the bearer token in the connection headers.
//   4. Creates an opencode session, posts the user message, walks the
//      returned `response.parts` via the shared agent-stream decoder, and
//      maps normalized events into WalkthroughStreamEvents. Tool-call
//      content does NOT come through here — the tool handlers on the HTTP
//      MCP route already emitted the corresponding events via
//      WalkthroughJobs.emitEvent (commit-first; doctrine invariant #8).
//   5. Wires the caller's AbortController into `client.abortSession` via
//      the shared `withAgentTurn` harness.
//
// Streaming decode (`walkOpencodeParts`) and the abort + hard-timeout
// envelope (`withAgentTurn`) live in `../agent-stream.ts`.

import type {
	WalkthroughLifecyclePhase,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
} from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import type { UserSettings } from "@revv/shared";
import type {
	OpencodeEndpoint,
	OpencodeHttpClient,
} from "../../services/OpencodeSupervisor";
import {
	buildWalkthroughPrompt,
	WALKTHROUGH_MCP_SYSTEM_PROMPT,
} from "../prompts/walkthrough";
import {
	buildActivity,
	subscribeOpencodeStream,
	walkOpencodePartsWithState,
	withAgentTurn,
	type NormalizedAgentEvent,
} from "../agent-stream";
import type { ContinuationContext } from "./mcp-walkthrough";
import type { Db } from "../../db";

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
	/** Fetch the current supervisor HTTP client (may be null if daemon died). */
	client: () => Promise<OpencodeHttpClient | null>;
	/** Mint a session token bound to this walkthroughId. */
	issueSessionToken: (walkthroughId: string) => Promise<string>;
	/** Invalidate the token when we're done. */
	clearSessionToken: (token: string) => Promise<void>;
	/** Register a heartbeat notifier in WalkthroughJobs so the stream guard timer resets on each MCP tool call. */
	registerActivityNotifier: (walkthroughId: string, callback: (event: WalkthroughStreamEvent) => void) => Promise<void>;
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
	 * cancel, scope finalizer, shutdown), we invoke `client.abortSession` on
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
	let lastReasoningPush = 0;
	const transitionPhase = (
		next: WalkthroughLifecyclePhase,
		message: string,
	): void => {
		if (currentPhase === next) return;
		currentPhase = next;
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
					await client.abortSession(sessionId);
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
					await client.registerMcp({
						name: WALKTHROUGH_MCP_SERVER,
						directory: params.worktreePath,
						config: {
							type: "remote",
							url: mcpUrl,
							headers: {
								Authorization: `Bearer ${sessionToken}`,
							},
						},
					});
					debug(
						"walkthrough-opencode-mcp",
						`MCP registration result: name=${WALKTHROUGH_MCP_SERVER} status=connected (registration succeeded)`,
					);

					// ── 2. Create opencode session ──────────────────────────
					const created = await client.createSession({
						title: `walkthrough-${params.walkthroughId}`,
						directory: params.worktreePath,
						...(params.continuation?.opencodeSessionId !== undefined
							? { parentID: params.continuation.opencodeSessionId }
							: {}),
					});
					sessionId = created.id;
					debug("walkthrough-opencode-mcp", "created session:", sessionId);
					if (params.onSessionId) params.onSessionId(sessionId);

					// Immediately push a phase event so the stream guard's first-event
					// timer resets — the model may take minutes to produce its first
					// tool call (extended thinking), but the session is alive.
					push({ type: "phase", data: { phase: "connecting", message: "Waiting for model response..." } });

					// ── 3. Post the user message and process response parts ──
					//
					// opencode 1.14.x returns the full agent turn synchronously
					// in `response.parts`. MCP tool calls (set_overview,
					// add_diff_step, etc.) still flow through the HTTP MCP
					// route (doctrine invariant #8); we only handle exploration
					// tool feedback + reasoning-keepalive here.
					const postParts = [{ type: "text", text: userMessage }];
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
							transitionPhase(
								"exploring",
								"Reading files and understanding changes...",
							);
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
							transitionPhase(
								"exploring",
								"Reading files and understanding changes...",
							);
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
						const matchSuffix = (s: string): boolean =>
							ev.bareName === s || ev.bareName.endsWith(`_${s}`);

						if (matchSuffix("set_overview")) {
							anySummaryEmitted = true;
							transitionPhase("analyzing", "Forming assessment and risk analysis...");
						} else if (
							matchSuffix("add_semantic_step") ||
							matchSuffix("add_diff_step")
						) {
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
					// in the synchronous `response.parts` after postMessage
					// returns. That's why the UI used to render MCP work
					// live but show no exploration pills until the agent
					// finished.
					//
					// Subscribing to /event in parallel with postMessage
					// surfaces those built-in events as soon as the daemon
					// emits them. The dedup state is shared with the
					// backstop walk below so events SSE already streamed
					// are no-ops in the post-hoc pass.
					const emittedTextLen = new Map<string, number>();
					const seenToolPartIds = new Set<string>();
					const sseAbort = new AbortController();
					const sseDone = subscribeOpencodeStream(
						client,
						sessionId,
						sseAbort.signal,
						emit,
						{ emittedTextLen, seenToolPartIds },
					);

					const onTurnAbort = (): void => sseAbort.abort();
					if (ctx.signal.aborted) onTurnAbort();
					else ctx.signal.addEventListener("abort", onTurnAbort, { once: true });

					let response: Awaited<ReturnType<typeof client.postMessage>> | null = null;
					try {
						response = await client.postMessage({
							sessionId,
							parts: postParts,
							system: WALKTHROUGH_MCP_SYSTEM_PROMPT,
							directory: params.worktreePath,
							// Thread the harness signal so timeout/cancel tears
							// down the HTTP call even if the daemon `/abort`
							// doesn't promptly close the long-poll.
							signal: ctx.signal,
							...(model !== undefined ? { model } : {}),
						});
					} finally {
						ctx.signal.removeEventListener("abort", onTurnAbort);
						sseAbort.abort();
						await sseDone;
					}

					// Log each part for observability — historically helpful
					// when the daemon shipped a new part shape.
					if (response) {
						for (const part of response.parts) {
							debug(
								"walkthrough-opencode-mcp",
								"response part:",
								part.type,
								JSON.stringify(part).slice(0, 200),
							);
						}

						// Always-on summary log (no REV_DEBUG required). The
						// "agent ran but no vanilla tool calls" failure mode is
						// the load-bearing question for this driver — surfacing
						// the SSE-vs-response-parts counts unconditionally lets
						// us tell at a glance whether tool parts ever existed
						// in the first place.
						const tooledParts = response.parts.filter(
							(p) =>
								typeof (p as { type?: unknown }).type === "string" &&
								(p as { type: string }).type === "tool",
						).length;
						logError(
							"walkthrough-opencode-mcp",
							`backstop walk: response.parts.length=${response.parts.length} tool-parts=${tooledParts} SSE-seen tools=${seenToolPartIds.size} / text-or-reasoning=${emittedTextLen.size}`,
						);

						// Backstop walk: emit anything SSE missed via the synchronous
						// response body. Shared dedup maps make this a no-op for
						// anything SSE already streamed.
						walkOpencodePartsWithState(
							response.parts,
							{ emittedTextLen, seenToolPartIds },
							emit,
						);
					}

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

					return {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
					};
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
			await params.deps.unregisterActivityNotifier(params.walkthroughId).catch(() => {/* ignore */});
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

// ── Opencode /event → WalkthroughStreamEvent translator ──────────────────────
//
// We only surface the subset of events we care about here:
//   - Exploration tool calls (Read/Grep/Glob/Bash) — for the "reading files"
//     UI feedback. The caller maps this to a `phase: 'exploring'` plus an
//     `exploration` event.
//   - MCP tool calls (e.g. set_overview, add_diff_step) — for phase
//     transitions only. The content those tools wrote flows through the
//     HTTP MCP route (invariant #8). Surfaced via the opt-in `onMcpTool`
//     callback so chat consumers can keep ignoring them.
//   - Error / failure events — so we can emit a terminal `error`.
//
// Content events (summary, block, issue, rating, sentiment, phase:advanced)
// are NEVER emitted from this path — they flow through WalkthroughJobs.emitEvent
// from the HTTP MCP route's handlers, which is the authoritative commit-first
// path (doctrine invariant #8).

/**
 * Callbacks the opencode event interpreter feeds. `onText` is opt-in — the
 * walkthrough caller leaves it undefined because content events for that
 * pipeline flow through the MCP tool handlers (doctrine invariant #8). The
 * chat caller (chat-opencode.ts) provides it to surface assistant text
 * deltas.
 *
 * `onMcpTool` is opt-in too. The walkthrough caller uses it to drive phase
 * transitions (analyzing/writing/rating/finishing) when the agent calls an
 * MCP tool — the content of those calls still flows through the HTTP MCP
 * route (invariant #8), but the *phase signal* needs to reach the provider's
 * queue so the guard's first-event timer resets and agent-path parity
 * (invariant #13) holds with the Claude SDK path.
 */
export interface OpencodeEventCallbacks {
	readonly onExploration: (tool: string, description: string) => void;
	readonly onError: (message: string) => void;
	readonly onText?: ((chunk: string) => void) | undefined;
	readonly onMcpTool?: ((tool: string) => void) | undefined;
}

/**
 * Walk an opencode /event envelope and emit translated callbacks. The
 * opencode event shape (verified against `opencode serve` 1.4.x) is:
 *
 *   { type: "message.part.updated",
 *     properties: { sessionID: "...",
 *                   part: { type: "tool", tool: "read",
 *                           callID: "...",
 *                           state: { status: "pending"|"running"|"completed",
 *                                    input: {...} } } } }
 *
 * Each tool call produces three updates (pending → running → completed). We
 * fire callbacks once, on `running`, when the input is fully populated; this
 * dedupes UI rows and phase transitions while still resetting the guard's
 * first-event timer on the agent's first real action. Unknown shapes are
 * tolerated: if `state.status` is missing we fire on the first event we see.
 */
export function translateOpencodeEvent(
	ev: unknown,
	cb: OpencodeEventCallbacks,
): void {
	if (ev === null || typeof ev !== "object") return;
	const root = ev as Record<string, unknown>;
	const type = typeof root["type"] === "string" ? root["type"] : null;
	const props =
		root["properties"] && typeof root["properties"] === "object"
			? (root["properties"] as Record<string, unknown>)
			: root;

	// Tool-use events — find the tool name + input.
	const maybePart = props["part"];
	const partObj =
		maybePart && typeof maybePart === "object"
			? (maybePart as Record<string, unknown>)
			: null;
	const partType =
		partObj && typeof partObj["type"] === "string"
			? (partObj["type"] as string)
			: null;
	const rawToolName =
		partObj && typeof partObj["tool"] === "string"
			? (partObj["tool"] as string)
			: typeof props["tool"] === "string"
				? (props["tool"] as string)
				: null;

	if ((partType === "tool" || partType === "tool_use") && rawToolName) {
		// Opencode emits three events per tool call (pending → running →
		// completed). Fire callbacks once, on `running`, when the input is
		// fully populated. This avoids duplicate UI rows and duplicate phase
		// transitions while still resetting the guard's first-event timer
		// on the agent's first real action.
		const state =
			partObj && typeof partObj["state"] === "object"
				? (partObj["state"] as Record<string, unknown>)
				: null;
		const status =
			state && typeof state["status"] === "string"
				? (state["status"] as string)
				: null;
		// Tolerate missing/legacy shapes: if there's no state.status field
		// we fire once on the first event we see for this part type.
		if (status !== null && status !== "running") return;

		const toolName = normalizeToolName(rawToolName);
		if (EXPLORATION_TOOLS.has(toolName)) {
			const input = state?.["input"] ?? props["input"];
			cb.onExploration(toolName, buildExplorationDescription(toolName, input));
			return;
		}
		// MCP tool calls — content flows through the HTTP MCP route per
		// invariant #8, but we still notify the caller so it can emit a
		// phase event (invariant #13: agent-path parity with the Claude
		// SDK path which fires phase transitions on tool_use blocks).
		cb.onMcpTool?.(rawToolName);
		return;
	}

	// Text deltas — assistant message content. opencode emits incremental text
	// via `message.part.updated` events whose props carry `{ delta: { text } }`.
	// We use ONLY the delta path here. The full-text `partType === "text"` path
	// is intentionally omitted: it carries the cumulative text (not a delta),
	// which would re-emit the entire response on every update — causing echoes.
	// User-message parts also arrive as `partType === "text"` and would be
	// incorrectly emitted as assistant text. The postMessage backstop in
	// chat-opencode.ts catches any deltas missed by the SSE path.
	if (cb.onText) {
		// Only emit text from delta events (incremental chunks).
		const delta = props["delta"];
		if (delta && typeof delta === "object") {
			const deltaText = (delta as Record<string, unknown>)["text"];
			if (typeof deltaText === "string" && deltaText.length > 0) {
				cb.onText(deltaText);
				return;
			}
		}
	}

	// Error events.
	if (type && /error/i.test(type)) {
		const message =
			typeof props["message"] === "string"
				? (props["message"] as string)
				: typeof props["error"] === "string"
					? (props["error"] as string)
					: `opencode reported error (${type})`;
	cb.onError(message);
	return;
	}
}
