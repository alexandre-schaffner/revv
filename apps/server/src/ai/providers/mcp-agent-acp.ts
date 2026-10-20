// ─── mcp-agent-acp ───────────────────────────────────────────────────────────
//
// The ACP session driver shared by the background agent pipelines whose every
// write goes through an HTTP MCP route (recap, stack brief). It opens a fresh
// session on the pooled connection, hands the agent the route with a bearer
// the route resolves back to the job's tool context, prompts once, and reports
// whether the pipeline's validation gate fired (CLAUDE.md invariants 2 and 13).
//
// ACP tags built-in tools with a `kind` but gives MCP tools only a human
// title, so "did the model call any tools?" reads the route's own record of
// calls (`toolCalls`), never the agent stream.

import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { serverEnv } from "../../config";
import { AGENT_IDLE_TIMEOUT_MS, CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import {
  type AcpConnectionHandle,
  type AcpSessionUpdate,
  getAcpConnection,
} from "../acp/acp-connection";
import { withAgentKeychainHint } from "../acp/agent-keychain";
import { makeActivityBeacon, withAgentTurn } from "../agent-stream";
import type { McpToolResult } from "./mcp-tool-gateway";

export interface RunMcpAgentAcpParams {
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  /** Working dir the ACP connection is pooled under (repo clone / server cwd). */
  readonly workingDir: string;
  /** Aborted by the job when its gate validates, or when the job is stopped. */
  readonly abortController: AbortController;
  /** The pipeline's MCP route, e.g. `/mcp/recap`. */
  readonly route: string;
  /** Server name advertised to the agent, unique per job. */
  readonly mcpServerName: string;
  /** Bearer the route resolves back to the job's tool context. */
  readonly sessionToken: string;
  /** System prompt and user message in one: ACP has no separate system channel. */
  readonly prompt: string;
  /** Tool names the route recorded this run. */
  readonly toolCalls: ReadonlySet<string> | undefined;
  /** True once the gate has validated; an abort after it is success. */
  readonly isValidated: () => boolean;
  /** What the pipeline is called in errors ("recap generation"). */
  readonly purpose: string;
  /** Debug and error log scope ("recap-acp"). */
  readonly debugLabel: string;
  /** Every session update, after it rearms the idle deadline. */
  readonly onSessionUpdate?: (update: AcpSessionUpdate) => void;
}

export interface McpAgentAcpResult {
  /** The gate validated during this run. */
  readonly validated: boolean;
  /** The model ended its turn without calling a single tool. */
  readonly noToolCalls?: boolean;
  readonly error?: string;
}

export async function runMcpAgentViaAcp(params: RunMcpAgentAcpParams): Promise<McpAgentAcpResult> {
  const label = params.debugLabel;
  let sessionId: string | null = null;
  let handle: AcpConnectionHandle | null = null;
  // Liveness for the idle deadline: poked by the agent's own session updates
  // (its MCP tool calls arrive on that stream too, they just carry no name).
  const activity = makeActivityBeacon();

  try {
    handle = await getAcpConnection(params.workingDir, params.acpAgentId, {
      model: params.modelUsed,
      thinkingEffort: params.thinkingEffort,
    });
    const h = handle;
    if (!h.httpMcpSupported) {
      // Every write goes through the route, so there's nothing to degrade to.
      throw new Error(
        `ACP agent '${params.acpAgentId}' does not advertise HTTP MCP support; ${params.purpose} requires it`,
      );
    }

    return await withAgentTurn<McpAgentAcpResult>({
      externalAbort: params.abortController,
      hardTimeoutMs: CLI_WALKTHROUGH_TIMEOUT_MS,
      idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
      activity,
      jobStarted: async () => {
        h.jobStarted();
      },
      jobEnded: async () => {
        h.jobEnded();
      },
      debugLabel: label,
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async (turn) => {
        const mcpUrl = `http://127.0.0.1:${serverEnv.port}${params.route}`;
        const mcpServers: McpServer[] = [
          {
            type: "http",
            name: params.mcpServerName,
            url: mcpUrl,
            headers: [{ name: "Authorization", value: `Bearer ${params.sessionToken}` }],
          },
        ];
        debug(label, `registering MCP ${params.mcpServerName} → ${mcpUrl}`);

        // A fresh session every run (never loadSession): a resume rebuilds
        // its context from the DB through the pipeline's state tool.
        const created = await h.newSession(mcpServers);
        sessionId = created.sessionId;
        debug(label, "created session:", sessionId);
        h.setListener(sessionId, (update) => {
          activity.note();
          params.onSessionUpdate?.(update);
        });

        debug(label, `prompting session ${sessionId}`, "model:", params.modelUsed);
        const stopReason = await h.prompt(sessionId, [{ type: "text", text: params.prompt }]);
        debug(label, `prompt returned for session ${sessionId} (stop=${stopReason})`);

        if (params.isValidated()) return { validated: true };
        if (turn.wasCancelled() || turn.wasTimeout()) return { validated: false };

        // Zero calls means the model never engaged the tool surface: it
        // doesn't support tool calling, or its provider isn't set up for it.
        if ((params.toolCalls?.size ?? 0) === 0) {
          const error =
            `The model finished without calling any tools. This usually means the selected ` +
            `model (${params.modelUsed}) does not support tool calling through the '${params.acpAgentId}' ` +
            `ACP agent, or the provider is not configured for it.`;
          logError(label, error);
          return { validated: false, noToolCalls: true, error };
        }
        return { validated: false };
      },
    });
  } catch (err) {
    // An abort fired by the gate validating is success, not failure.
    if (params.isValidated()) return { validated: true };
    const message = withAgentKeychainHint(
      params.acpAgentId,
      err instanceof Error ? err.message : String(err),
    );
    logError(label, "run failed:", message);
    return { validated: false, error: message };
  } finally {
    if (handle && sessionId) handle.setListener(sessionId, null);
  }
}

/**
 * The agent may write everything and stop short of the validation gate. The
 * gate only reads the DB, so run it on the agent's behalf — but only when the
 * agent read its state this run (`stateTool`), i.e. it was working from the
 * journal rather than never starting. `ready` is a cheap pre-check that spares
 * the gate a call it would refuse.
 */
export async function recoverMissedGate(opts: {
  readonly toolCalls: ReadonlySet<string> | undefined;
  readonly stateTool: string;
  readonly ready?: () => boolean;
  readonly gate: () => Promise<McpToolResult>;
  readonly debugLabel: string;
  readonly what: string;
}): Promise<{ readonly recovered: boolean; readonly error?: string }> {
  if (!opts.toolCalls?.has(opts.stateTool)) return { recovered: false };
  if (opts.ready && !opts.ready()) return { recovered: false };
  debug(opts.debugLabel, `${opts.what}: validating after a missed gate call`);
  const result = await opts.gate();
  if (!result.isError) return { recovered: true };
  const error = result.content[0]?.text;
  return error ? { recovered: false, error } : { recovered: false };
}
