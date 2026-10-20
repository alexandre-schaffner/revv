// ─── recap-acp ───────────────────────────────────────────────────────────────
//
// ACP (Agent Client Protocol) driver for project-recap generation. This is the
// single transport that replaces the bespoke claude-SDK / opencode / codex recap
// drivers — exactly as `walkthrough-acp.ts` replaced the bespoke walkthrough
// drivers and `chat-acp.ts` replaced the bespoke chat drivers. It talks to
// whichever ACP agent is configured (see `ai/acp/presets.ts`) over the stdio
// JSON-RPC connection pooled per working directory (`ai/acp/acp-connection.ts`).
//
// Per CLAUDE.md invariant #13, all recap CONTENT (lede, entries, theme
// summaries) is written by the SHARED MCP tool handlers behind the HTTP route
// `/mcp/recap` — the same handlers the deleted opencode/codex drivers used. The
// agent's own ACP `session/update` stream supplies only reasoning (→ `thought`
// events + heartbeat) and best-effort tool-call pills; everything substantive
// reaches the UI via the per-handler `ctx.emit` SSE emissions and the DB.
//
// The session itself is driven by `mcp-agent-acp.ts`, shared with the stack
// brief; this file adds the recap prompt and the reasoning stream.

import type { AcpAgentId, RecapStreamEvent, ThinkingEffort } from "@revv/shared";
import { logError } from "../../logger";
import {
  decodeAcpSessionUpdate,
  makeAcpDecodeState,
  type NormalizedAgentEvent,
} from "../agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
import { runMcpAgentViaAcp } from "./mcp-agent-acp";
import { createRecapDispatchState, dispatchRecapStreamEvent } from "./recap-event-dispatch";
import type { RecapToolContext } from "./recap-tools";
import { RECAP_MCP_SERVER } from "./recap-tools";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RecapAcpSessionDeps {
  /** Mint a bearer token scoped to this recap job's tool context. */
  readonly issueSessionToken: (ctx: RecapToolContext) => Promise<string>;
  /** Invalidate the token when we're done (or aborted). */
  readonly clearSessionToken: (token: string) => Promise<void>;
}

export interface RunRecapAgentAcpParams {
  readonly ctx: RecapToolContext;
  /** Resolved ACP registry agent id that drives this generation. */
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  /** Working dir the ACP connection is pooled under (repo clone path / server cwd). */
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly sessionDeps: RecapAcpSessionDeps;
}

export interface RecapAcpResult {
  readonly tokenUsage?: Record<string, number>;
  /** Error message when the run failed (e.g. agent never called a tool). */
  readonly error?: string;
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run a single recap agent turn through the configured ACP agent. The ACP
 * connection is pooled per working directory by `getAcpConnection`; this driver
 * opens a fresh session, hands the agent the `/mcp/recap` HTTP endpoint, prompts,
 * and dispatches the agent's normalized session updates onto recap SSE events.
 *
 * Resolves to a best-effort token-usage snapshot once the model finishes or the
 * abort signal fires. The `onCompleted` hook on the context flips
 * `validatedComplete` in the orchestrator when `complete_recap` succeeds — the
 * caller observes that flag separately, not this return value.
 */
export async function runRecapAgentViaAcp(params: RunRecapAgentAcpParams): Promise<RecapAcpResult> {
  let validatedCompleteSeen = false;

  // Wrap onCompleted so a complete_recap-triggered abort reads as success.
  const toolCtx: RecapToolContext = {
    ...params.ctx,
    onCompleted: () => {
      validatedCompleteSeen = true;
      params.ctx.onCompleted();
    },
  };

  const userMessage = `${RECAP_SYSTEM_PROMPT}\n\n---\n\n${buildRecapUserMessage(
    params.ctx.sourceBundle,
    params.ctx.priorRecaps,
  )}`;

  // Visible assistant text is discarded; reasoning becomes `thought` events +
  // a throttled phase heartbeat. MCP-tool content reaches the UI via the route
  // handlers' `ctx.emit`, not this stream.
  const dispatchState = createRecapDispatchState();
  const fanOut = (event: RecapStreamEvent): void => {
    if (validatedCompleteSeen) return;
    try {
      params.ctx.emit(event);
    } catch (err) {
      logError(
        "recap-acp",
        `ctx.emit threw for event type=${event.type}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  const onAgentEvent = (ev: NormalizedAgentEvent): void => {
    if (ev.kind === "error") {
      logError("recap-acp", `session.error: ${ev.message}`);
      return;
    }
    dispatchRecapStreamEvent(ev, dispatchState, fanOut);
  };
  const decodeState = makeAcpDecodeState();

  const sessionToken = await params.sessionDeps.issueSessionToken(toolCtx);
  try {
    const outcome = await runMcpAgentViaAcp({
      acpAgentId: params.acpAgentId,
      modelUsed: params.modelUsed,
      thinkingEffort: params.thinkingEffort,
      workingDir: params.workingDir,
      abortController: params.abortController,
      route: "/mcp/recap",
      mcpServerName: `${RECAP_MCP_SERVER}-${params.ctx.recapId}`,
      sessionToken,
      prompt: userMessage,
      toolCalls: params.ctx.toolCalls,
      isValidated: () => validatedCompleteSeen,
      purpose: "recap generation",
      debugLabel: "recap-acp",
      onSessionUpdate: (update) => {
        for (const ev of decodeAcpSessionUpdate(update, decodeState)) onAgentEvent(ev);
      },
    });
    if (outcome.noToolCalls && outcome.error) {
      params.ctx.emit({ type: "error", data: { code: "NoToolCalls", message: outcome.error } });
    }
    return outcome.error ? { error: outcome.error } : {};
  } finally {
    try {
      await params.sessionDeps.clearSessionToken(sessionToken);
    } catch {
      /* ignore */
    }
  }
}
