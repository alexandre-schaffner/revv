// ── Agent check ──────────────────────────────────────────────────────────────
//
// Settings' "Test agent" button. It runs one real, tiny turn through the same
// ACP transport walkthroughs use, from the server, with the configured review
// model. A green result from anything weaker misled users: the previous check
// ran the user's own `claude auth status`, a different binary in a different
// directory from the agent subprocess, and reported "can read your login"
// while every walkthrough failed. Only a real turn proves the agent can start,
// authenticate, reach the model, and answer.

import type { AcpAgentId, AgentCheckResult } from "@revv/shared";
import { agentFailureGuidance } from "../acp/agent-keychain";
import { promptOnce } from "./prompt-once";

/** Covers a cold `npx` adapter install plus the turn itself. */
const CHECK_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 60_000;
const CHECK_PROMPT = "This is a connectivity check from Revv. Reply with the single word OK.";

export interface AgentCheckInput {
  readonly agent: AcpAgentId;
  readonly model: string;
  readonly cwd: string;
}

/** The turn under test; a seam so tests don't spawn a real agent. */
export type RunCheckTurn = (input: AgentCheckInput) => Promise<unknown>;

const runRealTurn: RunCheckTurn = (input) =>
  promptOnce({
    cwd: input.cwd,
    agent: input.agent,
    model: input.model,
    effort: "low",
    timeoutMs: TURN_TIMEOUT_MS,
    text: CHECK_PROMPT,
    debugLabel: "agent-check",
  });

export async function checkAgent(
  input: AgentCheckInput,
  runTurn: RunCheckTurn = runRealTurn,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<AgentCheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The agent didn't answer within ${timeoutMs / 1000} seconds.`)),
      timeoutMs,
    );
  });
  try {
    // Any answer passes: the point is that a turn completed, not what it said.
    await Promise.race([runTurn(input), timeout]);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, guidance: agentFailureGuidance(input.agent, error) };
  } finally {
    clearTimeout(timer);
  }
}
