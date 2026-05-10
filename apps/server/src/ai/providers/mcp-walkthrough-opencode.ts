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
//   4. Creates an opencode session, posts the user message, subscribes to
//      /event SSE filtered to this session, and translates the subset of
//      events we care about (exploration, error, session lifecycle) into
//      WalkthroughStreamEvent. Tool-call events do NOT come through here —
//      the tool handlers on the HTTP MCP route already emitted the
//      corresponding events via WalkthroughJobs.emitEvent.
//   5. Wires the caller's AbortController into `client.abortSession`.
//
// The 10-minute hard timeout is preserved (layered on top of the caller's
// controller). On stream end we synthesize `done` or `error` as appropriate.
//
// Dependencies (OpencodeSupervisor, WalkthroughJobs) are threaded in as
// plain callbacks through the `deps` parameter so this file has no Effect
// layer-graph cycles with Ai.ts.

import type {
	WalkthroughLifecyclePhase,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
} from "@revv/shared";
import { classifyTool } from "@revv/shared";
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
	buildExplorationDescription,
	buildWalkthroughPrompt,
	WALKTHROUGH_MCP_SYSTEM_PROMPT,
} from "../prompts/walkthrough";
import type { ContinuationContext } from "./mcp-walkthrough";
import type { Db } from "../../db";

// ── Built-in exploration tool suffixes opencode exposes ──────────────────────
//
// The HTTP MCP route handlers emit their own content events; we only need to
// surface exploration (Read / Grep / Glob / Bash) here so the UI can show
// what the model is looking at.
//
// Chat consumers (chat-opencode.ts) also want Write/Edit so the UI can show
// "Edited src/foo.ts" inline; the walkthrough caller never produces those
// because its tool surface is read-only.
//
// Opencode's daemon emits built-in tool names in lowercase (`read`, `grep`,
// `bash`, …) on /event, while the rest of Revv uses Anthropic's canonical
// capitalized form (`Read`, `Grep`, …). The map below normalizes opencode's
// shape into the canonical names so `EXPLORATION_TOOLS.has(...)` and
// `buildExplorationDescription` keep working. Without this, every opencode
// tool event slipped past the lookup and the provider's queue stayed empty,
// tripping the guard's 90 s first-event timeout on every walkthrough run.
const OPENCODE_TOOL_NAME_MAP: Record<string, string> = {
	read: "Read",
	grep: "Grep",
	glob: "Glob",
	bash: "Bash",
	write: "Write",
	edit: "Edit",
	list: "LS",
	todoread: "TodoRead",
	todowrite: "TodoWrite",
};

function normalizeToolName(raw: string): string {
	return OPENCODE_TOOL_NAME_MAP[raw.toLowerCase()] ?? raw;
}

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
	let cancelledByCaller = false;
	// Phase tracking mirrors the Claude SDK path (mcp-walkthrough.ts:293-365)
	// so both providers emit the same phase lifecycle (invariant #13). We key
	// off MCP tool-call names since that's what the agent actually does.
	let currentPhase: WalkthroughLifecyclePhase = "connecting";
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
		// ── 1. Start daemon (or attach to existing) ──────────────────────
		await params.deps.jobStarted();

		// No artificial keepalive: every MCP tool handler calls
		// WalkthroughJobs.emitEvent → activity notifier → push() (see below),
		// and every opencode exploration event pushes through onExploration.
		// Both reset the stream-guard's inactivity timer, so genuine silence
		// for >120s is a real stall we want surfaced, not papered over with
		// a fake "Waiting for model response..." chip the user has to read.

		let sessionToken: string | null = null;
		let sessionId: string | null = null;

		// Register a heartbeat so the stream guard's inactivity timer resets on
		// every MCP tool call, even if the opencode SSE subscription misses events.
		await params.deps.registerActivityNotifier(params.walkthroughId, (event) => {
			if (!queryDone && !errorEmitted && !cancelledByCaller) {
				push(event);
			}
		});

		const externalAbort = params.abortController;
		let killed = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const onExternalAbort = () => {
			cancelledByCaller = true;
			debug(
				"walkthrough-opencode-mcp",
				"external abort received — calling abortSession",
			);
			if (sessionId) {
				void (async () => {
					const client = await params.deps.client();
					if (!client) return;
					try {
						await client.abortSession(sessionId!);
					} catch (err) {
						debug(
							"walkthrough-opencode-mcp",
							"abortSession failed:",
							err instanceof Error ? err.message : String(err),
						);
					}
				})();
			}
		};

		try {
			const endpoint = await params.deps.ensureDaemon();
			const client = await params.deps.client();
			if (!client) {
				throw new Error(
					"OpencodeSupervisor reports daemon-running but no HTTP client available",
				);
			}

			// Hook abort listeners as early as possible.
			if (externalAbort) {
				if (externalAbort.signal.aborted) {
					cancelledByCaller = true;
				} else {
					externalAbort.signal.addEventListener("abort", onExternalAbort, {
						once: true,
					});
				}
			}

			// Wall-clock hard timeout.
			timeoutId = setTimeout(() => {
				killed = true;
				debug(
					"walkthrough-opencode-mcp",
					"hard timeout — aborting session",
				);
				try {
					externalAbort?.abort(
						new Error(
							`Walkthrough generation timed out after ${Math.round(
								CLI_WALKTHROUGH_TIMEOUT_MS / 60_000,
							)} minutes`,
						),
					);
				} catch {
					/* already aborted */
				}
			}, CLI_WALKTHROUGH_TIMEOUT_MS);

			// ── 2. Issue session token + register MCP server ─────────────
			sessionToken = await params.deps.issueSessionToken(params.walkthroughId);
			// Use the runtime port (`serverEnv.port` reads `PORT` env var with
			// 45678 default) — dev mode runs on 45679 via `make dev`, and
			// hardcoding `API_PORT` would point opencode at the wrong port.
			const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/walkthrough`;
			const registrationName = `revv-walkthrough-${params.walkthroughId}`;
			debug(
				"walkthrough-opencode-mcp",
				`registering MCP ${registrationName} → ${mcpUrl}`,
				"endpoint:",
				`${endpoint.hostname}:${endpoint.port}`,
			);
			await client.registerMcp({
				name: registrationName,
				config: {
					type: "remote",
					url: mcpUrl,
					headers: {
						Authorization: `Bearer ${sessionToken}`,
					},
				},
			});

			// ── 3. Create opencode session ──────────────────────────────
			const created = await client.createSession({
				title: `walkthrough-${params.walkthroughId}`,
				...(params.continuation?.opencodeSessionId !== undefined
					? { parentID: params.continuation.opencodeSessionId }
					: {}),
			});
			sessionId = created.id;
			debug("walkthrough-opencode-mcp", "created session:", sessionId);
			if (params.onSessionId) params.onSessionId(sessionId);

			// ── 4. Subscribe to /event BEFORE posting the message ───────
			//
			// Race-free: we need the SSE listener active before the model
			// starts emitting events. The subscription runs as a fire-and-
			// forget Promise; we abort it via the external controller on
			// finish.
			const subscribeController = new AbortController();
			if (externalAbort) {
				externalAbort.signal.addEventListener(
					"abort",
					() => subscribeController.abort(),
					{ once: true },
				);
			}

		const subscribePromise = client.subscribeToEvents({
				sessionId,
				signal: subscribeController.signal,
				onEvent: (ev: unknown) => {
					translateOpencodeEvent(ev, {
						onExploration: (tool, description) => {
							transitionPhase(
								"exploring",
								"Reading files and understanding changes...",
							);
							push({
								type: "exploration",
								data: {
									activityKind: classifyTool(tool),
									toolName: tool,
									summary: description,
								},
							});
						},
						onError: (message) => {
							if (!errorEmitted) {
								errorEmitted = true;
								push({
									type: "error",
									data: { code: "AiGenerationError", message },
								});
							}
						},
						onMcpTool: (rawToolName) => {
							// Opencode prefixes MCP tool names with the registered
							// server name (e.g. `revv-walkthrough-<id>_set_overview`)
							// or similar. We don't know the exact format up front
							// across opencode versions, so match by suffix on the
							// stable function names defined in walkthroughMcpRoute.
							const suffix = (s: string): boolean =>
								rawToolName === s || rawToolName.endsWith(`_${s}`);
							if (suffix("set_overview")) {
								anySummaryEmitted = true;
								transitionPhase(
									"analyzing",
									"Forming assessment and risk analysis...",
								);
							} else if (suffix("add_diff_step")) {
								transitionPhase("writing", "Building walkthrough...");
							} else if (suffix("rate_axis")) {
								transitionPhase(
									"rating",
									"Scoring the PR across 9 axes...",
								);
							} else if (suffix("complete_walkthrough")) {
								transitionPhase("finishing", "Wrapping up...");
							} else if (currentPhase === "connecting") {
								// Other MCP tools (get_walkthrough_state,
								// set_sentiment, flag_issue, add_issue_comment)
								// don't drive their own phase transition, but if
								// they're the agent's first action we still need
								// to leave 'connecting' so the guard's first-event
								// timer resets. "exploring" is the right initial
								// phase: the agent is gathering state before it
								// produces content.
								transitionPhase(
									"exploring",
									"Reading files and understanding changes...",
								);
							}
						},
					});
				},
			}).catch((err) => {
				// Aborts are expected on finish; anything else is noteworthy.
				if (!subscribeController.signal.aborted) {
					debug(
						"walkthrough-opencode-mcp",
						"SSE subscribe ended:",
						err instanceof Error ? err.message : String(err),
					);
				}
			});

		// ── 5. Post the user message ────────────────────────────────
		const postParts = [{ type: "text", text: userMessage }];
		debug(
			"walkthrough-opencode-mcp",
			`posting message to session ${sessionId}`,
			"model:",
			model ?? "(default)",
		);

		try {
			await client.postMessage({
				sessionId,
				parts: postParts,
				system: WALKTHROUGH_MCP_SYSTEM_PROMPT,
				...(model !== undefined ? { model } : {}),
			});
		} finally {
			// Always abort the SSE subscription and drain it — whether postMessage
			// resolved normally, threw, or was externally cancelled. Without this,
			// a postMessage failure leaves the subscription running indefinitely.
			subscribeController.abort();
			await subscribePromise;
		}

			// Fabricate anySummaryEmitted signal from the DB side-effects:
			// if anything landed for this walkthroughId via /mcp/walkthrough
			// we consider the run successful. We don't have a direct channel
			// to know this from inside the provider (content events went
			// through WalkthroughJobs.emitEvent, bypassing `push`), so we
			// rely on the orchestrator's DB poll (in WalkthroughJobs) to
			// detect completion. For our own generator-end signal we treat
			// "no error emitted and not cancelled" as a successful run.
			anySummaryEmitted = !errorEmitted && !cancelledByCaller;

			return {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logError("walkthrough-opencode-mcp", "queryTask error:", message);
			if (!killed && !cancelledByCaller && !errorEmitted) {
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
			if (timeoutId !== undefined) clearTimeout(timeoutId);
			if (externalAbort) {
				externalAbort.signal.removeEventListener("abort", onExternalAbort);
			}
			await params.deps.unregisterActivityNotifier(params.walkthroughId).catch(() => {/* ignore */});
			if (sessionToken) {
				try {
					await params.deps.clearSessionToken(sessionToken);
				} catch {
					/* ignore */
				}
			}
			try {
				await params.deps.jobEnded();
			} catch {
				/* ignore */
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

	// Text deltas — assistant message content. opencode emits text either as
	// a standalone `partType === "text"` (with `.text` on the part) or via
	// `message.part.updated` events whose props carry `{ delta: { text } }`.
	// We handle both shapes; consumers that don't care about text (walkthrough)
	// just don't pass `onText`.
	if (cb.onText) {
		if (partType === "text" && partObj) {
			const text =
				typeof partObj["text"] === "string"
					? (partObj["text"] as string)
					: null;
			if (text) {
				cb.onText(text);
				return;
			}
		}
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
