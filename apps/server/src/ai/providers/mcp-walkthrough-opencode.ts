import type {
	RatingAxis,
	WalkthroughBlock,
	WalkthroughStreamEvent,
	WalkthroughTokenUsage,
	CarriedOverIssue,
} from "@revv/shared";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug } from "../../logger";
import type { PrFileMeta } from "../../services/GitHub";
import {
	buildExplorationDescription,
	buildWalkthroughPrompt,
	WALKTHROUGH_MCP_SYSTEM_PROMPT,
} from "../prompts/walkthrough";
import type { ContinuationContext } from "./mcp-walkthrough";
import {
	buildOpencodeConfig,
	getStdioServerPath,
	withTempOpencodeConfig,
} from "./opencode-config";
import { createInitialState, type WalkthroughToolState } from "./walkthrough-tool-spec";

// ── Built-in exploration tools opencode exposes ──────────────────────────────

const EXPLORATION_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "TodoRead", "TodoWrite"]);
const MCP_TOOL_PREFIX = "revv-walkthrough_";

// ── JSON frame shapes from opencode --format json ────────────────────────────

interface OpencodeFrame {
	type: string;
	part?: {
		type?: string;
		tool?: string;
		state?: { input?: unknown; output?: string };
		reason?: string;
		sessionId?: string;
	};
	id?: string;
	usage?: {
		// camelCase (opencode's format)
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		// snake_case fallback
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

// ── Event reconstruction helper ───────────────────────────────────────────────

/**
 * Given a tool name suffix (without the MCP prefix) and the tool's input args,
 * reconstruct the WalkthroughStreamEvent(s) that the tool handler would emit.
 * Mutates `state` to keep counters in sync.
 */
function reconstructEvents(
	toolSuffix: string,
	input: unknown,
	state: WalkthroughToolState,
): WalkthroughStreamEvent[] {
	const args = (input ?? {}) as Record<string, unknown>;
	const events: WalkthroughStreamEvent[] = [];

	if (toolSuffix === "set_walkthrough_summary") {
		state.summarySet = true;
		events.push({
			type: "phase",
			data: { phase: "analyzing", message: "Forming assessment and risk analysis..." },
		});
		events.push({
			type: "summary",
			data: {
				summary: String(args["summary"] ?? ""),
				riskLevel: (args["risk_level"] as "low" | "medium" | "high") ?? "low",
			},
		});
	} else if (
		toolSuffix === "add_markdown_section" ||
		toolSuffix === "add_code_block" ||
		toolSuffix === "add_diff_block"
	) {
		if (!state.writingPhaseEmitted) {
			state.writingPhaseEmitted = true;
			events.push({
				type: "phase",
				data: { phase: "writing", message: "Building walkthrough..." },
			});
		}

		if (toolSuffix === "add_markdown_section") {
			const block: WalkthroughBlock = {
				type: "markdown",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				content: String(args["content"] ?? ""),
			};
			state.blockCount++;
			events.push({ type: "block", data: block });
		} else if (toolSuffix === "add_code_block") {
			const block: WalkthroughBlock = {
				type: "code",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				filePath: String(args["file_path"] ?? ""),
				startLine: Number(args["start_line"] ?? 0),
				endLine: Number(args["end_line"] ?? 0),
				language: String(args["language"] ?? "text"),
				content: String(args["content"] ?? ""),
				annotation:
					args["annotation"] !== undefined && args["annotation"] !== null
						? String(args["annotation"])
						: null,
				annotationPosition:
					args["annotation_position"] === "right" ? "right" : "left",
			};
			state.blockCount++;
			events.push({ type: "block", data: block });
		} else {
			// add_diff_block
			const block: WalkthroughBlock = {
				type: "diff",
				id: `block-${state.blockCount}`,
				order: state.blockCount,
				filePath: String(args["file_path"] ?? ""),
				patch: String(args["patch"] ?? ""),
				annotation:
					args["annotation"] !== undefined && args["annotation"] !== null
						? String(args["annotation"])
						: null,
				annotationPosition:
					args["annotation_position"] === "right" ? "right" : "left",
			};
			state.blockCount++;
			events.push({ type: "block", data: block });
		}
	} else if (toolSuffix === "flag_issue") {
		const rawBlockOrders = args["block_orders"];
		const blockOrders: number[] = Array.isArray(rawBlockOrders)
			? rawBlockOrders.filter((o): o is number => typeof o === "number")
			: [];
		const uniqueOrders = Array.from(new Set(blockOrders));
		const blockIds = uniqueOrders.map((o) => `block-${o}`);

		const rawSeverity = String(args["severity"] ?? "info");
		const severity: "info" | "warning" | "critical" =
			rawSeverity === "warning" || rawSeverity === "critical" ? rawSeverity : "info";

		const issue = {
			id: `issue-${state.issueCount}`,
			severity,
			title: String(args["title"] ?? ""),
			description: String(args["description"] ?? ""),
			blockIds,
			...(args["file_path"] != null ? { filePath: String(args["file_path"]) } : {}),
			...(args["start_line"] != null ? { startLine: Number(args["start_line"]) } : {}),
			...(args["end_line"] != null ? { endLine: Number(args["end_line"]) } : {}),
		};
		state.issueCount++;
		events.push({ type: "issue", data: issue });
	} else if (toolSuffix === "rate_axis") {
		const axis = String(args["axis"] ?? "") as RatingAxis;
		if (!state.ratedAxes.has(axis)) {
			state.ratedAxes.add(axis);

			if (state.ratedAxes.size === 1) {
				// First rating — emit phase transition
				events.push({
					type: "phase",
					data: { phase: "rating", message: "Scoring the PR across 9 axes..." },
				});
			}

			const rawCitations = args["citations"];
			const citations = Array.isArray(rawCitations)
				? rawCitations
						.filter(
							(c): c is Record<string, unknown> =>
								typeof c === "object" && c !== null,
						)
						.map((c) => ({
							filePath: String(c["file_path"] ?? ""),
							startLine: Number(c["start_line"] ?? 0),
							endLine: Number(c["end_line"] ?? 0),
							...(c["note"] != null ? { note: String(c["note"]) } : {}),
						}))
				: [];

			const rawBlockOrders = args["block_orders"];
			const blockOrders: number[] = Array.isArray(rawBlockOrders)
				? rawBlockOrders.filter((o): o is number => typeof o === "number")
				: [];
			const blockIds = Array.from(new Set(blockOrders)).map((o) => `block-${o}`);

			events.push({
				type: "rating",
				data: {
					axis,
					verdict: (args["verdict"] as "pass" | "concern" | "blocker") ?? "pass",
					confidence: (args["confidence"] as "low" | "medium" | "high") ?? "low",
					rationale: String(args["rationale"] ?? ""),
					details: String(args["details"] ?? ""),
					citations,
					blockIds,
				},
			});
		}
	} else if (toolSuffix === "complete_walkthrough") {
		events.push({
			type: "phase",
			data: { phase: "finishing", message: "Wrapping up..." },
		});
		events.push({
			type: "done",
			data: {
				walkthroughId: "",
				tokenUsage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				},
			},
		});
	}

	return events;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Stream a walkthrough by spawning opencode with an MCP config that registers
 * the revv-walkthrough tools. Events are reconstructed by observing tool_use
 * frames in opencode's --format json stdout stream.
 */
export function streamWalkthroughViaOpencodeMCP(
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
		onSessionId?: (sessionId: string) => void;
		carriedOverIssues?: CarriedOverIssue[];
		/**
		 * Caller-owned abort signal. When provided, `.abort()` kills the spawned
		 * `opencode run` subprocess — this is how {@link WalkthroughJobs.cancel}
		 * propagates into the AI turn. The built-in 10-minute timeout layers on
		 * top of this controller, not a separately-minted one.
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

	// ── Local emitter state (mirrors what the stdio server holds) ────────
	const state = createInitialState();
	if (params.continuation) {
		state.summarySet = true;
		state.blockCount = params.continuation.existingBlocks.length;
		state.issueCount = params.continuation.existingIssueCount;
		state.writingPhaseEmitted = params.continuation.existingBlocks.length > 0;
		for (const axis of params.continuation.existingRatedAxes) {
			state.ratedAxes.add(axis);
		}
	}

	// ── Build prompt and config ───────────────────────────────────────────
	const userMessage =
		WALKTHROUGH_MCP_SYSTEM_PROMPT + "\n\n---\n\n" + buildWalkthroughPrompt(params, undefined, params.continuation, params.carriedOverIssues);

	const initialState = params.continuation
		? {
				blockCount: params.continuation.existingBlocks.length,
				issueCount: params.continuation.existingIssueCount,
				summarySet: true,
				ratedAxes: params.continuation.existingRatedAxes,
			}
		: undefined;

	const configContent = buildOpencodeConfig({
		stdioServerPath: getStdioServerPath(),
		...(initialState !== undefined ? { initialState } : {}),
		...(model !== undefined ? { model } : {}),
	});

	// ── Run opencode in background ────────────────────────────────────────
	let errorEmitted = false;

	const queryTask = withTempOpencodeConfig(
		params.worktreePath,
		configContent,
		async (): Promise<WalkthroughTokenUsage> => {
			debug(
				"walkthrough-opencode-mcp",
				"Starting opencode MCP walkthrough in:",
				params.worktreePath,
				"model:",
				model ?? "default",
			);

			push({
				type: "phase",
				data: { phase: "connecting", message: "Connecting to AI model..." },
			});

			const cliArgs = [
				"opencode",
				"run",
				"--format",
				"json",
				"--dangerously-skip-permissions",
				...(model !== undefined ? ["--model", model] : []),
				...(params.continuation?.opencodeSessionId !== undefined
					? ["--session", params.continuation.opencodeSessionId]
					: []),
			];

			const proc = Bun.spawn(cliArgs, {
				cwd: params.worktreePath,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});

			proc.stdin.write(userMessage);
			proc.stdin.end();

			// Wire external cancellation into the subprocess lifecycle. If the
			// caller aborts (e.g. {@link WalkthroughJobs.cancel} for a
			// regenerate), we mark the run killed and terminate opencode so the
			// for-await loop below unwinds cleanly instead of waiting on stdout.
			const externalAbort = params.abortController;
			let cancelledByCaller = false;
			const onExternalAbort = () => {
				cancelledByCaller = true;
				debug(
					"walkthrough-opencode-mcp",
					"Received external abort — killing opencode subprocess",
				);
				try {
					proc.kill();
				} catch {
					/* already dead */
				}
			};
			if (externalAbort) {
				if (externalAbort.signal.aborted) {
					// Already aborted before we spawned — kill immediately.
					onExternalAbort();
				} else {
					externalAbort.signal.addEventListener("abort", onExternalAbort, {
						once: true,
					});
				}
			}

			// Collect stderr for debugging
			const stderrPromise = (async () => {
				const dec = new TextDecoder();
				const lines: string[] = [];
				for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
					const text = dec.decode(chunk, { stream: true });
					lines.push(text);
					if (text.trim()) {
						debug("walkthrough-opencode-mcp", "stderr:", text.trim().slice(0, 300));
					}
				}
				return lines.join("");
			})();

			let tokenUsage: WalkthroughTokenUsage = {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
			};

			// Hard timeout — layered on top of the external controller so both
			// paths converge on a single "subprocess is dead" state.
			let killed = false;
			const timeoutId = setTimeout(() => {
				killed = true;
				debug(
					"walkthrough-opencode-mcp",
					"Aborting walkthrough — timed out after 10 minutes",
				);
				try {
					proc.kill();
				} catch {
					/* already dead */
				}
				// Also signal the external controller so any peers waiting on
				// `abortController.signal` (e.g. Scope finalizers) see a consistent
				// aborted state.
				try {
					externalAbort?.abort(
						new Error("Walkthrough generation timed out after 10 minutes"),
					);
				} catch {
					/* already aborted */
				}
			}, CLI_WALKTHROUGH_TIMEOUT_MS);

			try {
				const decoder = new TextDecoder();
				let buffer = "";
				let currentPhase:
					| "connecting"
					| "exploring"
					| "analyzing"
					| "writing"
					| "rating"
					| "finishing" = "connecting";

				for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
					buffer += decoder.decode(chunk, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						let frame: OpencodeFrame;
						try {
							frame = JSON.parse(trimmed) as OpencodeFrame;
						} catch {
							continue;
						}

						// ── Session ID capture ─────────────────────────────────────
						if (frame.type === "session") {
							const sessionId = frame.part?.sessionId ?? frame.id;
							if (sessionId && params.onSessionId) {
								params.onSessionId(sessionId);
							}
						}

						// ── Tool use ───────────────────────────────────────────────
						if (frame.type === "tool_use" && frame.part?.tool) {
							const tool = frame.part.tool;
							const input = frame.part.state?.input;

							if (tool.startsWith(MCP_TOOL_PREFIX)) {
								const suffix = tool.slice(MCP_TOOL_PREFIX.length);
								const reconstructed = reconstructEvents(suffix, input, state);

								// Phase tracking — only advance forward
								for (const evt of reconstructed) {
									if (evt.type === "phase") {
										const phase = evt.data.phase;
										if (
											phase === "analyzing" &&
											currentPhase !== "analyzing" &&
											currentPhase !== "writing" &&
											currentPhase !== "rating" &&
											currentPhase !== "finishing"
										) {
											currentPhase = "analyzing";
										} else if (
											phase === "writing" &&
											currentPhase !== "writing" &&
											currentPhase !== "rating" &&
											currentPhase !== "finishing"
										) {
											currentPhase = "writing";
										} else if (
											phase === "rating" &&
											currentPhase !== "rating" &&
											currentPhase !== "finishing"
										) {
											currentPhase = "rating";
										} else if (phase === "finishing") {
											currentPhase = "finishing";
										}
									}
									push(evt);
								}
							} else if (EXPLORATION_TOOLS.has(tool)) {
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
								const description = buildExplorationDescription(tool, input);
								push({ type: "exploration", data: { tool, description } });
							}
						}

						// ── Token usage from result frame ───────────────────────────
						if (frame.type === "result" && frame.usage) {
							const u = frame.usage;
							tokenUsage = {
								inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
								outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
								cacheReadInputTokens:
									u.cacheReadInputTokens ?? u.cache_read_input_tokens ?? 0,
								cacheCreationInputTokens:
									u.cacheCreationInputTokens ?? u.cache_creation_input_tokens ?? 0,
							};
						}
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				debug("walkthrough-opencode-mcp", "stdout read error:", message);
				// Swallow errors triggered by caller-initiated cancellation — the
				// registry (or Scope finalizer) is already aware and will tear down
				// the job; surfacing a spurious "AiGenerationError" would race the
				// real "interrupted" signal.
				if (!killed && !cancelledByCaller) {
					errorEmitted = true;
					push({ type: "error", data: { code: "AiGenerationError", message } });
				}
			} finally {
				clearTimeout(timeoutId);
				if (externalAbort) {
					externalAbort.signal.removeEventListener("abort", onExternalAbort);
				}
				try {
					proc.kill();
				} catch {
					/* already dead */
				}
			}

			await proc.exited;
			await stderrPromise;

			if (killed && !cancelledByCaller) {
				errorEmitted = true;
				push({
					type: "error",
					data: {
						code: "AiGenerationError",
						message: "Walkthrough generation timed out after 10 minutes",
					},
				});
			}

			debug(
				"walkthrough-opencode-mcp",
				"opencode exited. Blocks emitted:",
				state.blockCount,
			);

			return tokenUsage;
		},
	).catch((err: unknown): WalkthroughTokenUsage => {
		const message = err instanceof Error ? err.message : String(err);
		debug("walkthrough-opencode-mcp", "queryTask error:", message);
		errorEmitted = true;
		push({ type: "error", data: { code: "AiGenerationError", message } });
		return {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		};
	});

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

		if (state.summarySet) {
			yield {
				type: "done" as const,
				data: { walkthroughId: "", tokenUsage },
			};
		} else if (!errorEmitted) {
			debug(
				"walkthrough-opencode-mcp",
				"opencode completed without producing a summary — emitting fallback error",
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
