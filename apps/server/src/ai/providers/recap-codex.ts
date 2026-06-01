// ─── recap-codex ─────────────────────────────────────────────────────────────
//
// Codex driver for project-recap generation. Mirrors `recap-opencode.ts` but
// drives the agent in-process via `@openai/codex-sdk` (no daemon) while still
// routing all tool handling through the shared `/mcp/recap` HTTP route
// (invariant #13). The MCP route is registered on the codex CLI via the SDK
// `config.mcp_servers` map with a bearer token in `http_headers`.
//
// Lifecycle:
//   1. Issue a session token in `ProjectRecapJobs` bound to the prepared
//      `RecapToolContext` (recapId + sourceBundle + priorRecaps + onCompleted).
//   2. Construct a `Codex` with `/mcp/recap` baked in (token minted first).
//   3. start a thread, `runStreamed` the recap prompt, and dispatch the codex
//      event stream through the SHARED recap dispatcher.
//   4. Fail fast if the model emitted zero MCP tool calls (doesn't support
//      tool calling, or auth not configured).
//   5. Clear the session token in `finally`.

import type { RecapStreamEvent } from "@revv/shared";
import { serverEnv } from "../../config";
import { CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import { type NormalizedAgentEvent, walkCodexEvents, withAgentTurn } from "../agent-stream";
import { buildRecapUserMessage, RECAP_SYSTEM_PROMPT } from "../prompts/recap";
import {
  type CodexMcpServers,
  codexMcpServerName,
  codexUsageRecord,
  makeCodexMcpServer,
  startCodexThread,
} from "./codex-transport";
import { createRecapDispatchState, dispatchRecapStreamEvent } from "./recap-event-dispatch";
import type { RecapToolContext } from "./recap-tools";
import { RECAP_MCP_SERVER } from "./recap-tools";

// ── Public types ─────────────────────────────────────────────────────────────

export interface RecapCodexSessionDeps {
  /** Mint a bearer token scoped to this recap job's tool context. */
  readonly issueSessionToken: (ctx: RecapToolContext) => Promise<string>;
  /** Invalidate the token when we're done (or aborted). */
  readonly clearSessionToken: (token: string) => Promise<void>;
}

export interface RunRecapAgentCodexParams {
  readonly ctx: RecapToolContext;
  readonly modelUsed: string;
  /** Working directory handed to the codex thread. */
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly sessionDeps: RecapCodexSessionDeps;
}

export interface RecapCodexResult {
  readonly tokenUsage?: Record<string, number>;
  readonly error?: string;
}

export async function runRecapAgentViaCodex(
  params: RunRecapAgentCodexParams,
): Promise<RecapCodexResult> {
  let sessionToken: string | null = null;
  let validatedCompleteSeen = false;
  let toolCallCount = 0;

  const userMessage =
    RECAP_SYSTEM_PROMPT +
    "\n\n---\n\n" +
    buildRecapUserMessage(params.ctx.sourceBundle, params.ctx.priorRecaps);

  try {
    return await withAgentTurn<RecapCodexResult>({
      externalAbort: params.abortController,
      hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
      // No daemon to refcount — codex owns its own subprocess.
      jobStarted: async () => {},
      jobEnded: async () => {},
      debugLabel: "recap-codex",
      run: async (ctx) => {
        // Wrap onCompleted so we can recognize an abort triggered by a
        // successful `complete_recap` (the runner's wrapper aborts the
        // controller) and treat it as success rather than an error.
        const toolCtx: RecapToolContext = {
          ...params.ctx,
          onCompleted: () => {
            validatedCompleteSeen = true;
            params.ctx.onCompleted();
          },
        };

        // ── 1. Issue session token ───────────────────────────────
        sessionToken = await params.sessionDeps.issueSessionToken(toolCtx);
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}/mcp/recap`;
        const mcpServerName = codexMcpServerName(RECAP_MCP_SERVER, params.ctx.recapId);
        debug("recap-codex", `registering MCP ${mcpServerName} → ${mcpUrl}`);

        // ── 2. Construct codex with the HTTP MCP route baked in ───
        const mcpServers: CodexMcpServers = {
          [mcpServerName]: makeCodexMcpServer(mcpUrl, sessionToken),
        };
        // danger-full-access + approval=never is the only combination that lets
        // MCP tool calls execute under one-way `codex exec` (read-only /
        // workspace-write auto-cancel them). Parity with Claude's
        // bypassPermissions — see mcp-walkthrough-codex for the full rationale.
        const thread = startCodexThread({
          workingDirectory: params.workingDir,
          mcpServers,
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          ...(params.modelUsed ? { model: params.modelUsed } : {}),
        });

        // ── 3. Drive the stream through the shared recap dispatcher ─
        const dispatchState = createRecapDispatchState();
        const fanOut = (event: RecapStreamEvent): void => {
          if (validatedCompleteSeen) return;
          try {
            params.ctx.emit(event);
          } catch (err) {
            logError(
              "recap-codex",
              `ctx.emit threw for event type=${event.type}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        };
        const emit = (ev: NormalizedAgentEvent): void => {
          if (ev.kind === "tool-call" && ev.source === "mcp") toolCallCount += 1;
          if (ev.kind === "error") {
            logError("recap-codex", `session.error: ${ev.message}`);
            return;
          }
          dispatchRecapStreamEvent(ev, dispatchState, fanOut);
        };

        const { events } = await thread.runStreamed(userMessage, { signal: ctx.signal });
        const usage = await walkCodexEvents(events, emit);

        // ── 4. NoToolCalls guard ──────────────────────────────────
        if (toolCallCount === 0 && !validatedCompleteSeen) {
          const msg =
            `The model finished without calling any tools. This usually means the selected ` +
            `model (${params.modelUsed}) does not support tool calling through codex, or codex ` +
            `auth is not configured.`;
          logError("recap-codex", msg);
          params.ctx.emit({ type: "error", data: { code: "NoToolCalls", message: msg } });
          return { error: msg };
        }

        // ── 5. Token usage ────────────────────────────────────────
        const tokenUsage = codexUsageRecord(usage);
        return tokenUsage ? { tokenUsage } : {};
      },
    });
  } catch (err) {
    // An abort fired by a successful `complete_recap` is success, not failure.
    if (validatedCompleteSeen) return {};
    const message = err instanceof Error ? err.message : String(err);
    logError("recap-codex", "run failed:", message);
    return { error: message };
  } finally {
    if (sessionToken) {
      try {
        await params.sessionDeps.clearSessionToken(sessionToken);
      } catch {
        /* ignore */
      }
    }
  }
}
