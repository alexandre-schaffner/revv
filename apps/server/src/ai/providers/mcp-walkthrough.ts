// ─── mcp-walkthrough ────────────────────────────────────────────────────────
//
// Claude Agent SDK driver. Registers the SHARED phase-bound tool handlers
// (from walkthrough-tools.ts) as in-process MCP tools. Per doctrine invariant
// #13 (Agent-path parity), the handlers run here via the SDK's `mcpServers`
// config AND the HTTP MCP route (used by opencode) run the same code — one
// source of truth, two drivers.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	RatingAxis,
	UserSettings,
	WalkthroughBlock,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
} from "@revv/shared";
import { debug } from "../../logger";
import type { Db } from "../../db";
import type { PrFileMeta } from "../../services/GitHub";
import {
	buildExplorationDescription,
	buildWalkthroughPrompt,
	WALKTHROUGH_MCP_SYSTEM_PROMPT,
} from "../prompts/walkthrough";
import { createWalkthroughMcpServer } from "./walkthrough-tools";
import { resolveCliBin } from "./cli-agent";

// ── Continuation context ─────────────────────────────────────────────────────

/**
 * Informational context passed into the provider on resume. Note: under the
 * new doctrine, the agent no longer CONSUMES this (it calls
 * `get_walkthrough_state` via MCP instead). Kept for the provider's own
 * bookkeeping — e.g. opencode uses `opencodeSessionId` for `--continue`.
 */
export interface ContinuationContext {
	walkthroughId: string;
	existingBlocks: WalkthroughBlock[];
	existingIssueCount: number;
	existingRatedAxes: RatingAxis[];
	opencodeSessionId?: string;
}

// ── Built-in tools the model can use for file exploration ───────────────────

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash"]);

const MCP_TOOL_PREFIX = "mcp__revv-walkthrough__";

// New phase-bound tool set. See walkthrough-tools.ts TOOL_SPECS for the
// canonical list; the names here must match the handler registrations.
const ALLOWED_TOOLS = [
	// Built-in exploration
	"Read",
	"Grep",
	"Glob",
	// MCP walkthrough tools (A→B→C→D)
	`${MCP_TOOL_PREFIX}get_walkthrough_state`,
	`${MCP_TOOL_PREFIX}set_overview`,
	`${MCP_TOOL_PREFIX}add_diff_step`,
	`${MCP_TOOL_PREFIX}flag_issue`,
	`${MCP_TOOL_PREFIX}set_sentiment`,
	`${MCP_TOOL_PREFIX}rate_axis`,
	`${MCP_TOOL_PREFIX}complete_walkthrough`,
];

// ── Thinking effort → Claude Agent SDK options ───────────────────────────────
//
// User-facing setting (UI) maps to a small set of SDK-level knobs. We keep
// this mapping isolated here so changing the UI vocabulary doesn't ripple.

function applyThinkingEffort(
	effort: UserSettings["aiThinkingEffort"],
): Record<string, unknown> {
	// The Claude Agent SDK's `query()` accepts thinking-budget-adjacent options
	// through its underlying Anthropic thinking API. Currently the SDK exposes
	// `thinkingBudgetTokens` on Sonnet-family models. We translate our UI
	// vocabulary into conservative budgets; unrecognized values fall back to
	// the SDK default (no explicit budget).
	switch (effort) {
		case "ultrathink":
			return { thinkingBudgetTokens: 32000 };
		case "max":
			return { thinkingBudgetTokens: 16000 };
		case "extra-high":
			return { thinkingBudgetTokens: 8000 };
		case "high":
			return { thinkingBudgetTokens: 4000 };
		case "medium":
			return { thinkingBudgetTokens: 2000 };
		case "low":
			return { thinkingBudgetTokens: 1000 };
		default:
			return {};
	}
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Stream walkthrough via Claude Agent SDK with MCP tool calls.
 *
 * The SDK registers our shared phase-bound tool handlers (from
 * walkthrough-tools.ts) as in-process MCP tools. Each handler commits its
 * write to SQLite inside a transaction (doctrine invariant #3), then emits
 * a WalkthroughStreamEvent which this generator surfaces.
 */
export function streamWalkthroughViaMCP(
	params: {
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
		abortController?: AbortController;
	},
	model?: string,
	settings?: UserSettings,
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

	// Shared tool handlers run with this context. No mutable "state" object
	// anymore — all state lives in the DB (doctrine invariant #1).
	const walkthroughServer = createWalkthroughMcpServer({
		db: params.db,
		walkthroughId: params.walkthroughId,
		emit: push,
	});

	const userMessage = buildWalkthroughPrompt(
		params,
		undefined,
		params.continuation,
	);

	let errorEmitted = false;
	let anySummaryEmitted = false;

	const queryTask = (async (): Promise<WalkthroughTokenUsage> => {
		debug(
			"walkthrough-mcp",
			"Starting MCP walkthrough in:",
			params.worktreePath,
			"model:",
			model ?? "default",
		);

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

			const thinkingOptions = settings?.aiThinkingEffort
				? applyThinkingEffort(settings.aiThinkingEffort)
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
					// 9 rate_axis calls layered on top of the N add_diff_step
					// calls + flag_issue + set_overview + set_sentiment. Raise
					// the turn ceiling so complex PRs don't truncate.
					maxTurns: 60,
					abortController,
					...(model ? { model } : {}),
					...pathOption,
					...thinkingOptions,
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
							if (currentPhase === "connecting") {
								currentPhase = "exploring";
								push({
									type: "phase",
									data: {
										phase: "exploring",
										message:
											"Reading files and understanding changes...",
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
						// Phase lifecycle (UI-facing). New tool names: set_overview
						// → analyzing, add_diff_step → writing, rate_axis → rating,
						// complete_walkthrough → finishing.
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}set_overview`
						) {
							anySummaryEmitted = true;
							if (
								currentPhase !== "analyzing" &&
								currentPhase !== "finishing"
							) {
								currentPhase = "analyzing";
								push({
									type: "phase",
									data: {
										phase: "analyzing",
										message:
											"Forming assessment and risk analysis...",
									},
								});
							}
						}
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}add_diff_step`
						) {
							if (
								currentPhase !== "writing" &&
								currentPhase !== "rating" &&
								currentPhase !== "finishing"
							) {
								currentPhase = "writing";
								push({
									type: "phase",
									data: {
										phase: "writing",
										message: "Building walkthrough...",
									},
								});
							}
						}
						if (
							block.type === "tool_use" &&
							block.name === `${MCP_TOOL_PREFIX}rate_axis`
						) {
							if (
								currentPhase !== "rating" &&
								currentPhase !== "finishing"
							) {
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
						if (
							block.type === "tool_use" &&
							block.name ===
								`${MCP_TOOL_PREFIX}complete_walkthrough`
						) {
							if (currentPhase !== "finishing") {
								currentPhase = "finishing";
								push({
									type: "phase",
									data: {
										phase: "finishing",
										message: "Wrapping up...",
									},
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
					tokenUsage = {
						inputTokens: result.usage.input_tokens,
						outputTokens: result.usage.output_tokens,
						cacheReadInputTokens:
							result.usage.cache_read_input_tokens ?? 0,
						cacheCreationInputTokens:
							result.usage.cache_creation_input_tokens ?? 0,
					};
				}
			}

			debug("walkthrough-mcp", "Query complete.");
			return tokenUsage;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			debug("walkthrough-mcp", "Query error/abort:", message);
			errorEmitted = true;
			push({
				type: "error",
				data: { code: "AiGenerationError", message },
			});
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
