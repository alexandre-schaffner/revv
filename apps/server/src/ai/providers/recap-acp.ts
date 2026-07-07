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
// Notable differences from the opencode/codex drivers, all consequences of ACP
// not carrying a machine tool name for MCP tools (it tags built-in tools with a
// `kind` but MCP tools arrive with only a human title — see acp-decoders.ts):
//   • The "did the model actually call any tools?" guard reads `ctx.toolCalls`
//     (populated by the `/mcp/recap` route's `beforeToolCall`) rather than
//     counting MCP tool-call frames off the agent stream.
//   • Throughput token fields are unavailable over ACP and stay absent (an
//     accepted regression vs. the pre-migration drivers).

import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpAgentId, ContextWindow, RecapStreamEvent, ThinkingEffort } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import { type AcpConnectionHandle, getAcpConnection } from "../acp/acp-connection";
import { withAgentAuthHint } from "../acp/presets";
import {
  decodeAcpSessionUpdate,
  makeAcpDecodeState,
  type NormalizedAgentEvent,
  withAgentTurn,
} from "../agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
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
  readonly contextWindow?: ContextWindow | undefined;
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
  let sessionToken: string | null = null;
  let sessionId: string | null = null;
  let handle: AcpConnectionHandle | null = null;
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

  try {
    handle = await getAcpConnection(params.workingDir, params.acpAgentId, {
      model: params.modelUsed,
      thinkingEffort: params.thinkingEffort,
      contextWindow: params.contextWindow,
    });
    const h = handle;
    if (!h.httpMcpSupported) {
      // HTTP MCP is MANDATORY here (all content flows through it), unlike chat
      // where it degrades. Fail loudly.
      throw new Error(
        `ACP agent '${params.acpAgentId}' does not advertise HTTP MCP support; recap generation requires it`,
      );
    }

    return await withAgentTurn<RecapAcpResult>({
      externalAbort: params.abortController,
      hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
      jobStarted: async () => {
        h.jobStarted();
      },
      jobEnded: async () => {
        h.jobEnded();
      },
      debugLabel: "recap-acp",
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async (ctx) => {
        // ── 1. Issue session token + hand the agent our HTTP MCP endpoint ──
        sessionToken = await params.sessionDeps.issueSessionToken(toolCtx);
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/recap`;
        const mcpServers: McpServer[] = [
          {
            type: "http",
            name: `${RECAP_MCP_SERVER}-${params.ctx.recapId}`,
            url: mcpUrl,
            headers: [{ name: "Authorization", value: `Bearer ${sessionToken}` }],
          },
        ];
        debug("recap-acp", `registering MCP ${RECAP_MCP_SERVER} → ${mcpUrl}`);

        // ── 2. Open a FRESH session (never loadSession) ──────────────────
        const created = await h.newSession(mcpServers);
        sessionId = created.sessionId;
        debug("recap-acp", "created session:", sessionId);

        // ── 3. Stream session updates through the shared recap dispatcher ──
        // Visible assistant text is discarded; reasoning becomes `thought`
        // events + a throttled phase heartbeat. MCP-tool content reaches the
        // UI via the route handlers' `ctx.emit`, not this stream.
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
        h.setListener(sessionId, (update) => {
          for (const ev of decodeAcpSessionUpdate(update, decodeState)) onAgentEvent(ev);
        });

        // ── 4. Prompt and await the turn ─────────────────────────────────
        debug("recap-acp", `prompting session ${sessionId}`, "model:", params.modelUsed);
        const stopReason = await h.prompt(sessionId, [{ type: "text", text: userMessage }]);
        debug("recap-acp", `prompt returned for session ${sessionId} (stop=${stopReason})`);

        // A cancel that fired because `complete_recap` validated is success.
        if ((ctx.wasCancelled() || ctx.wasTimeout()) && !validatedCompleteSeen) {
          return {};
        }
        if (validatedCompleteSeen) return {};

        // ── 5. NoToolCalls guard ──────────────────────────────────────────
        // ACP gives MCP tool calls no machine name, so we can't count them off
        // the stream — the `/mcp/recap` route records every call in
        // `ctx.toolCalls` instead. Zero calls means the model never engaged the
        // tool surface (doesn't support tool calling, or auth isn't configured).
        if ((params.ctx.toolCalls?.size ?? 0) === 0) {
          const msg =
            `The model finished without calling any tools. This usually means the selected ` +
            `model (${params.modelUsed}) does not support tool calling through the '${params.acpAgentId}' ` +
            `ACP agent, or the provider is not configured for it.`;
          logError("recap-acp", msg);
          params.ctx.emit({ type: "error", data: { code: "NoToolCalls", message: msg } });
          return { error: msg };
        }

        return {};
      },
    });
  } catch (err) {
    // An abort fired by a successful `complete_recap` is success, not failure.
    if (validatedCompleteSeen) return {};
    const message = withAgentAuthHint(
      params.acpAgentId,
      err instanceof Error ? err.message : String(err),
    );
    logError("recap-acp", "run failed:", message);
    return { error: message };
  } finally {
    if (handle && sessionId) handle.setListener(sessionId, null);
    if (sessionToken) {
      try {
        await params.sessionDeps.clearSessionToken(sessionToken);
      } catch {
        /* ignore */
      }
    }
  }
}
