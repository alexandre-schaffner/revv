// ─── Recap agent runner ──────────────────────────────────────────────────────
//
// Thin adapter for recap generation over the ACP transport (CLAUDE.md
// invariant #13). The single transport is `recap-acp.ts`, which routes all tool
// handling through the HTTP MCP route at `/mcp/recap` (see `routes/mcp/recap.ts`)
// running the shared handlers in
// `apps/server/src/ai/providers/recap-tools/handlers.ts`. This replaces the
// bespoke Claude-SDK / opencode / codex recap drivers — exactly as
// `walkthrough-acp.ts` / `chat-acp.ts` replaced their feature's bespoke drivers.
//
// Pipeline shape (structured pipeline; no text buffer):
//
//   get_recap_state → [get_repo_context, list_open_prs?] → set_lede →
//   add_pr_entry × N → complete_recap.
//
// All content flows through tool arguments. Visible assistant text is
// discarded — the prompt instructs the agent not to emit any. Live UI
// updates come from per-handler SSE emissions (`lede`, `entry`, `phase`).

import type {
  AcpAgentId,
  ContextWindow,
  ProjectRecap,
  RecapStreamEvent,
  ThinkingEffort,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { type RecapAcpSessionDeps, runRecapAgentViaAcp } from "../ai/providers/recap-acp";
import {
  completeRecapHandler,
  type RecapSourceBundle,
  type RecapSourcePrDiff,
  type RecapToolContext,
} from "../ai/providers/recap-tools";
import type { Db } from "../db";
import { projectRecaps, recapPrEntries } from "../db/schema/index";
import { debug } from "../logger";

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
  /** Resolved ACP registry agent id that drives this recap run. */
  readonly acpAgentId: AcpAgentId;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  readonly contextWindow?: ContextWindow | undefined;
  /**
   * Server-side working directory the ACP connection is pooled under. Recap
   * doesn't run against a worktree the way walkthrough does; the repo's clone
   * path (or the server cwd as fallback) is enough.
   */
  readonly repoWorkingDir: string;
  /**
   * Session-token callbacks (in-memory map on `ProjectRecapJobs`). The
   * HTTP-MCP route authenticates incoming tool calls against this map.
   */
  readonly sessionDeps: RecapAcpSessionDeps;
  readonly onCompleted: () => void;
  /**
   * Lazy diff loader wired by the orchestrator. Called by the `get_pr_diff`
   * MCP handler to fetch a single PR's diff on demand.
   */
  readonly getPrDiff: (prId: string) => Promise<RecapSourcePrDiff | null>;
  /**
   * Stream emitter for live recap generation. Called by MCP tool handlers
   * so the SSE endpoint can forward `lede` / `entry` / `phase` events to
   * subscribers. Visible assistant text is discarded.
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

  const outcome = await runRecapAgentViaAcp({
    ctx,
    acpAgentId: params.acpAgentId,
    modelUsed: params.modelUsed,
    thinkingEffort: params.thinkingEffort,
    contextWindow: params.contextWindow,
    workingDir: params.repoWorkingDir,
    abortController: params.abortController,
    sessionDeps: params.sessionDeps,
  });
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
