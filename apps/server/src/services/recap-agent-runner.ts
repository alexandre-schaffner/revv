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
//     commit_recap_overview → complete_recap. The model emits the recap
//     markdown ONCE — as visible assistant text. The orchestrator's
//     stream consumer (Claude SDK walker / opencode SSE subscriber)
//     fans every `text-delta` out to UI subscribers as a `chunk` event
//     AND appends to `ctx.textBuffer.current`; `commit_recap_overview`'s
//     handler reads the buffer for the markdown body. Single emission,
//     dual consumption — see plan
//     /Users/alex/.claude/plans/i-want-the-recap-wild-kite.md.
//
// Live UI streaming via best-effort `chunk` events; durability via the
// atomic `commit_recap_overview` MCP write. The orchestrator observes
// `complete_recap` via the `onCompleted` hook on the `RecapToolContext`
// it passes in.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectRecap, RecapStreamEvent } from "@revv/shared";
import { walkClaudeMessages } from "../ai/agent-stream";
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
  type RecapSourcePrDiff,
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
   * so the SSE endpoint can forward chunks to subscribers, and by this
   * runner's own stream consumer to forward every `text-delta` as a
   * `chunk` event.
   */
  readonly emitEvent: (event: RecapStreamEvent) => void;
  /**
   * Mutable closure cell the orchestrator hands in so it can later read
   * the agent's currently-buffered visible text (used by the SSE route's
   * reconnect snapshot). The runner appends text-deltas to `.current`
   * and resets on each non-commit tool-call boundary; the
   * `commit_recap_overview` MCP handler reads `.current` for the durable
   * markdown body.
   */
  readonly textBuffer: { current: string };
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
    getPrDiff: params.getPrDiff,
    emit: params.emitEvent,
    textBuffer: params.textBuffer,
  };

  const outcome =
    params.effectiveAgent === "opencode"
      ? await runViaOpencode(params, ctx)
      : await runViaClaude(params, ctx);

  return {
    validatedComplete,
    modelUsed: params.modelUsed,
    ...(outcome.tokenUsage ? { tokenUsage: outcome.tokenUsage } : {}),
    ...(outcome.error ? { errorMessage: outcome.error } : {}),
  };
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
        // Surface `stream_event` messages so the walker emits per-token
        // `text-delta` events. The recap composition lives in those
        // deltas — we accumulate them into `ctx.textBuffer.current`
        // (the durable source for `commit_recap_overview`) and fan
        // each one out as a `chunk` SSE event to UI subscribers.
        includePartialMessages: true,
        ...pathOption,
      },
    });

    // Walk the SDK message stream. Two side effects per text-delta:
    //   1. ctx.emit({type:"chunk", data:{text}})  → live UI (pre-commit only)
    //   2. ctx.textBuffer.current += text         → durable source for commit handler
    //
    // Buffer lifecycle:
    //   • Read tools (get_recap_state, list_open_prs, get_repo_context) reset
    //     the buffer so pre-composition prelude is discarded before the model
    //     starts writing the real recap. The reset is mirrored as `overview: ""`
    //     to the client so it wipes any streamed prelude text.
    //   • commit_recap_overview's handler reads the buffer, sanitizes it
    //     (strips preamble/suffix narration), writes to DB, then clears the
    //     buffer itself — so a second commit call only persists the new content.
    //   • After commit fires, chunk emission stops (`committed` flag). Any text
    //     the model generates in a second pass goes to the buffer (for a
    //     potential second commit) but is NOT streamed to the client, preventing
    //     the doubled-content visual in the streaming view.
    //   • complete_recap must not reset — it fires after composition and any
    //     reset here would blank the streaming view before the WS event arrives.
    let committed = false;
    const usage = await walkClaudeMessages(iter, (ev) => {
      if (ev.kind === "text-delta") {
        if (ev.data.length === 0) return;
        ctx.textBuffer.current += ev.data;
        // Stop streaming chunks after the first commit. The model sometimes
        // generates the recap a second time; without this guard those chunks
        // would append onto the clean committed content in the streaming view.
        if (!committed) {
          ctx.emit({ type: "chunk", data: { text: ev.data } });
        }
        return;
      }
      if (ev.kind === "tool-call") {
        if (ev.bareName === "commit_recap_overview") {
          committed = true;
          return;
        }
        if (ev.bareName === "complete_recap") {
          return;
        }
        // Only reset on pre-commit read/prelude tools. After commit, a stray
        // read tool must not wipe the committed content from the client view.
        if (!committed) {
          ctx.textBuffer.current = "";
          ctx.emit({ type: "overview", data: { overview: "" } });
        }
        return;
      }
      // reasoning-delta / task-list-update / subagent-* / error / etc. → ignored
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
