// Choosing the agent, and its in-flight install / sign-in, for every picker
// (onboarding, Settings → AI agent, the bottom bar).
//
// Module-scoped rather than component state: settings panes mount one at a
// time, and switching panes (or closing the modal) mid-install must not abort
// the installer. Reopening the pane picks the running log back up.

import { type AcpAgentId, getAgentCapabilities, type InstallEvent } from "@revv/shared";
import {
  agentChange,
  areModelsLoaded,
  fetchAgentStatus,
  fetchModels,
  getSettings,
  updateSettings,
} from "$lib/stores/settings.svelte";
import {
  type AgentInstallState,
  agentInstallLog,
  appendAgentInstallLog,
  runAgentInstall,
} from "./install";

let install = $state<AgentInstallState>({ kind: "idle" });
let signingInAgent = $state<AcpAgentId | null>(null);
let installAbort: AbortController | null = null;

export function getAgentInstall(): AgentInstallState {
  return install;
}

export function getSigningInAgent(): AcpAgentId | null {
  return signingInAgent;
}

/**
 * Make `agent` the selected one. A live-catalog agent's default model is its
 * first fetched model, so the patch waits for the catalog. An install or
 * sign-in belongs to the agent it started for, so it is dropped.
 */
export async function selectAgent(agent: AcpAgentId): Promise<void> {
  if (agent === getSettings().aiAgent) return;
  if (getAgentCapabilities(agent).models === "dynamic" && !areModelsLoaded(agent)) {
    await fetchModels(agent);
  }
  resetAgentSetup();
  await updateSettings(agentChange(agent));
  void fetchAgentStatus();
}

/** Drop any install or sign-in in progress. */
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
