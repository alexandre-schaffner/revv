// A durable job whose agent turn produces nothing but MCP writes — a project
// recap, a stack brief — judged by its pipeline's completion gate. Each
// pipeline keeps its own tool context and journal; launching the agent, the
// gate's signals and the verdict live here, so they change in one place.

import { Cause, Effect } from "effect";
import { type AgentLaunch, resolveAgentLaunch } from "../../ai/acp/agent-launch";
import { isAgentLaunchable } from "../../ai/acp/launch";
import type { McpAgentAcpResult } from "../../ai/providers/mcp-agent-acp";
import type { SettingsService } from "../Settings";
import { type AgentRun, MAX_RESUME_ATTEMPTS, type RunEnd } from "./agent-jobs";

/** A run's record of its agent against the completion gate. */
export interface ToolGate {
  /** Set by the MCP route on any tool call: ACP shows tool calls only by title. */
  calledAnyTool: boolean;
  /** Set when the completion gate passed. */
  validated: boolean;
  modelUsed: string | null;
}

export const newToolGate = (): ToolGate => ({
  calledAnyTool: false,
  validated: false,
  modelUsed: null,
});

/**
 * The tool context's hooks into the gate. The gate passing ends the agent's
 * turn: nothing it writes after that is part of the result.
 */
export function toolGateHooks(
  gate: ToolGate,
  abort: AbortController,
): { readonly onToolCall: () => void; readonly onCompleted: () => void } {
  return {
    onToolCall: () => {
      gate.calledAnyTool = true;
    },
    onCompleted: () => {
      gate.validated = true;
      if (!abort.signal.aborted) abort.abort(new Error("Completion gate passed"));
    },
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
 * can't be launched here fails the run without a turn.
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
    readonly isValidated: () => boolean;
  }) => Promise<McpAgentAcpResult>;
  /** The failure when the agent stopped before the gate passed. */
  readonly unfinished: string;
}): Effect.Effect<RunEnd<string>, never, SettingsService> {
  return Effect.gen(function* () {
    const { run } = input;
    const launch = yield* resolveAgentLaunch(input.purpose);
    if (!isAgentLaunchable(launch.agent)) {
      return {
        kind: "failed",
        failure: `The configured agent ('${launch.agent}') is not available on this machine.`,
      };
    }
    run.context.modelUsed = launch.model;
    const outcome = yield* Effect.promise(() =>
      input.turn({
        launch,
        workingDir: input.clonePath ?? process.cwd(),
        calledAnyTool: () => run.context.calledAnyTool,
        isValidated: () => run.context.validated,
      }),
    );
    return { kind: "journal", failure: outcome.error ?? input.unfinished };
  });
}
