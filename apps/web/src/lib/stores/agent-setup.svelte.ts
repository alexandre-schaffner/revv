// In-flight agent install / sign-in from Settings → AI agent.
//
// Module-scoped rather than component state: settings panes mount one at a
// time, and switching panes (or closing the modal) mid-install must not abort
// the installer. Reopening the pane picks the running log back up.

import type { AcpAgentId, InstallEvent } from "@revv/shared";
import { fetchAgentStatus } from "$lib/stores/settings.svelte";
import {
  type AgentInstallState,
  agentInstallLog,
  appendAgentInstallLog,
  runAgentInstall,
} from "$lib/utils/agent-install";

let install = $state<AgentInstallState>({ kind: "idle" });
let signingInAgent = $state<AcpAgentId | null>(null);
let installAbort: AbortController | null = null;

export function getAgentInstall(): AgentInstallState {
  return install;
}

export function getSigningInAgent(): AcpAgentId | null {
  return signingInAgent;
}

/** Drop any install or sign-in in progress, e.g. when the selected agent changes. */
export function resetAgentSetup(): void {
  installAbort?.abort();
  installAbort = null;
  install = { kind: "idle" };
  signingInAgent = null;
}

export function startAgentSignIn(agent: AcpAgentId): void {
  signingInAgent = agent;
}

export function endAgentSignIn(): void {
  signingInAgent = null;
}

export async function startAgentInstall(agent: AcpAgentId): Promise<void> {
  installAbort?.abort();
  install = { kind: "running", agent, log: [] };
  try {
    const ctrl = new AbortController();
    installAbort = ctrl;
    await runAgentInstall(agent, ctrl.signal, (event) => applyInstallEvent(event, agent));
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    install = {
      kind: "failed",
      agent,
      log: agentInstallLog(install),
      error: err instanceof Error ? err.message : "Install failed",
    };
  } finally {
    installAbort = null;
  }
}

async function applyInstallEvent(event: InstallEvent, agent: AcpAgentId): Promise<void> {
  if (event.type === "log") {
    install = appendAgentInstallLog(install, agent, event.line);
    return;
  }
  if (!event.success) {
    install = {
      kind: "failed",
      agent,
      log: agentInstallLog(install),
      error: event.error ?? "Install failed",
    };
    return;
  }

  const status = await fetchAgentStatus();
  install = { kind: "idle" };
  if (status?.agents[agent]?.authed === false && status.embeddedLoginSupported) {
    signingInAgent = agent;
  }
}
