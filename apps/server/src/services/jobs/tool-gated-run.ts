// A durable job whose agent turn produces nothing but MCP writes — a project
// recap, a stack brief — judged by its pipeline's completion gate. Each
// pipeline keeps its own tool context and journal; launching the agent, the
// gate's signals and the verdict live here, so they change in one place.

import { Cause, Effect } from "effect";
import { type AgentLaunch, resolveAgentLaunch } from "../../ai/acp/agent-launch";
import { makeTurnSettle, type TurnSettle } from "../../ai/acp/run-turn";
import type { McpAgentRunError } from "../../ai/providers/mcp-agent-acp";
import type { SettingsService } from "../Settings";
import { type AgentRun, MAX_RESUME_ATTEMPTS, type RunEnd } from "./agent-jobs";

/** A run's record of its agent against the completion gate. */
export interface ToolGate {
  /** Set by the MCP route on any tool call: ACP shows tool calls only by title. */
  calledAnyTool: boolean;
  /** Settled when the completion gate passed. */
  readonly completion: TurnSettle;
  modelUsed: string | null;
}

export const newToolGate = (): ToolGate => ({
  calledAnyTool: false,
  completion: makeTurnSettle(),
  modelUsed: null,
});

/**
 * The tool context's hooks into the gate. The gate passing settles the
 * agent's turn: the session is cancelled (nothing it writes after that is part
 * of the result), but the turn ends as `settled`, never as an abort, so the
 * shared agent connection is kept.
 */
export function toolGateHooks(gate: ToolGate): {
  readonly onToolCall: () => void;
  readonly onCompleted: () => void;
} {
  return {
    onToolCall: () => {
      gate.calledAnyTool = true;
    },
    onCompleted: gate.completion.settle,
  };
}

/** The failure texts every tool-gated pipeline records for a crash and an exhausted resume budget. */
export const TOOL_GATED_FAILURES = {
  crashed: (cause: Cause.Cause<unknown>): string =>
    `Generation failed unexpectedly: ${Cause.pretty(cause).slice(0, 200)}`,
  resumeExhausted: `Exceeded max resume attempts (${MAX_RESUME_ATTEMPTS}) after repeated crashes`,
};

/**
 * Launch the configured agent for `purpose` in the repository's clone and run
 * its one turn; the journal's completion check is the verdict. An agent that
 * can't be launched here ends the turn as `not_configured` at connect.
 */
export function runToolGatedTurn<C extends ToolGate>(input: {
  readonly run: AgentRun<C>;
  readonly purpose: "recap" | "brief";
  /** The repository's clone; the server's directory when it has none. */
  readonly clonePath: string | null;
  readonly turn: (agent: {
    readonly launch: AgentLaunch;
    readonly workingDir: string;
    readonly calledAnyTool: () => boolean;
    readonly completion: TurnSettle;
  }) => Promise<McpAgentRunError>;
  /** The failure when the agent stopped before the gate passed. */
  readonly unfinished: string;
}): Effect.Effect<RunEnd<string>, never, SettingsService> {
  return Effect.gen(function* () {
    const { run } = input;
    const launch = yield* resolveAgentLaunch(input.purpose);
    run.context.modelUsed = launch.model;
    const error = yield* Effect.promise(() =>
      input.turn({
        launch,
        workingDir: input.clonePath ?? process.cwd(),
        calledAnyTool: () => run.context.calledAnyTool,
        completion: run.context.completion,
      }),
    );
    return { kind: "journal", failure: error?.message ?? input.unfinished };
  });
}
