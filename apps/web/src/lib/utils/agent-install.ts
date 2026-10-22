import type { AcpAgentId, InstallEvent } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";

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

async function streamAgentInstallEvents(
  jobId: string,
  signal: AbortSignal,
  onEvent: (event: InstallEvent) => void | Promise<void>,
): Promise<void> {
  const url = `${API_BASE_URL}/api/onboarding/install/stream?jobId=${encodeURIComponent(jobId)}`;
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) throw new Error(`Stream failed (HTTP ${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const result = parseSSEBuffer<InstallEvent>(buffer);
    buffer = result.remaining;
    for (const event of result.events) await onEvent(event);
    if (result.done) break;
  }
}

export async function runAgentInstall(
  agent: AcpAgentId,
  signal: AbortSignal,
  onEvent: (event: InstallEvent) => void | Promise<void>,
): Promise<void> {
  const { jobId } = await startAgentInstall(agent);
  await streamAgentInstallEvents(jobId, signal, onEvent);
}
