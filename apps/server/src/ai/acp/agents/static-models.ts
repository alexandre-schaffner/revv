import { type AcpAgentId, getAgentCapabilities } from "@revv/shared";
import type { AgentModelOption } from "./types";

/** An agent's curated catalog from the shared registry (empty for a dynamic one). */
export function staticModels(id: AcpAgentId): AgentModelOption[] {
  const { models } = getAgentCapabilities(id);
  return models === "dynamic" ? [] : models.map((m) => ({ label: m.label, value: m.value }));
}
