// ACP tags built-in tools with a `kind` but gives MCP tools only a human
// title, so "did the model call any tools?" asks the runner's own record of
// route calls (`calledAnyTool`), never the agent stream.

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

export interface RunMcpAgentAcpParams {
  readonly acpAgentId: AcpAgentId;
  readonly modelUsed: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
  readonly workingDir: string;
  readonly abortController: AbortController;
  readonly route: string;
  readonly mcpServerName: string;
  readonly sessionToken: string;
  /** System prompt and user message in one: ACP has no separate system channel. */
  readonly prompt: string;
  readonly calledAnyTool: () => boolean;
  readonly isValidated: () => boolean;
  readonly purpose: string;
  readonly debugLabel: string;
  readonly onSessionUpdate?: (update: AcpSessionUpdate) => void;
}

export interface McpAgentAcpResult {
  readonly validated: boolean;
  readonly noToolCalls?: boolean;
  readonly error?: string;
}

export async function runMcpAgentViaAcp(params: RunMcpAgentAcpParams): Promise<McpAgentAcpResult> {
  const label = params.debugLabel;
  let sessionId: string | null = null;
  let handle: AcpConnectionHandle | null = null;
  const activity = makeActivityBeacon();

  try {
    handle = await getAcpConnection(params.workingDir, params.acpAgentId, {
      model: params.modelUsed,
      thinkingEffort: params.thinkingEffort,
    });
    const h = handle;
    if (!h.httpMcpSupported) {
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

        if (!params.calledAnyTool()) {
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
