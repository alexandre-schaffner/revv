// ── prompt-once ─────────────────────────────────────────────────────────────
//
// One throwaway ACP turn with no MCP servers: a fresh session, one prompt,
// the agent's visible text back. For small labelling jobs (chat starter
// prompts, stack headlines) that never touch the agent pipelines' tool
// surface. The session id is never surfaced or resumed into.

import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { getAcpConnection } from "../acp/acp-connection";
import { decodeAcpSessionUpdate, makeAcpDecodeState, withAgentTurn } from "../agent-stream";

export interface PromptOnceInput {
  readonly cwd: string;
  readonly agent: AcpAgentId;
  readonly model: string;
  readonly effort?: ThinkingEffort | undefined;
  readonly timeoutMs: number;
  /** System prompt and user message in one: ACP has no separate system channel. */
  readonly text: string;
  readonly debugLabel: string;
}

/** The agent's text deltas for one prompt, concatenated. Throws on any failure. */
export async function promptOnce(input: PromptOnceInput): Promise<string> {
  const h = await getAcpConnection(input.cwd, input.agent, {
    model: input.model,
    thinkingEffort: input.effort,
  });

  let sessionId: string | null = null;
  let collected = "";
  try {
    await withAgentTurn<void>({
      hardTimeoutMs: input.timeoutMs,
      jobStarted: async () => {
        h.jobStarted();
      },
      jobEnded: async () => {
        h.jobEnded();
      },
      debugLabel: input.debugLabel,
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async () => {
        // No MCP servers: the agent has only its built-in tools, and the
        // prompt tells it to just read and answer.
        const created = await h.newSession([]);
        sessionId = created.sessionId;
        const decodeState = makeAcpDecodeState();
        h.setListener(sessionId, (update) => {
          for (const ev of decodeAcpSessionUpdate(update, decodeState)) {
            if (ev.kind === "text-delta") collected += ev.data;
          }
        });
        await h.prompt(sessionId, [{ type: "text", text: input.text }]);
      },
    });
  } finally {
    if (sessionId) h.setListener(sessionId, null);
  }
  return collected;
}
