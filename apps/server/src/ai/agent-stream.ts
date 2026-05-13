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

	// Tracks active Task (sub-agent) invocations by tool_use.id so we can:
	//   (a) emit `subagent-end` when the matching tool_result arrives, and
	//   (b) stamp nested tool calls with `subagentProviderCallId` even on
	//       SDK builds where `parent_tool_use_id` is missing from the
	//       nested message (stack-based fallback).
	const activeSubagentCallIds = new Set<string>();

	for await (const raw of iter) {
		if (opts?.onMessage) {
			await opts.onMessage(raw);
		}
		const message = raw as ClaudeMessage;

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

			for (const block of message.message.content) {
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
	/**
	 * Upstream opencode `Part.messageID` — links this part to its containing
	 * `UserMessage` or `AssistantMessage`. Used by callers to filter out user
	 * parts that the daemon re-emits in its SSE stream and synchronous
	 * response body, which would otherwise echo the user's input back as
	 * assistant text.
	 */
	messageID?: string;
	// `AgentPart` specific (type: "agent") — names the sub-agent invoked.
	name?: string;
	// `SubtaskPart` specific (type: "subtask") — carries the sub-agent
	// prompt + description + agent name. opencode 1.14+.
	prompt?: string;
	description?: string;
	agent?: string;
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

	// step-start / step-finish / file / snapshot / retry / compaction — ignored.
	// `agent` and `subtask` parts are decoded externally via decodeOpencodeAgentPart
	// because their start/end semantics require caller-owned dedup state.
	return { event: null, newEmittedLen: alreadyEmittedLen };
}

/**
 * Decode a `type: "agent"` or `type: "subtask"` part into either a
 * `subagent-start` or `subagent-end` event. State is caller-owned because
 * opencode resends the part on state transitions and we want exactly one
 * start and one end per partId.
 *
 * Returns null when the part should be skipped (already seen in the
 * appropriate state).
 */
export function decodeOpencodeAgentPart(
	part: OpencodePart,
	state: {
		seenAgentStartPartIds: Set<string>;
		agentEndedPartIds: Set<string>;
	},
): NormalizedAgentEvent | null {
	if (part.type !== "agent" && part.type !== "subtask") return null;
	const partId = typeof part.id === "string" ? part.id : null;
	if (!partId) return null;

	const stateStatus =
		typeof part.state === "object" && part.state !== null
			? typeof part.state["status"] === "string"
				? (part.state["status"] as string)
				: null
			: null;
	// `subtask` parts don't carry a `state.status` — they're emitted once
	// with the agent name + prompt, and the actual sub-agent message stream
	// lives on a child messageID. We treat them as "start" on first sighting
	// and never emit an "end" (the caller pairs with the eventual sub-agent
	// message's terminal text).
	const isRunning =
		stateStatus === null ||
		stateStatus === "running" ||
		stateStatus === "pending";
	const isCompleted =
		stateStatus === "completed" || stateStatus === "done";
	const isError =
		stateStatus === "error" ||
		stateStatus === "errored" ||
		stateStatus === "failed";

	if (isRunning) {
		if (state.seenAgentStartPartIds.has(partId)) return null;
		state.seenAgentStartPartIds.add(partId);
		const subagentType =
			(typeof part.agent === "string" && part.agent) ||
			(typeof part.name === "string" && part.name) ||
			"general-purpose";
		const description =
			(typeof part.description === "string" && part.description) ||
			subagentType;
		const prompt =
			(typeof part.prompt === "string" && part.prompt) || "";
		return {
			kind: "subagent-start",
			providerCallId: partId,
			subagentType,
			description,
			prompt,
			source: "opencode",
		};
	}

	if (isCompleted || isError) {
		if (state.agentEndedPartIds.has(partId)) return null;
		state.agentEndedPartIds.add(partId);
		const stateObj = part.state as Record<string, unknown> | undefined;
		const result =
			typeof stateObj?.["result"] === "string"
				? (stateObj["result"] as string)
				: typeof stateObj?.["output"] === "string"
					? (stateObj["output"] as string)
					: "";
		return {
			kind: "subagent-end",
			providerCallId: partId,
			result,
			ok: !isError,
			source: "opencode",
		};
	}

	return null;
}

/**
 * Decode a `todo.updated` SSE event body. Returns the snapshot — caller is
 * responsible for content-hashing to suppress no-op resends.
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
		const id = typeof t["id"] === "string" ? (t["id"] as string) : null;
		const content = typeof t["content"] === "string" ? (t["content"] as string) : "";
		if (!id || content.length === 0) continue;
		out.push({
			id,
			content,
			activeForm: null,
			status: normalizeTaskStatus(t["status"]),
			priority: normalizeTaskPriority(t["priority"]),
		});
	}
	return out;
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
		agentEndedPartIds?: Set<string>;
		subagentMessageIdMap?: Map<string, string>;
	},
	emit: (ev: NormalizedAgentEvent) => void,
): void {
	const seenAgentStartPartIds =
		state.seenAgentStartPartIds ?? new Set<string>();
	const agentEndedPartIds = state.agentEndedPartIds ?? new Set<string>();
	const subagentMessageIdMap =
		state.subagentMessageIdMap ?? new Map<string, string>();
	for (const part of parts) {
		// Allow assistant-authored parts AND child-message parts (sub-agent
		// authored) through the assistant-id filter.
		const childMatch =
			part.messageID && subagentMessageIdMap.has(part.messageID);
		if (
			part.messageID &&
			((state.userMessageIDs && state.userMessageIDs.has(part.messageID)) ||
				(state.assistantMessageID !== undefined &&
					state.assistantMessageID !== "" &&
					part.messageID !== state.assistantMessageID &&
					!childMatch))
		) {
			continue;
		}
		if (part.type === "agent" || part.type === "subtask") {
			const ev = decodeOpencodeAgentPart(part, {
				seenAgentStartPartIds,
				agentEndedPartIds,
			});
			if (ev) {
				if (ev.kind === "subagent-start") {
					const childMsgId = extractChildMessageId(part);
					if (childMsgId)
						subagentMessageIdMap.set(childMsgId, ev.providerCallId);
				}
				emit(ev);
			}
			continue;
		}
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
		// Stamp sub-agent attribution for tool calls authored by a child msg.
		if (
			event.kind === "tool-call" &&
			part.messageID &&
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
		/** Same idea for `subagent-end`. */
		agentEndedPartIds?: Set<string>;
		/**
		 * Last task-list snapshot hash, used to suppress no-op `todo.updated`
		 * resends. Caller-owned so the backstop walk can share if needed.
		 */
		lastTodoSnapshotHash?: { value: string | null };
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
	},
): Promise<void> {
	const emittedTextLen = opts?.emittedTextLen ?? new Map<string, number>();
	const seenToolPartIds = opts?.seenToolPartIds ?? new Set<string>();
	const userMessageIDs = opts?.userMessageIDs ?? new Set<string>();
	const seenAgentStartPartIds =
		opts?.seenAgentStartPartIds ?? new Set<string>();
	const agentEndedPartIds = opts?.agentEndedPartIds ?? new Set<string>();
	const lastTodoSnapshotHash = opts?.lastTodoSnapshotHash ?? {
		value: null as string | null,
	};
	const subagentMessageIdMap =
		opts?.subagentMessageIdMap ?? new Map<string, string>();
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

		if (type === "message.updated") {
			// Learn which message IDs belong to user messages so we can skip
			// their parts. Opencode creates the user message before kicking
			// off inference, so this fires before any assistant
			// `message.part.updated` events — race-free in practice.
			const info = properties["info"];
			if (info && typeof info === "object") {
				const infoObj = info as Record<string, unknown>;
				if (infoObj["role"] === "user" && typeof infoObj["id"] === "string") {
					userMessageIDs.add(infoObj["id"] as string);
				}
			}
			return;
		}

		if (type === "todo.updated") {
			const tasks = decodeOpencodeTodoUpdate(properties);
			const hash = hashTaskSnapshot(tasks);
			if (hash !== lastTodoSnapshotHash.value) {
				lastTodoSnapshotHash.value = hash;
				emit({ kind: "task-list-update", tasks, source: "opencode" });
			}
			return;
		}

		if (type === "message.part.updated") {
			const part = properties["part"] as OpencodePart | undefined;
			const delta =
				typeof properties["delta"] === "string"
					? (properties["delta"] as string)
					: undefined;
			if (!part || typeof part.type !== "string") return;

			// Skip parts belonging to user messages. Without this, opencode's
			// re-emission of the user's input as a `text` part gets decoded as
			// an assistant text-delta and echoed back into the chat bubble.
			if (part.messageID && userMessageIDs.has(part.messageID)) {
				return;
			}

			// Agent / subtask parts: route through the dedicated decoder
			// that owns the start/end dedup. Also populate the
			// messageID → providerCallId map so tool parts authored by
			// the sub-agent's child message can be stamped.
			if (part.type === "agent" || part.type === "subtask") {
				const ev = decodeOpencodeAgentPart(part, {
					seenAgentStartPartIds,
					agentEndedPartIds,
				});
				if (ev) {
					if (ev.kind === "subagent-start") {
						// Best-effort correlation: opencode sometimes carries
						// the child message id under `state.messageID` or
						// `messageID` on subtask parts.
						const childMsgId = extractChildMessageId(part);
						if (childMsgId) {
							subagentMessageIdMap.set(childMsgId, ev.providerCallId);
						}
					}
					emit(ev);
				}
				return;
			}

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
					// Stamp sub-agent attribution if this tool part belongs
					// to a known child message.
					const stamped =
						part.messageID &&
						subagentMessageIdMap.has(part.messageID)
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

/**
 * Best-effort extraction of the sub-agent's child message id from an
 * `agent`/`subtask` part. Different opencode versions stash this in
 * different locations; we try the known ones.
 */
function extractChildMessageId(part: OpencodePart): string | null {
	const state = part.state as Record<string, unknown> | undefined;
	if (state) {
		if (typeof state["messageID"] === "string") return state["messageID"];
		if (typeof state["childMessageID"] === "string")
			return state["childMessageID"];
	}
	// Some builds put the child message id on `part` directly under
	// `childMessageID`.
	if (typeof (part as Record<string, unknown>)["childMessageID"] === "string") {
		return (part as Record<string, unknown>)["childMessageID"] as string;
	}
	return null;
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
