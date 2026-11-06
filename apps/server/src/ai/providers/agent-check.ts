// Settings' "Test agent" button. It runs one real, tiny turn through the same
// ACP transport walkthroughs use, from the server, with the configured review
// model. Anything weaker (e.g. the user's own `claude auth status`, a different
// binary in a different directory) can report green while every walkthrough
// fails: only a real turn proves the agent can start, authenticate, reach the
// model, and answer.

import type { AgentCheckResult } from "@revv/shared";
import { AgentTurnError, agentFailureGuidance } from "../acp/agent-failure";
import type { AgentLaunch } from "../acp/agent-launch";
import { promptOnce } from "../acp/run-turn";

/** Covers a cold `npx` adapter install plus the turn itself. */
const CHECK_CEILING_MS = 120_000;
const CHECK_PROMPT = "This is a connectivity check from Revv. Reply with the single word OK.";

/** The turn under test; a seam so tests don't spawn a real agent. */
export type RunCheckTurn = (launch: AgentLaunch) => Promise<unknown>;

const runRealTurn: RunCheckTurn = (launch) =>
  promptOnce({ label: "agent-check", launch, ceilingMs: CHECK_CEILING_MS, text: CHECK_PROMPT });

export async function checkAgent(
  launch: AgentLaunch,
  runTurn: RunCheckTurn = runRealTurn,
): Promise<AgentCheckResult> {
  try {
    // Any answer passes: the point is that a turn completed, not what it said.
    await runTurn(launch);
    return { ok: true };
  } catch (err) {
    if (err instanceof AgentTurnError) {
      return { ok: false, error: err.agentMessage, guidance: err.guidance };
    }
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, guidance: agentFailureGuidance(launch.agent, error) };
  }
}
