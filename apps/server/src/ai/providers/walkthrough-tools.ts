import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { RatingAxis, WalkthroughStreamEvent } from "@revv/shared";
import {
	TOOL_SPECS,
	type WalkthroughToolState,
	createInitialState,
} from "./walkthrough-tool-spec";

// ── Emitter interface ────────────────────────────────────────────────────────

export interface WalkthroughEmitter {
	emit: (event: WalkthroughStreamEvent) => void;
	state: WalkthroughToolState;
}

// ── MCP server factory ──────────────────────────────────────────────────────

export function createWalkthroughMcpServer(
	emitter: WalkthroughEmitter,
	initialState?: {
		summarySet: boolean;
		blockCount: number;
		issueCount: number;
		writingPhaseEmitted?: boolean;
		ratedAxes?: RatingAxis[];
	},
) {
	// Merge initial state if provided (used for continuation/resume). Re-seeding
	// ratedAxes is load-bearing: without it, resume would let the model re-rate
	// axes whose rows already exist, which the persistence layer now handles
	// idempotently but the completeness check would otherwise accept as "new".
	if (initialState) {
		emitter.state.summarySet = initialState.summarySet;
		emitter.state.blockCount = initialState.blockCount;
		emitter.state.issueCount = initialState.issueCount;
		if (initialState.writingPhaseEmitted !== undefined) emitter.state.writingPhaseEmitted = initialState.writingPhaseEmitted;
		if (initialState.ratedAxes) {
			for (const axis of initialState.ratedAxes) emitter.state.ratedAxes.add(axis);
		}
	}

	return createSdkMcpServer({
		name: "revv-walkthrough",
		version: "1.0.0",
		tools: TOOL_SPECS.map((spec) =>
			tool(
				spec.name,
				spec.description,
				spec.inputSchema.shape,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				async (args: any) => spec.handler(args, emitter.state, emitter.emit),
			),
		),
	});
}

/** Create a fresh WalkthroughEmitter with zeroed state. */
export function createWalkthroughEmitter(
	emit: (event: WalkthroughStreamEvent) => void,
): WalkthroughEmitter {
	return { emit, state: createInitialState() };
}
