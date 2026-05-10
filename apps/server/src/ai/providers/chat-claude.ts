// ── chat-claude ─────────────────────────────────────────────────────────────
//
// Claude Agent SDK driver for the right-pane chat. Wraps `query()` with
// `persistSession: true` (writes the session JSONL under
// `~/.claude/projects/<dir>/<sessionId>.jsonl`) and either fresh-session or
// `resume: <sessionId>` semantics so multi-turn conversation history lives on
// the agent side, not in our prompt.
//
// Surfaces a unified frame stream — text deltas + tool-use lines — that the
// chat route forwards over SSE for the UI to render inline.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "../../db";
import { AiGenerationError } from "../../domain/errors";
import { buildExplorationDescription } from "../prompts/walkthrough";
import { createChatMcpServer } from "./chat-mcp-tools";
import { resolveCliBin } from "./cli-agent";
import { classifyTool, type ChatStreamFrame } from "./chat-types";

export type { ChatStreamFrame } from "./chat-types";

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
}

// Tool-use blocks we surface as tool entries in the chat UI. Anything not in
// this set is silently consumed (e.g. system messages, telemetry tools).
const SURFACED_TOOLS = new Set([
	"Read",
	"Grep",
	"Glob",
	"LS",
	"Write",
	"Edit",
	"Bash",
]);

// MCP tool names arrive as `mcp__<server>__<tool>`. We render those with a
// short prefix so the user knows it's structured-context lookup, not a file
// op.
const MCP_TOOL_PREFIX = "mcp__revv-chat-context__";

export function streamChatViaClaude(
	opts: StreamChatViaClaudeOptions,
): ReadableStream<ChatStreamFrame> {
	const pinned = resolveCliBin("claude");
	const pathOption =
		pinned !== "claude" ? { pathToClaudeCodeExecutable: pinned } : {};

	return new ReadableStream<ChatStreamFrame>({
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

				const allowedTools = [
					"Read",
					"Grep",
					"Glob",
					"Write",
					"Edit",
					"Bash",
				];
				if (enableMcp) {
					allowedTools.push(`${MCP_TOOL_PREFIX}get_review_context`);
				}

				const queryOpts: Record<string, unknown> = {
					cwd: opts.cwd,
					allowedTools,
					...(mcpServer
						? { mcpServers: { "revv-chat-context": mcpServer } }
						: {}),
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					persistSession: opts.persistSession ?? true,
					maxTurns: 50,
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

				for await (const message of q) {
					await tryReportSessionId();

					if (message.type === "assistant") {
						const content = (
							message as {
								type: "assistant";
								message: {
									content: Array<{
										type: string;
										text?: string;
										name?: string;
										input?: unknown;
									}>;
								};
							}
						).message.content;

						for (const block of content) {
							if (block.type === "text" && typeof block.text === "string") {
								controller.enqueue({ kind: "text", data: block.text });
							} else if (
								block.type === "tool_use" &&
								typeof block.name === "string"
							) {
								if (SURFACED_TOOLS.has(block.name)) {
									controller.enqueue({
										kind: "activity",
										activityKind: classifyTool(block.name),
										toolName: block.name,
										summary: buildExplorationDescription(
											block.name,
											block.input,
										),
										payload: block.input,
									});
								} else if (block.name.startsWith(MCP_TOOL_PREFIX)) {
									const short = block.name.slice(MCP_TOOL_PREFIX.length);
									controller.enqueue({
										kind: "activity",
										activityKind: "tool.mcp",
										toolName: block.name,
										summary: `Looking up review context (${short})`,
										payload: block.input,
									});
								}
							}
						}
					}
				}

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
