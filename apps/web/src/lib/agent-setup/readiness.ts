import type { AgentStatus } from "@revv/shared";

export type AgentTone = "success" | "warning" | "muted";

/** Where an agent stands, as every agent picker shows it. */
export interface AgentReadiness {
  readonly ready: boolean;
  /** The setup step left; null when ready or not yet checked. */
  readonly needs: "install" | "sign-in" | null;
  readonly tone: AgentTone;
  readonly label: string;
}

export function agentReadiness(status: AgentStatus | null | undefined): AgentReadiness {
  if (!status) return { ready: false, needs: null, tone: "muted", label: "Not checked" };
  if (!status.installed) {
    return { ready: false, needs: "install", tone: "muted", label: "Not installed" };
  }
  if (!status.authed) {
    return { ready: false, needs: "sign-in", tone: "warning", label: "Needs sign-in" };
  }
  return status.verified
    ? { ready: true, needs: null, tone: "success", label: "Connected" }
    : { ready: true, needs: null, tone: "warning", label: "Configured" };
}
