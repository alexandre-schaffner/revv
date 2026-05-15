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
//   3. `subscribeOpencodeStream`      — subscribe to /global/event SSE via
//                                       the SDK, decode `message.part.updated`
//                                       frames into normalized events. Owns
//                                       per-partId delta-dedup state and the
//                                       load-bearing 100ms post-completion
//                                       drain.
//   4. `walkOpencodeParts`            — synchronous walk over the parts array
//                                       returned by `session.prompt`.
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
import type { Event, Part } from "@opencode-ai/sdk";
import { debug, logError } from "../logger";
import type { OpencodeClient } from "../services/OpencodeSupervisor";
import { buildExplorationDescription } from "./prompts/walkthrough";

// Re-export the SDK's Part type for any other file in this package that wants
// to talk about opencode parts without depending on the SDK directly.
export type { Part };

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
/**
 * Snapshot entry inside a `task-list-update`. Mirrors the shared `ChatTask`
 * shape without the persistence id (the server assigns one downstream).
 */
export interface NormalizedTask {
	readonly id: string;
	readonly content: string;
	readonly activeForm: string | null;
	readonly status: "pending" | "in_progress" | "completed";
	readonly priority: "low" | "medium" | "high" | null;
}

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
			/**
			 * When the tool was emitted from inside a sub-agent (Claude
			 * `parent_tool_use_id` matches a known Task invocation id, or
			 * opencode part's `messageID` matches a sub-agent message), this
			 * is the sub-agent's `providerCallId`. Callers can stamp it onto
			 * the activity row so the UI groups it under the parent
			 * SubagentInvocation card.
			 */
			readonly subagentProviderCallId?: string;
	  }
	/**
	 * Full task-list snapshot. Both providers re-emit the entire list on each
	 * update — the consumer reconciles against persisted rows.
	 */
	| {
			readonly kind: "task-list-update";
			readonly tasks: ReadonlyArray<NormalizedTask>;
			readonly source: "claude" | "opencode";
	  }
	/**
	 * Agent has presented a plan (Claude ExitPlanMode tool, or the opencode
	 * `plan` agent finishing its turn). `providerPlanId` is the source's id
	 * for the plan emission (Claude tool_use.id; opencode synthesizes a UUID
	 * per turn). The chat route persists the plan and forwards a wire-level
	 * `plan-presented` frame with the assigned `planId`.
	 */
	| {
			readonly kind: "plan-presented";
			readonly markdown: string;
			readonly providerPlanId: string;
			readonly source: "claude" | "opencode";
	  }
	/**
	 * A sub-agent invocation has started. The driver maintains a closure-side
	 * map keyed by `providerCallId` so the matching `subagent-end` can be
	 * correlated.
	 */
	| {
			readonly kind: "subagent-start";
			readonly providerCallId: string;
			readonly subagentType: string;
			readonly description: string;
			readonly prompt: string;
			readonly source: "claude" | "opencode";
	  }
	/**
	 * A sub-agent invocation has finished. `ok = false` means the sub-agent
	 * errored out (tool_result `is_error=true` for Claude; agent part state
	 * marking error for opencode). `result` is the final summary text.
	 */
	| {
			readonly kind: "subagent-end";
			readonly providerCallId: string;
			readonly result: string;
			readonly ok: boolean;
			readonly source: "claude" | "opencode";
	  }
	/**
	 * Agent has asked the user one or more questions and is paused waiting
	 * for answers. Sources:
	 *   - Claude: `tool_use { name: "askUserQuestion" }` intercepted by
	 *     `canUseTool`. `providerRequestId = tool_use.id`. The driver holds
	 *     a Promise resolved when the answer endpoint fires.
	 *   - Opencode: `question.asked` event from `/global/event`.
	 *     `providerRequestId = QuestionRequest.id`. The opencode daemon
	 *     stays paused until `/question/{id}/reply` is hit out-of-band.
	 *
	 * The route's persistence wrapper assigns a server-side `questionId`,
	 * writes the row, and forwards a `user-question` wire frame.
	 */
	| {
			readonly kind: "user-question-asked";
			readonly providerRequestId: string;
			readonly source: "claude" | "opencode";
			readonly questions: ReadonlyArray<import("@revv/shared").NormalizedQuestion>;
			readonly previewFormat: "markdown" | "html";
			/** Opencode `QuestionRequest.tool.callID`; absent for Claude. */
			readonly providerToolCallId?: string;
	  }
	/**
	 * Opencode-only follow-up: the daemon broadcasts `question.replied` /
	 * `question.rejected` after our HTTP POST resolves the question. We emit
	 * this so the persistence wrapper can flip the row's status idempotently
	 * (the answer endpoint already wrote the DB row on the user-facing path).
	 *
	 * Claude doesn't emit this — its resolution lives entirely inside the
	 * answer endpoint (resolve the in-memory deferred and update DB inline).
	 */
	| {
			readonly kind: "user-question-resolved";
			readonly providerRequestId: string;
			readonly source: "opencode";
			readonly status: "answered" | "rejected";
			readonly answers?: Readonly<Record<string, ReadonlyArray<string>>>;
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

// ── Fluid stream chunker ────────────────────────────────────────────────────

/**
 * Target chars per emitted text/reasoning chunk before the fluid splitter
 * kicks in. Tuned to feel like a natural typewriter cadence: small enough
 * that a paragraph-sized delta doesn't dump in one go, large enough that
 * we're not flooding the chat UI with single-character updates.
 */
const FLUID_DEFAULT_CHUNK_LEN = 12;

/**
 * Wrap an `emit` function so `text-delta` and `reasoning-delta` events
 * longer than `targetChunkLen` are split into smaller word-boundary-aligned
 * chunks. All other event kinds pass through untouched, and deltas already
 * shorter than the target emit as-is (no overhead).
 *
 * Why this exists: provider drivers don't all stream at the same
 * granularity. The Claude SDK without `includePartialMessages: true` hands
 * back each content block as a single chunk — potentially several
 * paragraphs in one event. Opencode's daemon usually paces deltas per
 * model-token, but bursty event flushes can still pile up. Both paths
 * route through `fluidEmit` so the chat bubble sees a uniform, typewriter-
 * like cadence regardless of upstream behaviour.
 *
 * Splits prefer the next whitespace/punctuation within a 2x lookahead so
 * words aren't sliced mid-letter. Long unbroken runs (URLs, identifier
 * chains) hard-cut at `2 * targetChunkLen` rather than emit one long
 * chunk. When the wrapped `emit` carries state (e.g. the chat drivers'
 * `hasEmittedText` / `lastWasNonText` separator tracking), that state is
 * updated by the first sub-chunk only — subsequent sub-chunks see the
 * post-first state and skip the separator, which is exactly what we want.
 */
export function fluidEmit(
	emit: (ev: NormalizedAgentEvent) => void,
	opts?: { targetChunkLen?: number },
): (ev: NormalizedAgentEvent) => void {
	const targetLen = Math.max(
		1,
		opts?.targetChunkLen ?? FLUID_DEFAULT_CHUNK_LEN,
	);
	return (ev: NormalizedAgentEvent): void => {
		if (ev.kind !== "text-delta" && ev.kind !== "reasoning-delta") {
			emit(ev);
			return;
		}
		if (ev.data.length <= targetLen) {
			emit(ev);
			return;
		}
		const partIdField =
			ev.partId !== undefined ? { partId: ev.partId } : {};
		for (const chunk of splitForFluidStream(ev.data, targetLen)) {
			if (ev.kind === "text-delta") {
				emit({ kind: "text-delta", data: chunk, ...partIdField });
			} else {
				emit({ kind: "reasoning-delta", data: chunk, ...partIdField });
			}
		}
	};
}

/**
 * Split `text` into chunks targeting `targetLen` chars, snapping to the
 * next whitespace/punctuation boundary within a 2x lookahead window when
 * one exists. Falls back to a hard cut at `2 * targetLen` for long
 * unbroken runs (URLs, identifier chains) so a worst-case input still
 * emits as multiple chunks. The trailing remainder is always emitted as-is.
 */
function splitForFluidStream(text: string, targetLen: number): string[] {
	const out: string[] = [];
	const boundary = /[\s.,;:!?\-—)\]}>"']/;
	let i = 0;
	while (i < text.length) {
		const remaining = text.length - i;
		if (remaining <= targetLen) {
			out.push(text.slice(i));
			return out;
		}
		let end = i + targetLen;
		const stop = Math.min(i + targetLen * 2, text.length);
		let foundBoundary = false;
		for (let j = end; j < stop; j += 1) {
			if (boundary.test(text[j]!)) {
				// Include the boundary char so the next chunk starts on a
				// fresh word — `"hello, "` then `"world"` reads cleanly.
				end = j + 1;
				foundBoundary = true;
				break;
			}
		}
		if (!foundBoundary) end = stop;
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

// ── Claude SDK content-block walker ─────────────────────────────────────────

/**
 * Minimal shape of the Claude Agent SDK message stream that we care about.
 * The full SDK type is broader; this captures only the fields we read so
 * that the walker doesn't carry a dependency on the SDK's exact types.
 */
interface ClaudeMessage {
	type: string;
	// Present on both `assistant` and `user` messages — sub-agent activity
	// inside the parent stream carries this so callers can attribute it back
	// to the Task tool_use that spawned it.
	parent_tool_use_id?: string | null;
	message?: {
		content?: Array<{
			type: string;
			text?: string;
			thinking?: string;
			data?: string;
			name?: string;
			id?: string;
			input?: unknown;
			// On `tool_result` blocks (sent in `user` messages):
			tool_use_id?: string;
			is_error?: boolean;
			// `content` on tool_result can be either a string or a list of
			// content blocks. We accept both shapes; the walker normalizes.
			content?:
				| string
				| Array<{ type: string; text?: string }>;
		}>;
		// Cumulative token usage for THIS turn (one model inference call).
		// Populated on `assistant` SDK messages by the Claude Agent SDK; the
		// walker sums these across turns to produce the running session total.
		// Field names mirror the Anthropic API shape.
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
	// `stream_event` shape (SDKPartialAssistantMessage). Populated only when
	// the caller opted into partial messages via `includePartialMessages:
	// true`. Each event is a raw Claude API stream event so the walker can
	// emit per-token text/thinking deltas instead of waiting for the full
	// `assistant` message at the end of each turn.
	event?: {
		type: string;
		index?: number;
		delta?: {
			type: string;
			text?: string;
			thinking?: string;
		};
		// `message_start` events nest the initial response info under
		// `message.usage` (full usage shape including cache reads/writes).
		// `message_delta` events carry running counts directly on `event.usage`
		// (typically only `output_tokens`).
		message?: {
			usage?: {
				input_tokens?: number;
				output_tokens?: number;
				cache_read_input_tokens?: number;
				cache_creation_input_tokens?: number;
			};
		};
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
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
 * When the caller opts into `includePartialMessages: true` on the SDK, the
 * walker also handles `stream_event` messages: `content_block_delta` events
 * are emitted as fine-grained `text-delta` / `reasoning-delta` chunks (the
 * model's natural per-token cadence), and the corresponding text/thinking
 * blocks in the trailing `assistant` message are skipped so the same content
 * isn't emitted twice. When partial messages are NOT enabled, no
 * `stream_event` messages arrive and the dedup tracking stays empty — the
 * full block fires from the `assistant` message exactly as before.
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

	// Tracks active Task (sub-agent) invocations by tool_use.id so we can:
	//   (a) emit `subagent-end` when the matching tool_result arrives, and
	//   (b) stamp nested tool calls with `subagentProviderCallId` even on
	//       SDK builds where `parent_tool_use_id` is missing from the
	//       nested message (stack-based fallback).
	const activeSubagentCallIds = new Set<string>();

	// Content-block indices in the CURRENT in-progress assistant message
	// that we've already emitted as deltas via `stream_event` messages.
	// Cleared on `message_start` (new turn) and again after we process the
	// trailing `assistant` message. When `includePartialMessages: false`,
	// this stays empty and assistant-block emission proceeds as before.
	const streamedContentBlockIndices = new Set<number>();

	for await (const raw of iter) {
		if (opts?.onMessage) {
			await opts.onMessage(raw);
		}
		const message = raw as ClaudeMessage;

		if (message.type === "stream_event") {
			const event = message.event;
			if (!event || typeof event.type !== "string") continue;
			if (event.type === "message_start") {
				// New assistant message starting — reset the dedup tracker.
				streamedContentBlockIndices.clear();
				continue;
			}
			if (
				event.type === "content_block_delta" &&
				typeof event.index === "number" &&
				event.delta
			) {
				const delta = event.delta;
				if (delta.type === "text_delta" && typeof delta.text === "string") {
					if (delta.text.length > 0) {
						emit({ kind: "text-delta", data: delta.text });
					}
					streamedContentBlockIndices.add(event.index);
				} else if (
					delta.type === "thinking_delta" &&
					typeof delta.thinking === "string"
				) {
					if (delta.thinking.length > 0) {
						emit({ kind: "reasoning-delta", data: delta.thinking });
					}
					streamedContentBlockIndices.add(event.index);
				}
				// `input_json_delta` / `citations_delta` / `signature_delta`
				// are intentionally ignored — tool inputs are surfaced from
				// the final `assistant` message once the JSON parses cleanly.
			}
			continue;
		}

		if (message.type === "assistant" && message.message?.content) {
			// Sub-agent attribution: if this assistant message carries a
			// parent_tool_use_id we know the agent emitting it is a Task
			// sub-agent. Stamp every tool-call inside.
			const parentId =
				typeof message.parent_tool_use_id === "string" &&
				activeSubagentCallIds.has(message.parent_tool_use_id)
					? message.parent_tool_use_id
					: null;
			// Fallback: if SDK build doesn't surface parent_tool_use_id on
			// nested messages, attribute to *any* known-active Task. Safe
			// because Claude only runs one Task at a time per turn.
			const fallbackParentId =
				parentId === null && activeSubagentCallIds.size > 0
					? // Pick the first (only) active one
						activeSubagentCallIds.values().next().value ?? null
					: null;
			const attribution = parentId ?? fallbackParentId;

			for (let blockIdx = 0; blockIdx < message.message.content.length; blockIdx += 1) {
				const block = message.message.content[blockIdx]!;
				// Skip text/thinking blocks already streamed via `stream_event`
				// deltas — re-emitting would duplicate every chunk in the
				// assistant bubble. Tool blocks always go through (we only
				// have their complete `input` once the assistant message
				// arrives).
				if (
					streamedContentBlockIndices.has(blockIdx) &&
					(block.type === "text" ||
						block.type === "thinking" ||
						block.type === "redacted_thinking")
				) {
					continue;
				}
				if (block.type === "text" && typeof block.text === "string") {
					emit({ kind: "text-delta", data: block.text });
				} else if (
					block.type === "thinking" &&
					typeof block.thinking === "string"
				) {
					emit({ kind: "reasoning-delta", data: block.thinking });
				} else if (block.type === "redacted_thinking") {
					emit({
						kind: "reasoning-delta",
						data: "[redacted thinking]",
					});
				} else if (block.type === "tool_use" && typeof block.name === "string") {
					// Surface-specific tool routing for TodoWrite / ExitPlanMode
					// / Task. These don't flow through the generic tool-call
					// event — they have their own normalized shapes.
					if (block.name === "TodoWrite") {
						const tasks = parseClaudeTodoWriteInput(block.input);
						emit({
							kind: "task-list-update",
							tasks,
							source: "claude",
						});
						continue;
					}
					if (block.name === "ExitPlanMode") {
						const plan = extractClaudePlanMarkdown(block.input);
						if (plan !== null && typeof block.id === "string") {
							emit({
								kind: "plan-presented",
								markdown: plan,
								providerPlanId: block.id,
								source: "claude",
							});
						}
						continue;
					}
					if (block.name === "Task" && typeof block.id === "string") {
						const info = parseClaudeTaskInput(block.input);
						activeSubagentCallIds.add(block.id);
						emit({
							kind: "subagent-start",
							providerCallId: block.id,
							subagentType: info.subagentType,
							description: info.description,
							prompt: info.prompt,
							source: "claude",
						});
						continue;
					}

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
						...(attribution !== null
							? { subagentProviderCallId: attribution }
							: {}),
					});
				}
			}
			// Done with this assistant message — clear the per-message
			// streamed-index tracker so a follow-up assistant message in
			// the same turn (multi-step tool use) starts fresh.
			streamedContentBlockIndices.clear();
		} else if (message.type === "user" && message.message?.content) {
			// `user` messages carry tool_result blocks. When one matches an
			// active Task, emit `subagent-end` and drop the mapping.
			for (const block of message.message.content) {
				if (
					block.type === "tool_result" &&
					typeof block.tool_use_id === "string" &&
					activeSubagentCallIds.has(block.tool_use_id)
				) {
					const resultText = extractClaudeToolResultText(block.content);
					emit({
						kind: "subagent-end",
						providerCallId: block.tool_use_id,
						result: resultText,
						ok: block.is_error !== true,
						source: "claude",
					});
					activeSubagentCallIds.delete(block.tool_use_id);
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

// ── Claude tool-input decoders ─────────────────────────────────────────────

interface ClaudeTodoInput {
	content?: string;
	activeForm?: string;
	status?: string;
	priority?: string;
}

/**
 * Parse Claude's `TodoWrite` tool input into a normalized snapshot. The SDK
 * doesn't supply per-todo ids, so we content-hash `(content + activeForm)`
 * for stability across snapshots — identical entries collapse, which is
 * acceptable for a display list.
 */
function parseClaudeTodoWriteInput(input: unknown): NormalizedTask[] {
	if (input === null || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const todos = obj["todos"];
	if (!Array.isArray(todos)) return [];

	const out: NormalizedTask[] = [];
	for (const raw of todos) {
		if (raw === null || typeof raw !== "object") continue;
		const t = raw as ClaudeTodoInput;
		const content = typeof t.content === "string" ? t.content : "";
		if (content.length === 0) continue;
		const activeForm =
			typeof t.activeForm === "string" && t.activeForm.length > 0
				? t.activeForm
				: null;
		const status = normalizeTaskStatus(t.status);
		const priority = normalizeTaskPriority(t.priority);
		out.push({
			id: claudeTodoHash(content, activeForm),
			content,
			activeForm,
			status,
			priority,
		});
	}
	return out;
}

function normalizeTaskStatus(
	v: unknown,
): "pending" | "in_progress" | "completed" {
	if (v === "in_progress") return "in_progress";
	if (v === "completed") return "completed";
	// Opencode emits 'cancelled' too — we collapse to 'completed' for UI
	// simplicity (a cancelled task is closed). Anything else → pending.
	if (v === "cancelled") return "completed";
	return "pending";
}

function normalizeTaskPriority(
	v: unknown,
): "low" | "medium" | "high" | null {
	if (v === "low" || v === "medium" || v === "high") return v;
	return null;
}

/**
 * Deterministic id for Claude todos (no SDK-provided id). Cheap FNV-1a hash
 * — collisions only matter if two semantically distinct todos render
 * identical content + activeForm, which would already render as a single
 * row to the user anyway.
 */
function claudeTodoHash(content: string, activeForm: string | null): string {
	const input = `${content}\x00${activeForm ?? ""}`;
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	// Render as hex; pad to 8 chars for stable length.
	return `claude-todo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Normalize a Claude `askUserQuestion` tool input to our cross-provider
 * `NormalizedQuestion[]`. Defensive against malformed inputs — the SDK
 * enforces the schema, but a corrupt tool_use block shouldn't crash the
 * driver. Returns an empty array if parsing fails.
 *
 * Schema (per `AskUserQuestionInput`):
 *   { questions: Array<{
 *       question: string;
 *       header: string;
 *       multiSelect: boolean;
 *       options: Array<{ label: string; description: string; preview?: string }>;
 *     }>
 *   }
 *
 * Claude's `askUserQuestion` has no equivalent of opencode's `custom` flag,
 * so `allowCustom` is always false.
 */
export function normalizeClaudeAskUserQuestionInput(
	input: unknown,
): ReadonlyArray<import("@revv/shared").NormalizedQuestion> {
	if (!input || typeof input !== "object") return [];
	const obj = input as Record<string, unknown>;
	const raw = obj["questions"];
	if (!Array.isArray(raw)) return [];
	const out: import("@revv/shared").NormalizedQuestion[] = [];
	for (const q of raw) {
		if (!q || typeof q !== "object") continue;
		const qo = q as Record<string, unknown>;
		const question = typeof qo["question"] === "string" ? qo["question"] : "";
		const header = typeof qo["header"] === "string" ? qo["header"] : "";
		const multiSelect = qo["multiSelect"] === true;
		const optionsRaw = qo["options"];
		const options: Array<{
			label: string;
			description: string;
			preview?: string;
		}> = [];
		if (Array.isArray(optionsRaw)) {
			for (const o of optionsRaw) {
				if (!o || typeof o !== "object") continue;
				const oo = o as Record<string, unknown>;
				const label = typeof oo["label"] === "string" ? oo["label"] : "";
				const description =
					typeof oo["description"] === "string" ? oo["description"] : "";
				const preview =
					typeof oo["preview"] === "string" ? oo["preview"] : undefined;
				if (label.length === 0) continue;
				options.push(
					preview !== undefined
						? { label, description, preview }
						: { label, description },
				);
			}
		}
		if (question.length === 0 || options.length === 0) continue;
		out.push({
			question,
			header,
			multiSelect,
			allowCustom: false,
			options,
		});
	}
	return out;
}

/**
 * `ExitPlanMode.input` per Claude SDK has a single `plan: string` field.
 * Defensive: accept other shapes too.
 */
function extractClaudePlanMarkdown(input: unknown): string | null {
	if (input === null || typeof input !== "object") return null;
	const plan = (input as Record<string, unknown>)["plan"];
	if (typeof plan === "string" && plan.trim().length > 0) return plan;
	return null;
}

/**
 * `Task.input` per Claude SDK:
 *   { subagent_type: string, description: string, prompt: string }
 * Some SDK builds use `subagentType` (camelCase). Accept both.
 */
function parseClaudeTaskInput(input: unknown): {
	subagentType: string;
	description: string;
	prompt: string;
} {
	const fallback = {
		subagentType: "general-purpose",
		description: "Sub-agent task",
		prompt: "",
	};
	if (input === null || typeof input !== "object") return fallback;
	const obj = input as Record<string, unknown>;
	const subagentType =
		(typeof obj["subagent_type"] === "string" && obj["subagent_type"]) ||
		(typeof obj["subagentType"] === "string" && obj["subagentType"]) ||
		fallback.subagentType;
	const description =
		(typeof obj["description"] === "string" && obj["description"]) ||
		fallback.description;
	const prompt =
		(typeof obj["prompt"] === "string" && obj["prompt"]) || fallback.prompt;
	return { subagentType, description, prompt };
}

/**
 * Tool result content can be a plain string OR a list of content blocks.
 * Concatenate text blocks into a single string for the sub-agent's result.
 */
function extractClaudeToolResultText(
	content: string | Array<{ type: string; text?: string }> | undefined,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) =>
			b && b.type === "text" && typeof b.text === "string" ? b.text : "",
		)
		.join("");
}

// ── Opencode Part decoder ───────────────────────────────────────────────────
//
// The SDK's `Part` is a discriminated union on `type`:
//   TextPart | (subtask variant) | ReasoningPart | FilePart | ToolPart |
//   StepStartPart | StepFinishPart | SnapshotPart | PatchPart | AgentPart |
//   RetryPart | CompactionPart
//
// We narrow on `part.type` and read each variant's typed fields directly. No
// permissive `[k: string]: unknown` escape hatch — if a new opencode version
// adds a part variant the SDK doesn't yet model, typecheck flags the missing
// case at compile time. That is the load-bearing reason for taking the SDK
// types as the source of truth: silent drift was the main maintenance cost
// of the prior hand-rolled `Part` interface.

/**
 * Split a `provider/modelID` string into the wire shape opencode expects
 * (`{ providerID, modelID }`). Returns undefined when the input doesn't
 * parse — callers omit the `model` field in that case and the daemon
 * picks its configured default.
 */
export function parseOpencodeModel(
	model: string | undefined,
): { providerID: string; modelID: string } | undefined {
	if (model === undefined) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return {
		providerID: model.slice(0, slash),
		modelID: model.slice(slash + 1),
	};
}

/**
 * Extract a human-readable message from opencode's `AssistantMessage.error`
 * union. The daemon returns 200 even when the agent loop fails (model not
 * found, provider auth missing), embedding the failure under
 * `info.error`. Both opencode providers wrap the extracted message in
 * `opencode agent error: …`.
 */
export function extractOpencodeErrorMessage(errObj: {
	readonly name: string;
	readonly data?: unknown;
}): string {
	if (
		errObj.data !== null &&
		typeof errObj.data === "object" &&
		"message" in errObj.data &&
		typeof (errObj.data as { message: unknown }).message === "string"
	) {
		return (errObj.data as { message: string }).message;
	}
	return errObj.name;
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
	part: Part,
	deltaHint: string | undefined,
	alreadyEmittedLen: number,
): { event: NormalizedAgentEvent | null; newEmittedLen: number } {
	if (part.type === "text") {
		if (part.synthetic === true || part.ignored === true) {
			return { event: null, newEmittedLen: alreadyEmittedLen };
		}
		const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
		if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
		return {
			event: {
				kind: "text-delta",
				data: chunk,
				partId: part.id,
			},
			newEmittedLen: part.text.length,
		};
	}

	if (part.type === "reasoning") {
		const chunk = pickChunk(part.text, deltaHint, alreadyEmittedLen);
		if (chunk === null) return { event: null, newEmittedLen: alreadyEmittedLen };
		return {
			event: {
				kind: "reasoning-delta",
				data: chunk,
				partId: part.id,
			},
			newEmittedLen: part.text.length,
		};
	}

	if (part.type === "tool") {
		const shape = classifyToolCallShape(part.tool);
		// ToolState is a union (pending/running/completed/error); every
		// variant carries `input`, so the read is safe without narrowing.
		const input = part.state.input;
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
				callId: part.callID,
				source: shape.source,
				...(shape.mcpServer !== undefined ? { mcpServer: shape.mcpServer } : {}),
				bareName: shape.bareName,
			},
			newEmittedLen: alreadyEmittedLen,
		};
	}

	// step-start / step-finish / file / snapshot / patch / retry / compaction —
	// ignored. `agent` and `subtask` parts are decoded externally via
	// decodeOpencodeAgentPart because their dedup state is caller-owned.
	return { event: null, newEmittedLen: alreadyEmittedLen };
}

/**
 * Decode a `type: "agent"` or `type: "subtask"` part into a `subagent-start`
 * event. Caller owns the dedup set because opencode resends the part on each
 * `message.part.updated` resend; we want exactly one start per partId.
 *
 * The SDK's `AgentPart` only exposes `name`; the inline `subtask` variant of
 * `Part` carries `prompt`, `description`, `agent`. We treat both as start
 * events and never emit a corresponding `subagent-end` from these parts —
 * opencode doesn't expose a typed completion signal here (the sub-agent's
 * end is implicit when its child message stream stops producing parts).
 */
export function decodeOpencodeAgentPart(
	part: Part,
	state: {
		seenAgentStartPartIds: Set<string>;
	},
): NormalizedAgentEvent | null {
	if (part.type === "subtask") {
		if (state.seenAgentStartPartIds.has(part.id)) return null;
		state.seenAgentStartPartIds.add(part.id);
		return {
			kind: "subagent-start",
			providerCallId: part.id,
			subagentType: part.agent,
			description: part.description,
			prompt: part.prompt,
			source: "opencode",
		};
	}
	if (part.type === "agent") {
		if (state.seenAgentStartPartIds.has(part.id)) return null;
		state.seenAgentStartPartIds.add(part.id);
		return {
			kind: "subagent-start",
			providerCallId: part.id,
			subagentType: part.name,
			description: part.name,
			prompt: "",
			source: "opencode",
		};
	}
	return null;
}

/**
 * Decode a `todo.updated` SSE event body. Returns the snapshot — caller is
 * responsible for content-hashing to suppress no-op resends.
 *
 * The opencode SDK's `Todo` type only carries `{content, status, priority}` —
 * no stable id. We synthesize one by content-hashing (mirrors the Claude
 * `TodoWrite` path) so the UI gets a stable key across re-emissions of the
 * same snapshot. Two semantically distinct todos with identical content
 * collapse into one row, which matches the daemon's own inability to
 * distinguish them.
 */
export function decodeOpencodeTodoUpdate(
	properties: Record<string, unknown>,
): NormalizedTask[] {
	const todos = properties["todos"];
	if (!Array.isArray(todos)) return [];
	const out: NormalizedTask[] = [];
	for (const raw of todos) {
		if (raw === null || typeof raw !== "object") continue;
		const t = raw as Record<string, unknown>;
		const content = typeof t["content"] === "string" ? (t["content"] as string) : "";
		if (content.length === 0) continue;
		const providedId =
			typeof t["id"] === "string" && (t["id"] as string).length > 0
				? (t["id"] as string)
				: null;
		out.push({
			id: providedId ?? opencodeTodoHash(content),
			content,
			activeForm: null,
			status: normalizeTaskStatus(t["status"]),
			priority: normalizeTaskPriority(t["priority"]),
		});
	}
	return out;
}

/**
 * Deterministic id for opencode todos (the SDK doesn't expose one). Cheap
 * FNV-1a content hash — identical content collapses to one row, which is
 * what we want since the daemon can't tell them apart either.
 */
function opencodeTodoHash(content: string): string {
	let hash = 2166136261;
	for (let i = 0; i < content.length; i += 1) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `opencode-todo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
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
	parts: ReadonlyArray<Part>,
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
 * the SSE never managed to receive the first event before `session.prompt`
 * returned with the full transcript.
 */
export function walkOpencodePartsWithState(
	parts: ReadonlyArray<Part>,
	state: {
		emittedTextLen: Map<string, number>;
		seenToolPartIds: Set<string>;
		/**
		 * Message IDs we know belong to user messages. Parts carrying these
		 * IDs are skipped to prevent opencode's habit of including the user's
		 * input in the response body from echoing back as assistant text.
		 */
		userMessageIDs?: Set<string>;
		/**
		 * The current turn's assistant message ID (from `response.info.id`).
		 * When provided, parts whose `messageID` differs are skipped. This is
		 * the definitive filter — anything not authored by the assistant
		 * message we just asked for is by definition not assistant output.
		 */
		assistantMessageID?: string;
		seenAgentStartPartIds?: Set<string>;
		subagentMessageIdMap?: Map<string, string>;
	},
	emit: (ev: NormalizedAgentEvent) => void,
): void {
	const seenAgentStartPartIds =
		state.seenAgentStartPartIds ?? new Set<string>();
	const subagentMessageIdMap =
		state.subagentMessageIdMap ?? new Map<string, string>();
	for (const part of parts) {
		// SDK `Part` always carries `messageID` — no optional guard needed.
		// Allow assistant-authored parts AND child-message parts (sub-agent
		// authored) through the assistant-id filter.
		const childMatch = subagentMessageIdMap.has(part.messageID);
		if (
			(state.userMessageIDs && state.userMessageIDs.has(part.messageID)) ||
			(state.assistantMessageID !== undefined &&
				state.assistantMessageID !== "" &&
				part.messageID !== state.assistantMessageID &&
				!childMatch)
		) {
			continue;
		}
		if (part.type === "agent" || part.type === "subtask") {
			const ev = decodeOpencodeAgentPart(part, {
				seenAgentStartPartIds,
			});
			if (ev) emit(ev);
			continue;
		}
		if (part.type === "tool") {
			if (state.seenToolPartIds.has(part.id)) continue;
			state.seenToolPartIds.add(part.id);
		}
		const already = state.emittedTextLen.get(part.id) ?? 0;
		const { event, newEmittedLen } = decodeOpencodePart(part, undefined, already);
		if (!event) continue;
		if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
			state.emittedTextLen.set(part.id, newEmittedLen);
		}
		// Stamp sub-agent attribution for tool calls authored by a child msg.
		if (
			event.kind === "tool-call" &&
			subagentMessageIdMap.has(part.messageID)
		) {
			emit({
				...event,
				subagentProviderCallId: subagentMessageIdMap.get(part.messageID)!,
			});
			continue;
		}
		emit(event);
	}
}

// ── Opencode question events (runtime-only, v1 SDK doesn't type them) ──────

interface OpencodeQuestionInfo {
	question: string;
	header: string;
	options: ReadonlyArray<{ label: string; description: string }>;
	multiple?: boolean;
	custom?: boolean;
}

interface OpencodeQuestionRequestPayload {
	id: string;
	sessionID: string;
	questions: ReadonlyArray<OpencodeQuestionInfo>;
	tool?: { messageID: string; callID: string };
}

interface OpencodeQuestionRepliedPayload {
	sessionID: string;
	requestID: string;
	answers: ReadonlyArray<ReadonlyArray<string>>;
}

interface OpencodeQuestionRejectedPayload {
	sessionID: string;
	requestID: string;
}

function handleQuestionEvent(
	type: "question.asked" | "question.replied" | "question.rejected",
	properties: unknown,
	sessionId: string,
	lastQuestionsByRequestId: Map<
		string,
		ReadonlyArray<import("@revv/shared").NormalizedQuestion>
	>,
	emit: (ev: NormalizedAgentEvent) => void,
): void {
	if (!properties || typeof properties !== "object") return;
	if (type === "question.asked") {
		const req = properties as OpencodeQuestionRequestPayload;
		if (req.sessionID !== sessionId) return;
		const questions: import("@revv/shared").NormalizedQuestion[] = [];
		for (const q of req.questions ?? []) {
			const options = (q.options ?? []).map((o) => ({
				label: o.label,
				description: o.description,
			}));
			if (q.question.length === 0 || options.length === 0) continue;
			questions.push({
				question: q.question,
				header: q.header,
				// opencode `multiple` defaults to true per its schema —
				// preserve that default if the field is absent.
				multiSelect: q.multiple ?? true,
				// opencode `custom` defaults to true per its schema.
				allowCustom: q.custom ?? true,
				options,
			});
		}
		if (questions.length === 0) return;
		lastQuestionsByRequestId.set(req.id, questions);
		const event: NormalizedAgentEvent = {
			kind: "user-question-asked",
			providerRequestId: req.id,
			source: "opencode",
			questions,
			previewFormat: "markdown",
			...(req.tool?.callID
				? { providerToolCallId: req.tool.callID }
				: {}),
		};
		emit(event);
		return;
	}
	if (type === "question.replied") {
		const r = properties as OpencodeQuestionRepliedPayload;
		if (r.sessionID !== sessionId) return;
		// Reconstruct Record<questionText, labels[]> from the original
		// questions list. Opencode replies with an Array<Array<string>>
		// in the same order as the questions; merge by index.
		const original = lastQuestionsByRequestId.get(r.requestID);
		const answers: Record<string, ReadonlyArray<string>> = {};
		if (original) {
			for (let i = 0; i < original.length; i += 1) {
				const q = original[i]!;
				const labels = r.answers[i] ?? [];
				answers[q.question] = labels;
			}
			lastQuestionsByRequestId.delete(r.requestID);
		}
		emit({
			kind: "user-question-resolved",
			providerRequestId: r.requestID,
			source: "opencode",
			status: "answered",
			answers,
		});
		return;
	}
	// question.rejected
	const r = properties as OpencodeQuestionRejectedPayload;
	if (r.sessionID !== sessionId) return;
	lastQuestionsByRequestId.delete(r.requestID);
	emit({
		kind: "user-question-resolved",
		providerRequestId: r.requestID,
		source: "opencode",
		status: "rejected",
	});
}

// ── Opencode SSE subscription ───────────────────────────────────────────────

/**
 * Subscribe to `/global/event` SSE via the SDK and emit normalized events as
 * `message.part.updated` frames arrive. Returns when the subscription is
 * aborted via `signal` OR when the daemon closes the stream.
 *
 * We use `client.global.event()` (not `client.event.subscribe()`) because
 * historically opencode's `/event` endpoint emits a single `server.connected`
 * frame then terminates the chunked response body, while `/global/event` is
 * the long-lived stream that carries every `message.part.updated`,
 * `todo.updated`, `session.error`, etc. across all sessions. We filter to
 * the current session's events client-side.
 *
 * Owns:
 *   - The per-partId emitted-length Map used by `decodeOpencodePart` for
 *     text/reasoning dedup across repeated frames.
 *   - A `seenToolPartIds` set so a tool-call event fires exactly once per
 *     `pending → running → completed` lifecycle (the daemon resends the
 *     part on each state transition).
 *   - The load-bearing 100ms drain: SSE callers (chat-opencode) used to do
 *     `await new Promise(r => setTimeout(r, 100)); subscribeAbort.abort()`
 *     after their session.prompt resolved, to let trailing
 *     `message.part.updated` events arrive before tearing down. That drain
 *     lives here now — callers just abort and await this promise; we sleep
 *     for `drainMs` (default 100ms) before actually unhooking from the
 *     daemon's event stream.
 */
export async function subscribeOpencodeStream(
	client: OpencodeClient,
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
		/**
		 * Caller-owned set of message IDs known to belong to user messages.
		 * The SSE handler augments it whenever a `message.updated` event
		 * arrives with `role === "user"`, and skips any `message.part.updated`
		 * frame whose `part.messageID` is in the set. Share with the backstop
		 * walk so user parts the daemon includes in `response.parts` are
		 * filtered there too. Defaults to a fresh local set when omitted.
		 *
		 * Opencode posts the user message before kicking off inference, so
		 * the `message.updated` for the user message reliably lands before
		 * any assistant `message.part.updated` events arrive — no race.
		 */
		userMessageIDs?: Set<string>;
		/**
		 * Per-partId dedup for sub-agent start emission. Opencode resends
		 * `agent`/`subtask` parts on state transitions; we only emit one
		 * `subagent-start` per part. Shared with the backstop walk so the
		 * synchronous response body doesn't re-emit.
		 */
		seenAgentStartPartIds?: Set<string>;
		/**
		 * Last task-list snapshot hash, used to suppress no-op `todo.updated`
		 * resends. Caller-owned so the backstop walk can share if needed.
		 */
		lastTodoSnapshotHash?: { value: string | null };
		/**
		 * Caller-owned map: opencode `QuestionRequest.id` → the original
		 * questions list. Populated on `question.asked`, read on
		 * `question.replied` to reconstruct a `Record<questionText, labels[]>`
		 * shape from opencode's `Array<Array<string>>` reply order.
		 */
		lastQuestionsByRequestId?: Map<
			string,
			ReadonlyArray<import("@revv/shared").NormalizedQuestion>
		>;
		/**
		 * Map from a sub-agent's child messageID to the parent invocation's
		 * providerCallId. The SSE handler populates this when a `subtask` or
		 * `agent` part arrives; subsequent tool parts whose messageID hits
		 * the map get stamped with `subagentProviderCallId` so the UI nests
		 * them under the parent invocation card.
		 *
		 * Heuristic-only — opencode doesn't always expose the child-message
		 * id on the parent part. Unstamped tool parts render at top level.
		 */
		subagentMessageIdMap?: Map<string, string>;
		/**
		 * Fires whenever a `message.updated` event arrives for an assistant
		 * message in the current session, carrying that message's running
		 * `tokens` snapshot (input / output / reasoning / cache.{read,write}).
		 * Callers (walkthrough provider) translate this into a `usage` event
		 * so the BottomBar updates live mid-turn rather than only when the
		 * full agent turn resolves. No throttling here — callers should
		 * throttle if needed for downstream cost.
		 */
		onAssistantTokens?: (tokens: {
			input: number;
			output: number;
			reasoning: number;
			cache: { read: number; write: number };
		}) => void;
	},
): Promise<void> {
	const emittedTextLen = opts?.emittedTextLen ?? new Map<string, number>();
	const seenToolPartIds = opts?.seenToolPartIds ?? new Set<string>();
	const userMessageIDs = opts?.userMessageIDs ?? new Set<string>();
	const seenAgentStartPartIds =
		opts?.seenAgentStartPartIds ?? new Set<string>();
	const lastTodoSnapshotHash = opts?.lastTodoSnapshotHash ?? {
		value: null as string | null,
	};
	const subagentMessageIdMap =
		opts?.subagentMessageIdMap ?? new Map<string, string>();
	const lastQuestionsByRequestId =
		opts?.lastQuestionsByRequestId ??
		new Map<
			string,
			ReadonlyArray<import("@revv/shared").NormalizedQuestion>
		>();
	const drainMs = opts?.drainMs ?? 100;

	// Compose an inner signal so we can run a final 100ms drain after the
	// caller's abort fires. The SDK-driven SSE iterator keeps reading until
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

	const handleEvent = (ev: Event): void => {
		// Question events (question.asked / .replied / .rejected) live in the
		// opencode daemon at runtime but aren't yet present in the v1 SDK's
		// typed `Event` union (they exist in v2). We intercept them here via
		// a runtime type check so the rest of the typed switch stays sound.
		// When the SDK types catch up, this block can move into the switch.
		const dynamicEv = ev as { type: string; properties: unknown };
		if (
			dynamicEv.type === "question.asked" ||
			dynamicEv.type === "question.replied" ||
			dynamicEv.type === "question.rejected"
		) {
			handleQuestionEvent(
				dynamicEv.type,
				dynamicEv.properties,
				sessionId,
				lastQuestionsByRequestId,
				emit,
			);
			return;
		}
		switch (ev.type) {
			case "message.updated": {
				// Learn which message IDs belong to user messages so we can skip
				// their parts. Opencode creates the user message before kicking
				// off inference, so this fires before any assistant
				// `message.part.updated` events — race-free in practice.
				const info = ev.properties.info;
				if (info.role === "user") {
					userMessageIDs.add(info.id);
				} else if (info.role === "assistant" && info.sessionID === sessionId) {
					// Assistant messages carry a running `tokens` snapshot that
					// the daemon updates as output streams. Forward it to the
					// caller so they can broadcast a `usage` event for live
					// BottomBar updates mid-turn (without waiting for the full
					// session.prompt to resolve).
					opts?.onAssistantTokens?.(info.tokens);
				}
				return;
			}
			case "todo.updated": {
				if (ev.properties.sessionID !== sessionId) return;
				const tasks = decodeOpencodeTodoUpdate({
					todos: ev.properties.todos,
				});
				const hash = hashTaskSnapshot(tasks);
				if (hash !== lastTodoSnapshotHash.value) {
					lastTodoSnapshotHash.value = hash;
					emit({ kind: "task-list-update", tasks, source: "opencode" });
				}
				return;
			}
			case "message.part.updated": {
				const part = ev.properties.part;
				if (part.sessionID !== sessionId) return;

				// Skip parts belonging to user messages. Without this, opencode's
				// re-emission of the user's input as a `text` part gets decoded as
				// an assistant text-delta and echoed back into the chat bubble.
				if (userMessageIDs.has(part.messageID)) return;

				// Step-finish parts arrive between tool calls and carry the
				// running token total for the message so far. Surface them via
				// onAssistantTokens — gives the BottomBar a more reliable
				// mid-turn update cadence than `message.updated` alone, since
				// step boundaries map one-to-one with tool calls during
				// walkthrough generation. The dedicated decoder ignores this
				// part type for normalized events.
				if (part.type === "step-finish") {
					opts?.onAssistantTokens?.(part.tokens);
					return;
				}

				// Agent / subtask parts: route through the dedicated decoder
				// that owns the start dedup.
				if (part.type === "agent" || part.type === "subtask") {
					const subEv = decodeOpencodeAgentPart(part, {
						seenAgentStartPartIds,
					});
					if (subEv) emit(subEv);
					return;
				}

				// Tool parts fire exactly once per partId regardless of dedup
				// state. Run that filter before invoking decodeOpencodePart so
				// the pure decoder stays state-free.
				if (part.type === "tool") {
					if (seenToolPartIds.has(part.id)) return;
					seenToolPartIds.add(part.id);
				}

				const already = emittedTextLen.get(part.id) ?? 0;
				const { event, newEmittedLen } = decodeOpencodePart(
					part,
					ev.properties.delta,
					already,
				);
				if (event) {
					if (event.kind === "text-delta" || event.kind === "reasoning-delta") {
						emittedTextLen.set(part.id, newEmittedLen);
					} else if (event.kind === "tool-call") {
						const stamped = subagentMessageIdMap.has(part.messageID)
							? {
									...event,
									subagentProviderCallId:
										subagentMessageIdMap.get(part.messageID)!,
								}
							: event;
						debug(
							"agent-stream",
							"emit tool-call:",
							event.toolName,
							"source:",
							event.source,
							"bareName:",
							event.bareName,
						);
						emit(stamped);
						return;
					}
					emit(event);
				} else if (part.type === "tool") {
					// Logged so REV_DEBUG=1 can spot tool parts we silently
					// dropped — should be rare against the typed SDK Part
					// since the decoder narrows on `type` exhaustively.
					debug(
						"agent-stream",
						"tool part decoded to null event",
						"tool:",
						part.tool,
					);
				}
				return;
			}
			case "session.error": {
				if (
					ev.properties.sessionID !== undefined &&
					ev.properties.sessionID !== sessionId
				) {
					return;
				}
				const errObj = ev.properties.error;
				const msg =
					(errObj && "data" in errObj && typeof errObj.data === "object"
						? (errObj.data as { message?: unknown }).message
						: undefined) ??
					(errObj && "name" in errObj && typeof errObj.name === "string"
						? errObj.name
						: undefined) ??
					"Agent error";
				emit({ kind: "error", message: String(msg) });
				return;
			}
			default:
				// Other event types (file.edited, session.created, lsp.*,
				// permission.*, pty.*, tui.*, etc.) are not consumed by the
				// chat or walkthrough drivers.
				return;
		}
	};

	try {
		const result = await client.global.event({
			fetch: (req) => {
				// Per-call `timeout: false` belt-and-suspenders for the SSE
				// fetch — same trap as the global custom fetch, but spelled
				// out here too so the SSE-specific failure mode (Bun killing
				// the long-poll at 5 minutes, dropping post-300s tool calls)
				// stays documented at the call site.
				(req as unknown as { timeout?: boolean }).timeout = false;
				return fetch(req);
			},
			signal: innerAbort.signal,
		});
		for await (const globalEvent of result.stream) {
			if (innerAbort.signal.aborted) break;
			handleEvent(globalEvent.payload);
		}
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

// ── Sub-agent + task helpers ────────────────────────────────────────────────

/**
 * Stable hash of a task-list snapshot. The opencode daemon resends
 * `todo.updated` events even when the contents are unchanged; we content-hash
 * to skip those resends and only emit `task-list-update` on real diffs.
 */
function hashTaskSnapshot(tasks: ReadonlyArray<NormalizedTask>): string {
	const parts: string[] = [];
	for (const t of tasks) {
		parts.push(
			`${t.id}|${t.content}|${t.activeForm ?? ""}|${t.status}|${t.priority ?? ""}`,
		);
	}
	const joined = parts.join("\n");
	let hash = 2166136261;
	for (let i = 0; i < joined.length; i += 1) {
		hash ^= joined.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
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
	 * opencode providers use this to call `client.session.abort({ path: { id: sessionId } })`
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
