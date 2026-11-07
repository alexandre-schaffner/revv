import type { AcpAgentId, InstallEvent } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { sseErrorMessage, streamSse } from "$lib/api/sse-stream";

export type AgentInstallState =
  | { kind: "idle" }
  | { kind: "running"; agent: AcpAgentId; log: string[] }
  | { kind: "failed"; agent: AcpAgentId; log: string[]; error: string };

const DEFAULT_LOG_TAIL = 6;

export function agentInstallLog(state: AgentInstallState): string[] {
  return state.kind === "idle" ? [] : state.log;
}

export function appendAgentInstallLog(
  state: AgentInstallState,
  agent: AcpAgentId,
  line: string,
  limit = DEFAULT_LOG_TAIL,
): AgentInstallState {
  if (state.kind !== "running") return state;
  return { kind: "running", agent, log: [...state.log, line].slice(-limit) };
}

async function startAgentInstall(agent: AcpAgentId): Promise<{ jobId: string }> {
  return call(api.api.onboarding.install.post({ agent }), "Failed to start installer");
}

export async function runAgentInstall(
  agent: AcpAgentId,
  signal: AbortSignal,
  onEvent: (event: InstallEvent) => void | Promise<void>,
): Promise<void> {
  const { jobId } = await startAgentInstall(agent);
  try {
    await streamSse<InstallEvent>({
      path: `/api/onboarding/install/stream?jobId=${encodeURIComponent(jobId)}`,
      refused: "The installer stream was refused",
      signal,
      onEvent,
    });
  } catch (e) {
    const message = sseErrorMessage(e);
    throw message === null ? e : new Error(message);
  }
}
