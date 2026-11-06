import type { AcpAgentId, InstallEvent } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { SseHttpError, streamSse } from "$lib/api/sse-stream";
import { authHeaders } from "$lib/session/token.svelte";

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
  const res = await fetch(`${API_BASE_URL}/api/onboarding/install`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ agent }),
  });
  if (!res.ok) throw new Error(`Failed to start installer (HTTP ${res.status})`);
  return (await res.json()) as { jobId: string };
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
      signal,
      onEvent,
    });
  } catch (e) {
    throw e instanceof SseHttpError ? new Error(`Stream failed (HTTP ${e.status})`) : e;
  }
}
