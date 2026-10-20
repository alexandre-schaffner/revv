// ─── stack-brief-acp ─────────────────────────────────────────────────────────
//
// ACP driver for the stack brief, modelled on `recap-acp.ts`. Every piece of
// content reaches SQLite through the shared handlers behind `/mcp/stack-brief`
// (CLAUDE.md invariants 2 and 13); the agent's own session stream only keeps
// the idle deadline alive. The brief has no live stream: the UI learns of it
// through `stack-brief:status-changed` and re-reads the stack.

import type { McpServer } from "@agentclientprotocol/sdk";
import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { serverEnv } from "../../config";
import { AGENT_IDLE_TIMEOUT_MS, CLI_WALKTHROUGH_TIMEOUT_MS } from "../../constants";
import { debug, logError } from "../../logger";
import { type AcpConnectionHandle, getAcpConnection } from "../acp/acp-connection";
import { withAgentKeychainHint } from "../acp/agent-keychain";
import { makeActivityBeacon, withAgentTurn } from "../agent-stream";
import { buildStackBriefUserMessage, STACK_BRIEF_SYSTEM_PROMPT } from "../prompts/stack-brief";
import type { StackBriefSnapshot, StackBriefToolContext } from "./stack-brief-tools";
import { STACK_BRIEF_MCP_SERVER } from "./stack-brief-tools";

export interface RunStackBriefAcpParams {
  readonly ctx: StackBriefToolContext;
  readonly snapshot: StackBriefSnapshot;
  /** Bearer the `/mcp/stack-brief` route resolves back to `ctx`. */
  readonly sessionToken: string;
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  /** Working dir the ACP connection is pooled under (repo clone / server cwd). */
  readonly workingDir: string;
  /**
   * Aborted by the job when `complete_stack_brief` validates, so the run
   * ends at the gate instead of waiting out the model's sign-off.
   */
  readonly abortController: AbortController;
  /** True once `complete_stack_brief` has validated; an abort after it is success. */
  readonly isValidated: () => boolean;
}

export interface StackBriefAcpResult {
  /** `complete_stack_brief` validated during this run. */
  readonly validatedComplete: boolean;
  readonly error?: string;
}

export async function runStackBriefAgentViaAcp(
  params: RunStackBriefAcpParams,
): Promise<StackBriefAcpResult> {
  let sessionId: string | null = null;
  let handle: AcpConnectionHandle | null = null;
  const activity = makeActivityBeacon();

  const userMessage = `${STACK_BRIEF_SYSTEM_PROMPT}\n\n---\n\n${buildStackBriefUserMessage(params.snapshot)}`;

  try {
    handle = await getAcpConnection(params.workingDir, params.acpAgentId, {
      model: params.modelUsed,
      thinkingEffort: params.thinkingEffort,
    });
    const h = handle;
    if (!h.httpMcpSupported) {
      throw new Error(
        `ACP agent '${params.acpAgentId}' does not advertise HTTP MCP support; the stack brief requires it`,
      );
    }

    return await withAgentTurn<StackBriefAcpResult>({
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
      debugLabel: "stack-brief-acp",
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async () => {
        const mcpServers: McpServer[] = [
          {
            type: "http",
            name: `${STACK_BRIEF_MCP_SERVER}-${params.ctx.briefId}`,
            url: `http://127.0.0.1:${serverEnv.port}/mcp/stack-brief`,
            headers: [{ name: "Authorization", value: `Bearer ${params.sessionToken}` }],
          },
        ];
        const created = await h.newSession(mcpServers);
        sessionId = created.sessionId;
        h.setListener(sessionId, () => {
          activity.note();
        });

        debug("stack-brief-acp", `prompting session ${sessionId}`, "model:", params.modelUsed);
        await h.prompt(sessionId, [{ type: "text", text: userMessage }]);
        if (params.isValidated()) return { validatedComplete: true };

        // ACP names no MCP tools on its stream; the route records each call.
        if ((params.ctx.toolCalls?.size ?? 0) === 0) {
          return {
            validatedComplete: false,
            error:
              `The model finished without calling any tools. The selected model (${params.modelUsed}) ` +
              `may not support tool calling through the '${params.acpAgentId}' ACP agent.`,
          };
        }
        return { validatedComplete: false };
      },
    });
  } catch (err) {
    if (params.isValidated()) return { validatedComplete: true };
    const message = withAgentKeychainHint(
      params.acpAgentId,
      err instanceof Error ? err.message : String(err),
    );
    logError("stack-brief-acp", "run failed:", message);
    return { validatedComplete: false, error: message };
  } finally {
    if (handle && sessionId) handle.setListener(sessionId, null);
  }
}
