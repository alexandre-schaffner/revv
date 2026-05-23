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
// `effectiveAgent` param.
//
// Pipeline shape on either path (structured pipeline; no text buffer):
//
//   get_recap_state → [get_repo_context, list_open_prs?] → set_lede →
//   add_pr_entry × N → complete_recap.
//
// All content flows through tool arguments. Visible assistant text is
// discarded — the prompt instructs the agent not to emit any. Live UI
// updates come from per-handler SSE emissions (`lede`, `entry`, `phase`).

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRecap, RecapStreamEvent } from "@revv/shared";
import { eq } from "drizzle-orm";
import { walkClaudeMessages } from "../ai/agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../ai/prompts/recap";
import { resolveCliBin } from "../ai/providers/cli-agent";
import { buildRecapActivity, normalizeRecapToolName } from "../ai/providers/recap-activity";
import {
  type RecapOpencodeSessionDeps,
  type RecapOpencodeSupervisorDeps,
  runRecapAgentViaOpencode,
} from "../ai/providers/recap-opencode";
import {
  completeRecapHandler,
  createRecapMcpServer,
  RECAP_ALLOWED_TOOLS,
  RECAP_MCP_SERVER,
  type RecapSourceBundle,
  type RecapSourcePrDiff,
  type RecapToolContext,
} from "../ai/providers/recap-tools";
import type { Db } from "../db";
import { projectRecaps, recapPrEntries } from "../db/schema/index";
import { debug, logError } from "../logger";
import type { CliAgent } from "./Ai";

export interface RecapAgentResult {
  /** True when `complete_recap` returned success during this run. */
  readonly validatedComplete: boolean;
  readonly modelUsed: string;
  readonly tokenUsage?: Record<string, number>;
  /** Error message from the agent runner (e.g. model doesn't support tools). */
  readonly errorMessage?: string;
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
  /**
   * Lazy diff loader wired by the orchestrator. Called by the `get_pr_diff`
   * MCP handler to fetch a single PR's diff on demand.
   */
  readonly getPrDiff: (prId: string) => Promise<RecapSourcePrDiff | null>;
  /**
   * Stream emitter for live recap generation. Called by MCP tool handlers
   * so the SSE endpoint can forward `lede` / `entry` / `phase` events to
   * subscribers. The runner itself emits `activity` events on each tool
   * call; visible assistant text is discarded.
   */
  readonly emitEvent: (event: RecapStreamEvent) => void;
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
  const toolCalls = new Set<string>();
  const onCompletedWrapper = (): void => {
    validatedComplete = true;
    params.onCompleted();
    if (!params.abortController.signal.aborted) {
      params.abortController.abort(new Error("Recap completed"));
    }
  };

  const ctx: RecapToolContext = {
    db: params.db,
    recapId: params.recapId,
    sourceBundle: params.sourceBundle,
    priorRecaps: params.priorRecaps,
    onCompleted: onCompletedWrapper,
    getPrDiff: params.getPrDiff,
    emit: params.emitEvent,
    toolCalls,
  };

  const outcome =
    params.effectiveAgent === "opencode"
      ? await runViaOpencode(params, ctx)
      : await runViaClaude(params, ctx);
  let errorMessage = outcome.error;

  if (!validatedComplete) {
    const recovered = await recoverMissedFinalToolCall(ctx, outcome.error);
    if (recovered.recovered) {
      validatedComplete = true;
    } else if (recovered.error && !outcome.error) {
      errorMessage = recovered.error;
    }
  }

  return {
    validatedComplete,
    modelUsed: params.modelUsed,
    ...(outcome.tokenUsage ? { tokenUsage: outcome.tokenUsage } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

interface RecoveryResult {
  readonly recovered: boolean;
  readonly error?: string;
}

/**
 * Narrow recovery for "agent did the work but never said complete_recap". If
 * the DB shows a non-empty lede + ≥1 entry, treat that as good enough and run
 * the validation gate manually so the orchestrator can transition status.
 *
 * No fallback fabrication: if the agent never wrote a lede or never wrote any
 * entries, we refuse to recover — the run is a genuine failure.
 */
async function recoverMissedFinalToolCall(
  ctx: RecapToolContext,
  existingError: string | undefined,
): Promise<RecoveryResult> {
  if (!ctx.toolCalls?.has("get_recap_state")) {
    return { recovered: false };
  }

  const row = ctx.db
    .select({ lede: projectRecaps.lede })
    .from(projectRecaps)
    .where(eq(projectRecaps.id, ctx.recapId))
    .get();
  const entries = ctx.db
    .select({ id: recapPrEntries.id })
    .from(recapPrEntries)
    .where(eq(recapPrEntries.recapId, ctx.recapId))
    .all();
  const hasLede = (row?.lede ?? "").trim().length > 0;
  const hasEntries = entries.length > 0;
  if (!hasLede || !hasEntries) {
    return { recovered: false };
  }

  debug(
    "recap-agent-runner",
    `recovering recap ${ctx.recapId}: validating after missed complete_recap`,
  );
  const complete = await completeRecapHandler(ctx, {});
  if (complete.isError) {
    const error = firstToolText(complete) ?? existingError;
    return error ? { recovered: false, error } : { recovered: false };
  }
  return { recovered: true };
}

function firstToolText(result: {
  content: Array<{ type: "text"; text: string }>;
}): string | undefined {
  return result.content[0]?.text;
}

// ── Claude SDK path ──────────────────────────────────────────────────────────

interface RunOutcome {
  readonly tokenUsage?: Record<string, number>;
  readonly error?: string;
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

    // Walk the SDK message stream. Content flows through tool args; the
    // runner forwards each tool call as an `activity` event and discards
    // visible assistant text (the system prompt instructs the model not to
    // emit any between tool calls). Reasoning deltas surface as `thought`
    // events for debug visibility — the UI shows them in a collapsible.
    const usage = await walkClaudeMessages(iter, (ev) => {
      if (ev.kind === "reasoning-delta") {
        if (ev.data.length === 0) return;
        ctx.emit({ type: "thought", data: { text: ev.data } });
        return;
      }
      if (ev.kind === "tool-call") {
        const toolName = normalizeRecapToolName(ev.bareName);
        ctx.emit({ type: "activity", data: buildRecapActivity(toolName, ev.input) });
        return;
      }
      // text-delta / task-list-update / subagent-* / error / etc. → ignored
    });
    if (usage) {
      tokenUsage = {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadInputTokens,
        cache_creation_input_tokens: usage.cacheCreationInputTokens,
      };
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
    return { error: result.error };
  }

  return result.tokenUsage ? { tokenUsage: result.tokenUsage } : {};
}
