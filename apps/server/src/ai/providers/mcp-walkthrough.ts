import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	RatingAxis,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
	WalkthroughBlock,
} from "@revv/shared";
import { debug } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import {
	buildExplorationDescription,
	buildWalkthroughPrompt,
	WALKTHROUGH_MCP_SYSTEM_PROMPT,
} from "../prompts/walkthrough";
import {
	createWalkthroughMcpServer,
	type WalkthroughEmitter,
} from "./walkthrough-tools";
import { resolveCliBin } from "./cli-agent";

// ── Continuation context ─────────────────────────────────────────────────────

export interface ContinuationContext {
	walkthroughId: string;
	existingBlocks: WalkthroughBlock[];
	existingIssueCount: number;
	existingRatedAxes: RatingAxis[];
	opencodeSessionId?: string; // only used by opencode provider
}

// ── Built-in tools the model can use for file exploration ───────────────────

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);

const MCP_TOOL_PREFIX = "mcp__revv-walkthrough__";

const ALLOWED_TOOLS = [
	// Built-in exploration
	"Read",
	"Grep",
	"Glob",
	// MCP walkthrough tools
	`${MCP_TOOL_PREFIX}set_walkthrough_summary`,
	`${MCP_TOOL_PREFIX}add_markdown_section`,
	`${MCP_TOOL_PREFIX}add_code_block`,
	`${MCP_TOOL_PREFIX}add_diff_block`,
	`${MCP_TOOL_PREFIX}flag_issue`,
	`${MCP_TOOL_PREFIX}rate_axis`,
	`${MCP_TOOL_PREFIX}complete_walkthrough`,
];

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Stream walkthrough via Claude Agent SDK with MCP tool calls.
 * The model explores the worktree using built-in tools, then builds
 * the walkthrough by calling custom MCP tools that emit SSE events.
 */
export function streamWalkthroughViaMCP(
	params: {
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
		/**
		 * Caller-owned abort signal. When provided, the MCP query uses this
		 * controller directly instead of minting its own; calling `.abort()`
		 * upstream kills the child turn immediately. The built-in 10-minute
		 * timeout is still scheduled, but it also routes through this controller.
		 */
		abortController?: AbortController;
	},
	model?: string,
): AsyncGenerator<WalkthroughStreamEvent> {
	// ── Shared event queue + waiter pattern ──────────────────────────────
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

	// ── Create MCP server with emitter ──────────────────────────────────
	const emitter: WalkthroughEmitter = {
		emit: push,
		state: {
			summarySet: false,
			blockCount: 0,
			issueCount: 0,
			completed: false,
			writingPhaseEmitted: false,
			ratedAxes: new Set<RatingAxis>(),
		},
	};

	// When resuming, pre-seed emitter state so new blocks get correct order
	// indices AND so the 9-axis completeness check knows which axes were
	// already rated in the previous partial run. Without ratedAxes pre-seeding,
	// complete_walkthrough would fail on any resume that had already rated
	// some axes, and the model would waste turns re-rating them.
	const initialState = params.continuation
		? {
				summarySet: true,
				blockCount: params.continuation.existingBlocks.length,
				issueCount: params.continuation.existingIssueCount,
				writingPhaseEmitted: params.continuation.existingBlocks.length > 0,
				ratedAxes: params.continuation.existingRatedAxes,
			}
		: undefined;
	const walkthroughServer = createWalkthroughMcpServer(emitter, initialState);

	// ── Build prompt ────────────────────────────────────────────────────
	const userMessage = buildWalkthroughPrompt(
		params,
		undefined,
		params.continuation,
	);

	// ── Run query in background ─────────────────────────────────────────
	let errorEmitted = false;

	const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
		debug(
			"walkthrough-mcp",
			"Starting MCP walkthrough in:",
			params.worktreePath,
			"model:",
			model ?? "default",
		);

		// Prefer the caller-supplied controller so `cancel(walkthroughId)` or a
		// Scope finalizer can signal abort from outside this module. The local
		// 10-minute timeout then fires through the shared controller so both
		// external cancellation and the hard timeout converge on the same signal.
		const abortController = params.abortController ?? new AbortController();
		const timeoutId = setTimeout(
			() => {
				debug(
					"walkthrough-mcp",
					"Aborting walkthrough — timed out after 10 minutes",
				);
				abortController.abort(
					new Error("Walkthrough generation timed out after 10 minutes"),
				);
			},
			10 * 60 * 1000,
		);

		// Track phase transitions so we only emit each phase once
		let currentPhase:
			| "connecting"
			| "exploring"
			| "analyzing"
			| "writing"
			| "rating"
			| "finishing" = "connecting";

		try {
			const pinnedClaude = resolveCliBin("claude");
			const pathOption =
				pinnedClaude !== "claude"
					? { pathToClaudeCodeExecutable: pinnedClaude }
					: {};

			const q = query({
				prompt: userMessage,
				options: {
					systemPrompt: WALKTHROUGH_MCP_SYSTEM_PROMPT,
					cwd: params.worktreePath,
					tools: ["Read", "Grep", "Glob"],
					allowedTools: ALLOWED_TOOLS,
					mcpServers: { "revv-walkthrough": walkthroughServer },
					permissionMode: "bypassPermissions",
					allowDangerouslySkipPermissions: true,
					persistSession: false,
					// 9 rate_axis calls are layered on top of the existing block +
					// flag_issue tool usage. Raise the turn ceiling so complex PRs
					// don't silently truncate ratings before complete_walkthrough.
					maxTurns: 45,
					abortController,
					...(model ? { model } : {}),
					...pathOption,
				},
			});

			let tokenUsage: WalkthroughTokenUsage = {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			};

			for await (const message of q) {
				if (message.type === "assistant") {
					// Detect exploration tool_use blocks → emit exploration events
					const content = (
						message as {
							type: "assistant";
							message: {
								content: Array<{
									type: string;
									name?: string;
									input?: unknown;
								}>;
							};
						}
					).message.content;
					for (const block of content) {
						if (
							block.type === "tool_use" &&
							block.name &&
							EXPLORATION_TOOLS.has(block.name)
						) {
							// Transition to exploring phase on first exploration tool call
							if (currentPhase === "connecting") {
								currentPhase = "exploring";
								push({
									type: "phase",
									data: {
										phase: "exploring",
										message: "Reading files and understanding changes...",
									},
								});
							}
							const description = buildExplorationDescription(
								block.name,
								block.input,
							);
							push({
								type: "exploration",
								data: { tool: block.name, description },
							});
						}
						// Transition to analyzing when the model calls set_walkthrough_summary
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}set_walkthrough_summary`
						) {
							if (
								currentPhase !== "analyzing" &&
								currentPhase !== "finishing"
							) {
								currentPhase = "analyzing";
								push({
									type: "phase",
									data: {
										phase: "analyzing",
										message: "Forming assessment and risk analysis...",
									},
								});
							}
						}
						// Transition to writing when the model starts emitting content blocks
						// (handled by walkthrough-tools the first time a block is added).
						// Transition to rating when the model starts the batched scorecard pass.
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}rate_axis`
						) {
							if (currentPhase !== "rating" && currentPhase !== "finishing") {
								currentPhase = "rating";
								push({
									type: "phase",
									data: {
										phase: "rating",
										message: "Scoring the PR across 9 axes...",
									},
								});
							}
						}
						// Transition to finishing when complete_walkthrough is called
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}complete_walkthrough`
						) {
							if (currentPhase !== "finishing") {
								currentPhase = "finishing";
								push({
									type: "phase",
									data: { phase: "finishing", message: "Wrapping up..." },
								});
							}
						}
					}
				} else if (message.type === "result") {
					const result = message as {
						type: "result";
						subtype: string;
						usage: {
							input_tokens: number;
							output_tokens: number;
							cache_read_input_tokens?: number;
							cache_creation_input_tokens?: number;
						};
					};
					// Capture usage from all result subtypes (success and error variants)
					tokenUsage = {
						inputTokens: result.usage.input_tokens,
						outputTokens: result.usage.output_tokens,
						cacheReadInputTokens: result.usage.cache_read_input_tokens ?? 0,
						cacheCreationInputTokens:
							result.usage.cache_creation_input_tokens ?? 0,
					};
				}
			}

			debug(
				"walkthrough-mcp",
				"Query complete. Blocks emitted:",
				emitter.state.blockCount,
			);
			return tokenUsage;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			debug("walkthrough-mcp", "Query error/abort:", message);
			errorEmitted = true;
			push({ type: "error", data: { code: "AiGenerationError", message } });
			return {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	})();

	// ── Async generator that yields events from the queue ────────────────
	return (async function* (): AsyncGenerator<WalkthroughStreamEvent> {
		const resultPromise = queryTask.then((usage) => {
			queryDone = true;
			if (waiter) {
				waiter.resolve();
				waiter = null;
			}
			return usage;
		});

		// Yield events as they arrive from tool handlers
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

		// Drain remaining events
		for (const e of events.splice(0)) {
			yield e;
		}

		const tokenUsage = await resultPromise;

		if (emitter.state.summarySet) {
			// Normal completion — summary was set, emit done with token usage
			yield {
				type: "done" as const,
				data: {
					walkthroughId: "",
					tokenUsage,
				},
			};
		} else if (!errorEmitted) {
			// The model finished (or exhausted maxTurns) without ever calling
			// set_walkthrough_summary. Without this, the generator exits silently —
			// no done, no error — leaving the client skeleton spinning indefinitely
			// until the stream TCP-closes.
			debug(
				"walkthrough-mcp",
				"Query completed without producing a summary — emitting fallback error",
			);
			yield {
				type: "error" as const,
				data: {
					code: "NoSummaryGenerated",
					message:
						"The AI finished exploring but did not produce a walkthrough. This can happen with complex PRs. Try regenerating.",
				},
			};
		}
	})();
}
