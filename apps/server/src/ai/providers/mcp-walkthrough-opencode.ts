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
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
} from "@revv/shared";
import { API_PORT } from "@revv/shared";
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
const EXPLORATION_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"Bash",
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

	const userMessage =
		WALKTHROUGH_MCP_SYSTEM_PROMPT +
		"\n\n---\n\n" +
		buildWalkthroughPrompt(params, undefined, params.continuation);

	const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
		// ── 1. Start daemon (or attach to existing) ──────────────────────
		await params.deps.jobStarted();
		let sessionToken: string | null = null;
		let sessionId: string | null = null;

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
			const mcpUrl = `http://127.0.0.1:${API_PORT}/mcp/walkthrough`;
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
							push({
								type: "exploration",
								data: { tool, description },
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

			await client.postMessage({
				sessionId,
				parts: postParts,
				system: WALKTHROUGH_MCP_SYSTEM_PROMPT,
				...(model !== undefined ? { model } : {}),
			});

			// The postMessage resolves when the daemon finishes producing the
			// turn (or returns control). We still wait for the SSE loop to
			// drain so any trailing events land before we return.
			subscribeController.abort();
			await subscribePromise;

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
//     UI feedback.
//   - Error / failure events — so we can emit a terminal `error`.
//
// Content events (summary, block, issue, rating, sentiment, phase:advanced)
// are NEVER emitted from this path — they flow through WalkthroughJobs.emitEvent
// from the HTTP MCP route's handlers, which is the authoritative commit-first
// path (doctrine invariant #8).

interface EventCallbacks {
	onExploration: (tool: string, description: string) => void;
	onError: (message: string) => void;
}

/**
 * Walk an opencode /event envelope and emit translated callbacks. The
 * opencode event shape is: `{ type: "...", properties: { ... } }` where
 * `type` is something like `session.updated`, `message.part.updated`, etc.
 * We're conservative: unknown shapes are ignored.
 *
 * TODO(verify): the exact event envelope from opencode is documented at
 * https://opencode.ai/docs/api — confirm the shapes below once an end-to-end
 * run has been validated. The current implementation tolerates both flat
 * (`ev.tool`) and nested (`ev.properties.part.tool`) shapes.
 */
function translateOpencodeEvent(
	ev: unknown,
	cb: EventCallbacks,
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
	const toolName =
		partObj && typeof partObj["tool"] === "string"
			? (partObj["tool"] as string)
			: typeof props["tool"] === "string"
				? (props["tool"] as string)
				: null;

	if ((partType === "tool" || partType === "tool_use") && toolName) {
		if (EXPLORATION_TOOLS.has(toolName)) {
			const state =
				partObj && typeof partObj["state"] === "object"
					? (partObj["state"] as Record<string, unknown>)
					: null;
			const input = state?.["input"] ?? props["input"];
			cb.onExploration(toolName, buildExplorationDescription(toolName, input));
			return;
		}
		// MCP tool calls flow through the HTTP route — do not surface here.
		return;
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
