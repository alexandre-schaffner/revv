// ─── Recap agent runner ──────────────────────────────────────────────────────
//
// Thin Claude Agent SDK adapter for recap generation. Mirrors the structure
// of `mcp-walkthrough.ts` but radically simpler:
//
//   • Single agent turn (≈ 4 tool calls total: get_recap_state →
//     get_repo_context → set_recap_overview → complete_recap).
//   • No streaming UI — content writes commit via MCP handlers; the
//     orchestrator observes `complete_recap` via the `onCompleted` hook in
//     the tool context.
//   • Opencode parity (CLAUDE.md invariant #13) is deferred — when the user
//     has `aiAgent='opencode'` selected, we return an explicit error
//     instead of running. Re-add opencode by adding an HTTP-MCP route at
//     `/mcp/recap` and a sibling driver here.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRecap } from "@revv/shared";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../ai/prompts/recap";
import { resolveCliBin } from "../ai/providers/cli-agent";
import {
  createRecapMcpServer,
  RECAP_ALLOWED_TOOLS,
  RECAP_MCP_SERVER,
  type RecapSourceBundle,
} from "../ai/providers/recap-tools";
import type { Db } from "../db";
import { debug, logError } from "../logger";

export interface RecapAgentResult {
  /** True when `complete_recap` returned success during this run. */
  readonly validatedComplete: boolean;
  readonly modelUsed: string;
  readonly tokenUsage?: Record<string, number>;
}

export interface RunRecapAgentParams {
  readonly db: Db;
  readonly recapId: string;
  readonly sourceBundle: RecapSourceBundle;
  readonly priorRecaps: ReadonlyArray<ProjectRecap>;
  readonly abortController: AbortController;
  readonly modelUsed: string;
  readonly aiAgent: string;
  readonly aiMaxTurns: number;
  readonly onCompleted: () => void;
}

/**
 * One-shot recap agent invocation. Returns when the Claude Agent SDK
 * query iterator drains or the abort signal fires. The caller observes
 * `validatedComplete` from the orchestrator-supplied flag (the MCP
 * `complete_recap` handler sets it via the `onCompleted` callback in the
 * tool context).
 *
 * Throws on configuration errors (e.g. opencode selected) so the
 * orchestrator can mark the row 'error' with a clean diagnostic.
 */
export async function runRecapAgent(params: RunRecapAgentParams): Promise<RecapAgentResult> {
  // Opencode parity isn't wired yet. Surface this loud and clear so the
  // orchestrator marks the row error and the UI shows something
  // actionable instead of an opaque stall.
  if (params.aiAgent !== "claude") {
    throw new Error(
      `Recap generation requires the Claude agent — current setting is '${params.aiAgent}'. Switch agents in Settings and try again, or wait for opencode recap support.`,
    );
  }

  let validatedComplete = false;
  const onCompletedWrapper = (): void => {
    validatedComplete = true;
    params.onCompleted();
  };

  const mcpServer = createRecapMcpServer({
    db: params.db,
    recapId: params.recapId,
    sourceBundle: params.sourceBundle,
    priorRecaps: params.priorRecaps,
    onCompleted: onCompletedWrapper,
  });

  const userMessage = buildRecapUserMessage(params.sourceBundle, params.priorRecaps);
  const pinnedClaude = resolveCliBin("claude");
  const pathOption = pinnedClaude !== "claude" ? { pathToClaudeCodeExecutable: pinnedClaude } : {};

  // 10-minute soft cap. Recaps are bounded — if the agent isn't done in
  // 10 minutes something is wrong and we should give up rather than
  // letting the fiber hold its semaphore permit forever.
  const timeoutId = setTimeout(
    () => {
      try {
        params.abortController.abort(new Error("Recap generation timed out after 10 minutes"));
      } catch {
        /* already aborted */
      }
    },
    10 * 60 * 1000,
  );

  let tokenUsage: Record<string, number> | undefined;

  try {
    debug("recap-agent-runner", "starting Claude query for recap", params.recapId);

    const iter = query({
      prompt: userMessage,
      options: {
        systemPrompt: RECAP_SYSTEM_PROMPT,
        // No filesystem tools — the agent reads everything via MCP.
        tools: [],
        allowedTools: RECAP_ALLOWED_TOOLS,
        mcpServers: { [RECAP_MCP_SERVER]: mcpServer },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        maxTurns: params.aiMaxTurns,
        abortController: params.abortController,
        model: params.modelUsed,
        ...pathOption,
      },
    });

    for await (const msg of iter) {
      // Drain the iterator. Content writes happen in MCP tool handlers,
      // so the runner just needs to keep the stream consumed until end.
      const m = msg as { type?: string; usage?: Record<string, number> };
      if (m.type === "result" && m.usage) {
        tokenUsage = m.usage;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (params.abortController.signal.aborted) {
      debug("recap-agent-runner", "recap aborted:", message);
    } else {
      logError("recap-agent-runner", `recap ${params.recapId} failed:`, message);
    }
    // Fall through — caller checks validatedComplete.
  } finally {
    clearTimeout(timeoutId);
  }

  const result: RecapAgentResult = {
    validatedComplete,
    modelUsed: params.modelUsed,
  };
  if (tokenUsage) (result as { tokenUsage?: Record<string, number> }).tokenUsage = tokenUsage;
  return result;
}
