// ─── Recap agent runner ──────────────────────────────────────────────────────
//
// Thin agent-SDK adapter for recap generation. Two transports, byte-identical
// behaviour (CLAUDE.md invariant #13):
//
//   • Claude Agent SDK — in-process MCP via `createSdkMcpServer`.
//   • Opencode daemon  — HTTP MCP route at `/mcp/recap` (see
//                        `recap-opencode.ts` + `routes/mcp/recap.ts`).
//
// Both paths run the same shared handlers in
// `apps/server/src/ai/providers/recap-tools/handlers.ts`. The orchestrator
// (`ProjectRecapJobs`) decides which transport to use via the
// `effectiveAgent` param, which it resolves from settings through
// `resolveRecapAgent` (per-feature `recap.agent` override with `'auto'`
// inheriting the global `aiAgent`).
//
// Pipeline shape on either path:
//
//   ≈ 4 tool calls total: get_recap_state → get_repo_context →
//     set_recap_overview → complete_recap.
//
// No streaming UI — content writes commit via MCP handlers; the
// orchestrator observes `complete_recap` via the `onCompleted` hook on the
// `RecapToolContext` it passes in.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRecap } from "@revv/shared";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../ai/prompts/recap";
import { resolveCliBin } from "../ai/providers/cli-agent";
import {
  type RecapOpencodeSessionDeps,
  type RecapOpencodeSupervisorDeps,
  runRecapAgentViaOpencode,
} from "../ai/providers/recap-opencode";
import {
  createRecapMcpServer,
  RECAP_ALLOWED_TOOLS,
  RECAP_MCP_SERVER,
  type RecapSourceBundle,
  type RecapToolContext,
} from "../ai/providers/recap-tools";
import type { Db } from "../db";
import { debug, logError } from "../logger";
import type { CliAgent } from "./Ai";

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
  /**
   * Resolved agent choice for THIS recap run. The orchestrator computes this
   * via `resolveRecapAgent(settings)` and threads it in — keeps this module
   * decoupled from `SettingsService`.
   */
  readonly effectiveAgent: CliAgent;
  readonly aiMaxTurns: number;
  /**
   * Server-side working directory passed to opencode's `session.create`.
   * Recap doesn't run against a worktree the way walkthrough does, but the
   * daemon requires a directory; supplying the repo's clone path (or the
   * server cwd as fallback) is enough. Required only when
   * `effectiveAgent === 'opencode'`.
   */
  readonly repoWorkingDir?: string;
  /**
   * Supervisor callbacks for the opencode path. Required only when
   * `effectiveAgent === 'opencode'`; ignored on the Claude path.
   */
  readonly supervisorDeps?: RecapOpencodeSupervisorDeps;
  /**
   * Session-token callbacks (in-memory map on `ProjectRecapJobs`). The
   * opencode HTTP-MCP route authenticates incoming tool calls against
   * this map.
   */
  readonly sessionDeps?: RecapOpencodeSessionDeps;
  readonly onCompleted: () => void;
}

/**
 * One-shot recap agent invocation. Returns when the agent's stream drains
 * or the abort signal fires. `validatedComplete` reflects whether
 * `complete_recap` was called successfully during the run (the MCP handler
 * fires the `onCompleted` callback on the tool context, which the caller
 * wires to flip a flag).
 */
export async function runRecapAgent(params: RunRecapAgentParams): Promise<RecapAgentResult> {
  let validatedComplete = false;
  const onCompletedWrapper = (): void => {
    validatedComplete = true;
    params.onCompleted();
  };

  const ctx: RecapToolContext = {
    db: params.db,
    recapId: params.recapId,
    sourceBundle: params.sourceBundle,
    priorRecaps: params.priorRecaps,
    onCompleted: onCompletedWrapper,
  };

  if (params.effectiveAgent === "opencode") {
    return runViaOpencode(params, ctx).then((r) => ({
      validatedComplete,
      modelUsed: params.modelUsed,
      ...(r.tokenUsage ? { tokenUsage: r.tokenUsage } : {}),
    }));
  }

  return runViaClaude(params, ctx).then((r) => ({
    validatedComplete,
    modelUsed: params.modelUsed,
    ...(r.tokenUsage ? { tokenUsage: r.tokenUsage } : {}),
  }));
}

// ── Claude SDK path ──────────────────────────────────────────────────────────

interface RunOutcome {
  readonly tokenUsage?: Record<string, number>;
}

async function runViaClaude(
  params: RunRecapAgentParams,
  ctx: RecapToolContext,
): Promise<RunOutcome> {
  const mcpServer = createRecapMcpServer(ctx);
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
  } finally {
    clearTimeout(timeoutId);
  }

  return tokenUsage ? { tokenUsage } : {};
}

// ── Opencode path ────────────────────────────────────────────────────────────

async function runViaOpencode(
  params: RunRecapAgentParams,
  ctx: RecapToolContext,
): Promise<RunOutcome> {
  if (!params.supervisorDeps || !params.sessionDeps) {
    throw new Error(
      "Recap opencode path requires supervisorDeps and sessionDeps — orchestrator must wire them",
    );
  }
  if (!params.repoWorkingDir) {
    throw new Error("Recap opencode path requires repoWorkingDir — orchestrator must wire it");
  }

  debug("recap-agent-runner", "starting opencode run for recap", params.recapId);

  const result = await runRecapAgentViaOpencode({
    ctx,
    modelUsed: params.modelUsed,
    workingDir: params.repoWorkingDir,
    abortController: params.abortController,
    supervisorDeps: params.supervisorDeps,
    sessionDeps: params.sessionDeps,
  });

  if (result.error) {
    logError("recap-agent-runner", `opencode recap ${params.recapId} failed:`, result.error);
  }

  return result.tokenUsage ? { tokenUsage: result.tokenUsage } : {};
}
