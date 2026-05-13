// ── chat-claude ─────────────────────────────────────────────────────────────
//
// Claude Agent SDK driver for the right-pane chat. Wraps `query()` with
// `persistSession: true` (writes the session JSONL under
// `~/.claude/projects/<dir>/<sessionId>.jsonl`) and either fresh-session or
// `resume: <sessionId>` semantics so multi-turn conversation history lives on
// the agent side, not in our prompt.
//
// Streaming decode (text/reasoning/tool-call extraction from SDK messages)
// lives in `../agent-stream.ts`. This file owns chat-specific concerns only:
// surface filtering (`SURFACED_TOOLS`), MCP review-context registration,
// session-id reporting, and the mapping from `NormalizedAgentEvent` to
// `ChatStreamFrame`.

import type { InteractionMode } from "@revv/shared";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../../db";
import { AiGenerationError } from "../../domain/errors";
import { buildActivity, walkClaudeMessages } from "../agent-stream";
import { createChatMcpServer } from "./chat-mcp-tools";
import { resolveCliBin } from "./cli-agent";
import type { ChatStreamFrame, RawChatStreamFrame } from "./chat-types";

export type { ChatStreamFrame, RawChatStreamFrame } from "./chat-types";

export interface StreamChatViaClaudeOptions {
	readonly message: string;
	readonly systemPrompt: string;
	readonly resumeSessionId?: string | undefined;
	readonly cwd: string;
	/**
	 * Awaited by the driver as soon as the SDK exposes a session id (which
	 * happens after the first iteration of the async generator). The route's
	 * SQLite upsert of `(prId, agent, headSha) → sessionId` therefore lands
	 * before the stream closes, so a follow-up turn's `find()` reliably
	 * sees the row and resumes instead of creating a fresh session.
	 */
	readonly onSessionId?:
		| ((id: string) => Promise<void> | void)
		| undefined;
	readonly abortController?: AbortController | undefined;
	readonly model?: string | undefined;
	/** Bound to the chat MCP server so its `get_review_context` tool can scope queries to the right PR. */
	readonly db: Db;
	readonly prId: string;
	/**
	 * When `false`, the SDK runs without `persistSession`. Used for one-shot
	 * tasks like merge-conflict resolution that must NOT pollute the chat's
	 * persisted session JSONL on disk. Defaults to `true` for the regular
	 * chat flow.
	 */
	readonly persistSession?: boolean | undefined;
	/**
	 * When `false`, the in-process MCP server (`get_review_context`) is not
	 * registered with the SDK. Useful for one-shot tasks (like conflict
	 * resolution) where review context isn't relevant and we want a leaner
	 * tool surface. Defaults to `true`.
	 */
	readonly enableReviewContextMcp?: boolean | undefined;
	/**
	 * Maximum number of agent turns within a single chat invocation.
	 * Sourced from `UserSettings.aiMaxTurns`. Defaults to 60 when omitted.
	 */
	readonly maxTurns?: number | undefined;
	/**
	 * Session-level interaction toggle. When `'plan'`, the SDK runs in
	 * `permissionMode: 'plan'` — the agent can investigate but cannot edit
	 * or run commands; on completion it must call `ExitPlanMode` to surface
	 * a plan for the user to approve.
	 */
	readonly interactionMode?: InteractionMode | undefined;
}

// Tool-use blocks we surface as tool entries in the chat UI. Anything not in
// this set is silently consumed (e.g. system messages, telemetry tools).
// Note: TodoWrite, Task, and ExitPlanMode have dedicated event paths and are
// NOT surfaced as plain activity entries — they route through the
// task-list / subagent-start / plan-presented frames.
const SURFACED_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"LS",
	"Write",
	"Edit",
	"Bash",
]);

const CHAT_CONTEXT_MCP_SERVER = "revv-chat-context";
const CHAT_CONTEXT_MCP_PREFIX = `mcp__${CHAT_CONTEXT_MCP_SERVER}__`;

export function streamChatViaClaude(
	opts: StreamChatViaClaudeOptions,
): ReadableStream<RawChatStreamFrame> {
	const pinned = resolveCliBin("claude");
	const pathOption =
		pinned !== "claude" ? { pathToClaudeCodeExecutable: pinned } : {};

	return new ReadableStream<RawChatStreamFrame>({
		async start(controller) {
			try {
				// Build the options shape carefully — `resume` and `systemPrompt`
				// are mutually exclusive in practice (the SDK reattaches the prior
				// system message from the persisted JSONL on resume).
				// Scope the in-process MCP server to this PR so the
				// `get_review_context` tool returns issues + comments for the
				// right PR. Created per-call because the cwd / db / prId are
				// per-call too.
				const enableMcp = opts.enableReviewContextMcp ?? true;
				const mcpServer = enableMcp
					? createChatMcpServer({ db: opts.db, prId: opts.prId })
					: null;

				// `Task` enables sub-agent delegation; `TodoWrite` enables the
				// agent's own task list; `ExitPlanMode` is required for the SDK
				// to terminate plan-mode cleanly.
				const allowedTools = [
					"Read",
					"Grep",
					"Glob",
					"Write",
					"Edit",
					"Bash",
					"Task",
					"TodoWrite",
					"ExitPlanMode",
				];
				if (enableMcp) {
					allowedTools.push(`${CHAT_CONTEXT_MCP_PREFIX}get_review_context`);
				}

				const planMode = opts.interactionMode === "plan";
				const queryOpts: Record<string, unknown> = {
					cwd: opts.cwd,
					allowedTools,
					...(mcpServer
						? { mcpServers: { [CHAT_CONTEXT_MCP_SERVER]: mcpServer } }
						: {}),
					// In plan mode we trade permission bypass for `permissionMode:
					// 'plan'`. The agent can investigate but cannot mutate the
					// worktree; it must call `ExitPlanMode` to surface a plan for
					// approval. Outside plan mode we keep the existing
					// `bypassPermissions` shape so the chat flow doesn't gain
					// per-tool permission prompts mid-stream.
					permissionMode: planMode ? "plan" : "bypassPermissions",
					...(planMode ? {} : { allowDangerouslySkipPermissions: true }),
					persistSession: opts.persistSession ?? true,
					maxTurns: opts.maxTurns ?? 60,
					...pathOption,
				};

				if (opts.resumeSessionId) {
					queryOpts["resume"] = opts.resumeSessionId;
				} else {
					queryOpts["systemPrompt"] = opts.systemPrompt;
				}

				if (opts.abortController) {
					queryOpts["abortController"] = opts.abortController;
				}
				if (opts.model) {
					queryOpts["model"] = opts.model;
				}

				const q = query({
					prompt: opts.message,
					options: queryOpts,
				});

				let sessionIdReported = false;
				const tryReportSessionId = async (): Promise<void> => {
					if (sessionIdReported || !opts.onSessionId) return;
					let sid: string | undefined;
					try {
						sid = (q as { sessionId?: string }).sessionId;
					} catch {
						// `q.sessionId` getter throws before the session is
						// initialized — keep trying on later iterations.
						return;
					}
					if (typeof sid === "string" && sid.length > 0) {
						// Mark first so concurrent calls (the post-loop "last
						// chance") don't fire the callback twice.
						sessionIdReported = true;
						// Awaited: SQLite upsert in the route handler must
						// commit before the stream closes so a follow-up turn
						// can resume this session.
						await opts.onSessionId(sid);
					}
				};

				// Map normalized events → ChatStreamFrame. Reasoning is surfaced
				// to chat (the panel renders a thinking indicator while it's
				// streaming); walkthrough drops it on the floor (separate
				// caller). Tool-call → activity, filtered by `SURFACED_TOOLS`
				// for built-ins or the chat-context MCP server name for MCP.
				//
				// `hasEmittedText` + `lastWasNonText` insert a paragraph break
				// before any text-delta that follows a non-text event (tool
				// call, reasoning, error). Without this, Claude's content
				// blocks ("Now let me check:", tool_use, "Clear picture.")
				// get concatenated into "Now let me check:Clear picture." in
				// the assistant bubble because text-deltas are appended via
				// `||`. The separator lands in both the streamed frame and
				// the persisted content, so reloads also render correctly.
				let hasEmittedText = false;
				let lastWasNonText = false;
				const emit = (ev: import("../agent-stream").NormalizedAgentEvent): void => {
					if (ev.kind === "text-delta") {
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
						if (ev.source === "builtin") {
							if (!SURFACED_TOOLS.has(ev.toolName)) return;
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
						} else if (
							ev.source === "mcp" &&
							ev.mcpServer === CHAT_CONTEXT_MCP_SERVER
						) {
							const base = {
								kind: "activity" as const,
								activityKind: "tool.mcp" as const,
								toolName: ev.toolName,
								summary: `Looking up review context (${ev.bareName})`,
								...(ev.input !== undefined ? { payload: ev.input } : {}),
							};
							controller.enqueue(
								ev.subagentProviderCallId
									? { ...base, subagentProviderCallId: ev.subagentProviderCallId }
									: base,
							);
							lastWasNonText = true;
						}
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
						controller.enqueue({ kind: "text", data: `\n\n_Error: ${ev.message}_` });
						hasEmittedText = true;
						lastWasNonText = false;
					}
				};

				await walkClaudeMessages(q, emit, {
					onMessage: tryReportSessionId,
				});

				// Last chance to grab the session id — some early aborts never
				// emit an assistant message.
				await tryReportSessionId();
				controller.close();
			} catch (err) {
				controller.error(new AiGenerationError({ cause: err }));
			}
		},
	});
}
