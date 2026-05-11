// ── agent-stream ────────────────────────────────────────────────────────────
//
// Shared streaming-response handling for the four provider drivers — chat and
// walkthrough, Claude and opencode. Before this module, each driver decoded
// model output, classified tool calls, and managed the abort + hard-timeout
// envelope on its own; the same code appeared four times with subtle drift.
//
// This file owns:
//
//   1. `NormalizedAgentEvent`         — single union describing what the model
//                                       did (text/reasoning delta, tool call,
//                                       error). Callers switch on the kind and
//                                       map to their own surface (ChatStreamFrame
//                                       or WalkthroughStreamEvent).
//   2. `walkClaudeMessages`           — iterate the Claude SDK async generator,
//                                       emit normalized events. Treats both
//                                       `thinking` and `redacted_thinking`
//                                       blocks as reasoning deltas.
//   3. `subscribeOpencodeStream`      — subscribe to /event SSE, decode
//                                       `message.part.updated` frames into
//                                       normalized events. Owns per-partId
//                                       delta-dedup state and the load-bearing
//                                       100ms post-completion drain.
//   4. `walkOpencodeParts`            — synchronous walk over the parts array
//                                       returned by POST /session/:id/message.
//   5. `decodeOpencodePart`           — pure per-Part decoder shared by (3)
//                                       and (4). Returns the event + new
//                                       cumulative-emitted-length so the SSE
//                                       caller can park the state externally.
//   6. `buildActivity`                — normalizeToolName + classifyTool +
//                                       buildExplorationDescription rolled
//                                       into one helper.
//   7. `withAgentTurn`                — abort + hard-timeout + jobStarted/
//                                       jobEnded refcount harness for both
//                                       opencode providers. Surfaces wasTimeout
//                                       and wasCancelled flags so callers can
//                                       compose the right error message.

import type { ActivityKind, WalkthroughTokenUsage } from "@revv/shared";
import { classifyTool, normalizeToolName } from "@revv/shared";
import { debug, logError } from "../logger";
import type { OpencodeHttpClient } from "../services/OpencodeSupervisor";
import { buildExplorationDescription } from "./prompts/walkthrough";

// ── Normalized event ────────────────────────────────────────────────────────

/**
 * Discriminated union of everything a model can emit during a turn. Providers
 * decode their input shape into this union and callers switch on `kind` to
 * map into their own output frame (ChatStreamFrame or WalkthroughStreamEvent).
 *
 * `partId` on text/reasoning deltas is the upstream identifier (opencode's
 * Part `id`; absent for Claude SDK content blocks since those don't carry one).
 * Consumers don't usually need it — it's plumbed for future use (e.g. inline
 * thinking blocks that need to be grouped).
 *
 * `tool-call` carries `source` and `bareName` so callers stop re-parsing the
 * `mcp__<server>__<tool>` prefix shape in four different places. Built-in
 * tools (Read, Grep, Bash, …) get `source: 'builtin'`. MCP tools get
 * `source: 'mcp'`, with `mcpServer` set to the server name and `bareName`
 * set to the tool name with the prefix stripped. For opencode's bare MCP
 * tool names (no prefix), `source` stays `'builtin'` and `bareName === toolName` —
 * callers that need to match against MCP tool names (walkthrough phase
 * transitions) should compare `bareName` against the known set.
 */
export type NormalizedAgentEvent =
	| {
			readonly kind: "text-delta";
			readonly data: string;
			readonly partId?: string;
	  }
	| {
			readonly kind: "reasoning-delta";
			readonly data: string;
			readonly partId?: string;
	  }
	| {
			readonly kind: "tool-call";
			/** Canonical (Claude-style capitalized for built-ins; raw for MCP). */
			readonly toolName: string;
			readonly input: unknown;
			readonly callId?: string;
			readonly source: "builtin" | "mcp";
			/** Populated when `source === 'mcp'`. */
			readonly mcpServer?: string;
			/** `toolName` with the `mcp__<server>__` prefix stripped. */
			readonly bareName: string;
	  }
	| { readonly kind: "error"; readonly message: string };

/**
 * Helper used by both Claude and opencode adapters to derive `source` /
 * `mcpServer` / `bareName` from a raw tool name. Public so callers writing
 * their own tool-name dispatchers can stay consistent.
 */
export function classifyToolCallShape(rawToolName: string): {
	source: "builtin" | "mcp";
	mcpServer?: string;
	bareName: string;
} {
	if (rawToolName.startsWith("mcp__")) {
		const rest = rawToolName.slice("mcp__".length);
		const sep = rest.indexOf("__");
		if (sep > 0) {
			return {
				source: "mcp",
				mcpServer: rest.slice(0, sep),
				bareName: rest.slice(sep + 2),
			};
		}
	}
	return { source: "builtin", bareName: rawToolName };
}

// ── Activity builder ────────────────────────────────────────────────────────

export interface BuiltActivity {
	readonly activityKind: ActivityKind;
	readonly toolName: string;
	readonly summary: string;
	readonly payload?: unknown;
}

/**
 * Build a renderable Activity from a raw tool name + input. Composes
 * `normalizeToolName` (opencode lowercase → canonical), `classifyTool`
 * (canonical → ActivityKind), and `buildExplorationDescription` (canonical +
 * input → user-friendly summary).
 *
 * Used by every provider that surfaces tool calls in the UI. Centralising
 * this means a future change to how we describe Bash commands or MCP tools
 * only needs to land in one place.
 */
export function buildActivity(
	rawToolName: string,
	input: unknown,
): BuiltActivity {
	const toolName = normalizeToolName(rawToolName);
	return {
		activityKind: classifyTool(toolName),
		toolName,
		summary: buildExplorationDescription(toolName, input),
		...(input !== undefined ? { payload: input } : {}),
	};
}

// ── Claude SDK content-block walker ─────────────────────────────────────────

/**
 * Minimal shape of the Claude Agent SDK message stream that we care about.
 * The full SDK type is broader; this captures only the fields we read so
 * that the walker doesn't carry a dependency on the SDK's exact types.
 */
interface ClaudeMessage {
	type: string;
	message?: {
		content?: Array<{
			type: string;
			text?: string;
			thinking?: string;
			data?: string;
			name?: string;
			id?: string;
			input?: unknown;
		}>;
	};
	subtype?: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

/**
 * Walk an `AsyncIterable` of Claude SDK messages and emit normalized events.
 *
 * Block translation:
 *   - `text`              → `text-delta`
 *   - `thinking`          → `reasoning-delta` (data in `.thinking`)
 *   - `redacted_thinking` → `reasoning-delta` with a sentinel string in the
 *                            data field (the actual content is encrypted; we
 *                            still surface *something* so guard heartbeats fire
 *                            and downstream UIs can render a placeholder)
 *   - `tool_use`          → `tool-call`
 *
 * Returns the final `WalkthroughTokenUsage` parsed from the SDK's terminal
 * `result` message — `null` if the stream ended without one. Callers that
 * don't care (chat) can ignore the return value.
 *
 * `opts.onMessage` fires once per SDK message *before* the walker decodes its
 * content. The Claude SDK exposes its session id via the `query()` async
 * generator (not on the message itself), so the chat caller's session-id
 * polling stays where it is; this hook exists for any future caller that
 * needs raw SDK access without re-iterating the stream.
 */
export async function walkClaudeMessages(
	iter: AsyncIterable<unknown>,
	emit: (ev: NormalizedAgentEvent) => void,
	opts?: { onMessage?: (msg: unknown) => void | Promise<void> },
): Promise<WalkthroughTokenUsage | null> {
	let tokenUsage: WalkthroughTokenUsage | null = null;

	for await (const raw of iter) {
		if (opts?.onMessage) {
			await opts.onMessage(raw);
		}
		const message = raw as ClaudeMessage;
		if (message.type === "assistant" && message.message?.content) {
			for (const block of message.message.content) {
				if (block.type === "text" && typeof block.text === "string") {
					emit({ kind: "text-delta", data: block.text });
				} else if (
					block.type === "thinking" &&
					typeof block.thinking === "string"
				) {
					emit({ kind: "reasoning-delta", data: block.thinking });
				} else if (block.type === "redacted_thinking") {
					// `data` carries the encrypted blob; we don't surface it.
					// Emit a sentinel so the guard's first-event timer resets
					// and any UI that subscribes to reasoning frames can render
					// a placeholder instead of nothing.
					emit({
						kind: "reasoning-delta",
						data: "[redacted thinking]",
					});
				} else if (block.type === "tool_use" && typeof block.name === "string") {
					const shape = classifyToolCallShape(block.name);
					emit({
						kind: "tool-call",
						toolName: block.name,
						input: block.input,
						...(typeof block.id === "string" ? { callId: block.id } : {}),
						source: shape.source,
						...(shape.mcpServer !== undefined
							? { mcpServer: shape.mcpServer }
							: {}),
						bareName: shape.bareName,
					});
				}
			}
		} else if (message.type === "result" && message.usage) {
			tokenUsage = {
				inputTokens: message.usage.input_tokens,
				outputTokens: message.usage.output_tokens,
				cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
				cacheCreationInputTokens:
					message.usage.cache_creation_input_tokens ?? 0,
			};
		}
	}

	return tokenUsage;
}

// ── Opencode Part decoder ───────────────────────────────────────────────────

/**
 * Minimal shape of an opencode `Part`. The SDK's `Part` is a discriminated
 * union; we accept a permissive object and narrow inside the decoder.
 */
export interface OpencodePart {
	type: string;
	id?: string;
	text?: string;
	tool?: string;
	state?: { input?: unknown; status?: string; [k: string]: unknown };
	synthetic?: boolean;
	ignored?: boolean;
	callID?: string;
	[k: string]: unknown;
}

/**
 * Pure per-Part decoder. Returns an event (or null if the part should be
 * skipped) plus the new cumulative emitted-length for text/reasoning parts.
 *
 * The cumulative length is how SSE callers deduplicate repeated
 * `message.part.updated` events for the same part. Sync callers
 * (walkOpencodeParts) pass `alreadyEmittedLen: 0` and ignore the return.
 *
 * `deltaHint`: opencode's `message.part.updated` event carries an optional
 * `delta` field — when provided AND we've already emitted something for this
 * partId, we prefer the delta over slicing the full text. When the delta is
 * absent or the part is fresh, we fall back to `part.text.slice(already)`
 * so the user-visible stream stays monotonic.
 */
export function decodeOpencodePart(
	part: OpencodePart,
	deltaHint: string | undefined,
	alreadyEmittedLen: number,
): { event: NormalizedAgentEvent | null; newEmittedLen: number } {
	if (part.type === "text" && typeof part.text === "string") {
		if (part.synthetic === true || part.ignored === true) {
			return { event: null, newEmittedLen: alreadyEmittedLen };
		}
		const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
		if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
		return {
			event: {
				kind: "text-delta",
				data: chunk,
				...(part.id ? { partId: part.id } : {}),
			},
			newEmittedLen: part.text.length,
		};
	}

	if (part.type === "reasoning" && typeof part.text === "string") {
		const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
		if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
		return {
			event: {
				kind: "reasoning-delta",
				data: chunk,
				...(part.id ? { partId: part.id } : {}),
			},
			newEmittedLen: part.text.length,
		};
	}

	if (part.type === "tool" && typeof part.tool === "string") {
		const shape = classifyToolCallShape(part.tool);
		const input = part.state?.input;
		// Canonicalise the tool name for the caller. Opencode emits built-in
		// names lowercase (`read`, `grep`); `normalizeToolName` maps them to
		// Claude-canonical form so the four callers can treat the field
		// identically regardless of provider.
		const toolName = normalizeToolName(part.tool);
		return {
			event: {
				kind: "tool-call",
				toolName,
				input,
				...(part.callID ? { callId: part.callID } : {}),
				source: shape.source,
				...(shape.mcpServer !== undefined ? { mcpServer: shape.mcpServer } : {}),
				bareName: shape.bareName,
			},
			newEmittedLen: alreadyEmittedLen,
		};
	}

	// step-start / step-finish / file / snapshot / agent / etc. — ignored
	return { event: null, newEmittedLen: alreadyEmittedLen };
}

function pickChunk(
	fullText: string,
	deltaHint: string | undefined,
	already: number,
): string | null {
	if (deltaHint && already > 0) {
		return deltaHint.length > 0 ? deltaHint : null;
	}
	if (fullText.length > already) {
		return fullText.slice(already);
	}
	return null;
}

// ── Opencode synchronous parts walker ───────────────────────────────────────

/**
 * Iterate a fully-realised parts array (the return value of POST
 * /session/:id/message) and emit normalized events. No dedup state — each
 * part is seen exactly once.
 */
export function walkOpencodeParts(
	parts: ReadonlyArray<OpencodePart>,
	emit: (ev: NormalizedAgentEvent) => void,
): void {
	for (const part of parts) {
		const { event } = decodeOpencodePart(part, undefined, 0);
		if (event) emit(event);
	}
}

/**
 * Same as `walkOpencodeParts` but threads the SSE subscription's dedup state
 * (per-partId `emittedTextLen` Map + `seenToolPartIds` Set), so this walk
 * acts as a *backstop* after the SSE drain: anything the SSE already streamed
 * is a no-op here, anything SSE missed (because of subscription timing or a
 * dropped connection) gets emitted from the synchronous response body. This
 * is what unsticks chat-opencode in the "no output at all" failure mode where
 * the SSE never managed to receive the first event before `postMessage`
 * returned with the full transcript.
 */
export function walkOpencodePartsWithState(
	parts: ReadonlyArray<OpencodePart>,
	state: {
		emittedTextLen: Map<string, number>;
		seenToolPartIds: Set<string>;
	},
	emit: (ev: NormalizedAgentEvent) => void,
): void {
	for (const part of parts) {
		if (part.type === "tool") {
			const partId = part.id ?? "";
			if (!partId) continue;
			if (state.seenToolPartIds.has(partId)) continue;
			state.seenToolPartIds.add(partId);
		}
		const partId = part.id ?? "";
		const already = state.emittedTextLen.get(partId) ?? 0;
		const { event, newEmittedLen } = decodeOpencodePart(part, undefined, already);
		if (!event) continue;
		if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
			state.emittedTextLen.set(partId, newEmittedLen);
		}
		emit(event);
	}
}

// ── Opencode SSE subscription ───────────────────────────────────────────────

/**
 * Subscribe to /event SSE and emit normalized events as `message.part.updated`
 * frames arrive. Returns when the subscription is aborted via `signal` OR
 * when the daemon closes the stream.
 *
 * Owns:
 *   - The per-partId emitted-length Map used by `decodeOpencodePart` for
 *     text/reasoning dedup across repeated frames.
 *   - A `seenToolPartIds` set so a tool-call event fires exactly once per
 *     `pending → running → completed` lifecycle (the daemon resends the
 *     part on each state transition).
 *   - The load-bearing 100ms drain: SSE callers (chat-opencode) used to do
 *     `await new Promise(r => setTimeout(r, 100)); subscribeAbort.abort()`
 *     after their postMessage resolved, to let trailing
 *     `message.part.updated` events arrive before tearing down. That drain
 *     lives here now — callers just abort and await this promise; we sleep
 *     for `drainMs` (default 100ms) before actually unhooking from the
 *     daemon's event stream.
 */
export async function subscribeOpencodeStream(
	client: OpencodeHttpClient,
	sessionId: string,
	signal: AbortSignal,
	emit: (ev: NormalizedAgentEvent) => void,
	opts?: {
		drainMs?: number;
		/**
		 * Optional caller-owned dedup state. When provided, the SSE
		 * subscription and the post-hoc `walkOpencodePartsWithState` walk
		 * share the same `seenToolPartIds` / `emittedTextLen` maps so the
		 * backstop walk only emits parts SSE missed. Defaults to fresh
		 * local state when omitted.
		 */
		emittedTextLen?: Map<string, number>;
		seenToolPartIds?: Set<string>;
	},
): Promise<void> {
	const emittedTextLen = opts?.emittedTextLen ?? new Map<string, number>();
	const seenToolPartIds = opts?.seenToolPartIds ?? new Set<string>();
	const drainMs = opts?.drainMs ?? 100;

	// Compose an inner signal so we can run a final 100ms drain after the
	// caller's abort fires. The daemon-facing fetch keeps reading until
	// `innerAbort.abort()`; the caller's `signal` triggers the drain timer
	// instead of immediately tearing down.
	const innerAbort = new AbortController();
	const onCallerAbort = () => {
		setTimeout(() => innerAbort.abort(), drainMs);
	};
	if (signal.aborted) {
		onCallerAbort();
	} else {
		signal.addEventListener("abort", onCallerAbort, { once: true });
	}

	const handleEvent = (ev: unknown): void => {
		if (ev === null || typeof ev !== "object") return;
		const root = ev as Record<string, unknown>;
		const type = typeof root["type"] === "string" ? root["type"] : null;
		const properties =
			root["properties"] && typeof root["properties"] === "object"
				? (root["properties"] as Record<string, unknown>)
				: null;
		if (!type || !properties) return;

		if (type === "message.part.updated") {
			const part = properties["part"] as OpencodePart | undefined;
			const delta =
				typeof properties["delta"] === "string"
					? (properties["delta"] as string)
					: undefined;
			if (!part || typeof part.type !== "string") return;

			// Tool parts fire exactly once per partId regardless of dedup
			// state. Run that filter before invoking decodeOpencodePart so
			// the pure decoder stays state-free.
			if (part.type === "tool") {
				const partId = part.id ?? "";
				if (!partId) {
					debug(
						"agent-stream",
						"tool part missing id — skipping (would break dedup)",
						"tool:",
						part.tool,
					);
					return;
				}
				if (seenToolPartIds.has(partId)) return;
				seenToolPartIds.add(partId);
			}

			const partId = part.id ?? "";
			const already = emittedTextLen.get(partId) ?? 0;
			const { event, newEmittedLen } = decodeOpencodePart(
				part,
				delta,
				already,
			);
			if (event) {
				if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
					emittedTextLen.set(partId, newEmittedLen);
				} else if (event.kind === "tool-call") {
					debug(
						"agent-stream",
						"emit tool-call:",
						event.toolName,
						"source:",
						event.source,
						"bareName:",
						event.bareName,
					);
				}
				emit(event);
			} else if (part.type === "tool") {
				// Logged so REV_DEBUG=1 can spot tool parts we silently
				// dropped — usually means the part shape didn't match
				// (e.g. `tool` field missing, or `type` isn't "tool").
				debug(
					"agent-stream",
					"tool part decoded to null event",
					"type:",
					part.type,
					"tool:",
					part.tool,
					"keys:",
					Object.keys(part).join(","),
				);
			}
		} else if (type === "session.error") {
			const errObj =
				properties["error"] && typeof properties["error"] === "object"
					? (properties["error"] as Record<string, unknown>)
					: null;
			const data =
				errObj?.["data"] && typeof errObj["data"] === "object"
					? (errObj["data"] as Record<string, unknown>)
					: null;
			const msg =
				(typeof data?.["message"] === "string" ? data["message"] : null) ??
				(typeof errObj?.["name"] === "string" ? errObj["name"] : null) ??
				"Agent error";
			emit({ kind: "error", message: msg });
		}
	};

	try {
		await client.subscribeToEvents({
			sessionId,
			signal: innerAbort.signal,
			onEvent: handleEvent,
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") return;
		// Promote to logError so the failure is visible without REV_DEBUG=1.
		// A dropped SSE subscription mid-turn is the difference between "agent
		// is silent" and "agent is dead" from the user's perspective.
		logError(
			"agent-stream",
			"subscribeOpencodeStream error:",
			err instanceof Error ? err.message : String(err),
		);
	} finally {
		if (!signal.aborted) signal.removeEventListener("abort", onCallerAbort);
	}
}

// ── Abort + hard-timeout harness ────────────────────────────────────────────

export interface AgentTurnContext {
	/**
	 * Composed signal: aborts on external cancel OR hard timeout. Pass this
	 * to anything that should die when the turn dies (HTTP fetches, the
	 * Claude SDK's `query()`, etc.).
	 */
	readonly signal: AbortSignal;
	/** True after the hard-timeout fired. */
	readonly wasTimeout: () => boolean;
	/** True after the external `abortController` fired. */
	readonly wasCancelled: () => boolean;
}

export interface WithAgentTurnOptions<T> {
	readonly externalAbort?: AbortController | undefined;
	readonly hardTimeoutMs: number;
	readonly jobStarted: () => Promise<void>;
	readonly jobEnded: () => Promise<void>;
	/**
	 * Called once when the external abort OR the hard timeout fires. Both
	 * opencode providers use this to call `client.abortSession(sessionId)`
	 * so the daemon stops the model. May be a no-op for callers without a
	 * remote session to cancel.
	 */
	readonly abortSession?: () => Promise<void>;
	/**
	 * Synchronously fired when the external abort signal trips. Used by the
	 * walkthrough opencode driver to flip a `cancelled` flag the activity
	 * notifier (registered before `withAgentTurn`) reads to suppress late
	 * events. Distinct from `abortSession` (async; cancels the remote
	 * session) and from `ctx.wasCancelled()` (read-only; only callable
	 * inside `run`).
	 */
	readonly onCancel?: () => void;
	/** Synchronously fired when the hard-timeout trips. */
	readonly onTimeout?: () => void;
	readonly run: (ctx: AgentTurnContext) => Promise<T>;
	/** For debug logs ("chat-opencode", "walkthrough-opencode-mcp", …). */
	readonly debugLabel: string;
}

/**
 * Wrap a turn's run-body with the abort + hard-timeout + refcount envelope.
 *
 *   1. `jobStarted()` is awaited before `run` is called (bumps the daemon's
 *      active-job refcount, etc.).
 *   2. A hard-timeout fires after `hardTimeoutMs`; flips `wasTimeout()` to
 *      true, triggers `abortSession()`, and propagates an AbortError through
 *      the composed signal.
 *   3. An external `abortController.signal.abort()` flips `wasCancelled()`
 *      to true, triggers `abortSession()`, and propagates through the
 *      composed signal.
 *   4. `jobEnded()` is awaited in the `finally`, regardless of outcome.
 *
 * Errors thrown by `run` propagate to the caller. Callers compose their own
 * error chip from `wasTimeout()` / `wasCancelled()` after catching.
 */
export async function withAgentTurn<T>(opts: WithAgentTurnOptions<T>): Promise<T> {
	const composed = new AbortController();
	let timedOut = false;
	let cancelled = false;
	let abortSessionFired = false;

	const fireAbortSession = (): void => {
		if (abortSessionFired) return;
		abortSessionFired = true;
		if (!opts.abortSession) return;
		void opts.abortSession().catch((err) => {
			debug(
				opts.debugLabel,
				"abortSession failed:",
				err instanceof Error ? err.message : String(err),
			);
		});
	};

	const timeoutId = setTimeout(() => {
		timedOut = true;
		debug(opts.debugLabel, "hard timeout — aborting session");
		opts.onTimeout?.();
		fireAbortSession();
		try {
			composed.abort(
				new Error(
					`Agent turn timed out after ${Math.round(opts.hardTimeoutMs / 60_000)} minutes`,
				),
			);
		} catch {
			/* already aborted */
		}
	}, opts.hardTimeoutMs);

	const externalAbort = opts.externalAbort;
	const onExternalAbort = (): void => {
		cancelled = true;
		opts.onCancel?.();
		fireAbortSession();
		try {
			composed.abort(externalAbort?.signal.reason);
		} catch {
			/* already aborted */
		}
	};

	if (externalAbort) {
		if (externalAbort.signal.aborted) {
			onExternalAbort();
		} else {
			externalAbort.signal.addEventListener("abort", onExternalAbort, {
				once: true,
			});
		}
	}

	await opts.jobStarted();

	try {
		return await opts.run({
			signal: composed.signal,
			wasTimeout: () => timedOut,
			wasCancelled: () => cancelled,
		});
	} finally {
		clearTimeout(timeoutId);
		if (externalAbort) {
			externalAbort.signal.removeEventListener("abort", onExternalAbort);
		}
		try {
			await opts.jobEnded();
		} catch {
			/* swallow — refcount drift logged elsewhere */
		}
	}
}
