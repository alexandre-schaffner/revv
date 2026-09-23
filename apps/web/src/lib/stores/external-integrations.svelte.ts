import type { ExternalAgentProvider, ExternalIntegrationStatus } from "@revv/shared";
import { api } from "$lib/api/client";

let statuses = $state<ExternalIntegrationStatus[]>([]);
let action = $state<{
  provider: ExternalAgentProvider;
  kind: "connect" | "disconnect";
} | null>(null);
let error = $state<string | null>(null);

export function getExternalIntegrationStatuses(): ExternalIntegrationStatus[] {
  return statuses;
}

export function getExternalIntegrationAction(): typeof action {
  return action;
}

export function getExternalIntegrationError(): string | null {
  return error;
}

function errorMessage(value: unknown): string {
  if (value && typeof value === "object") {
    const body = "value" in value ? value.value : value;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  }
  return value instanceof Error ? value.message : String(value);
}

export async function fetchExternalIntegrationStatuses(): Promise<void> {
  try {
    const result = await api.api.integrations.status.get();
    if (result.error) throw new Error(errorMessage(result.error));
    if (!Array.isArray(result.data)) {
      throw new Error("Revv returned an invalid integration status response.");
    }
    statuses = [...result.data];
    error = null;
  } catch (cause) {
    error = errorMessage(cause);
  }
}

export async function runExternalIntegrationAction(
  provider: ExternalAgentProvider,
  kind: "connect" | "disconnect",
): Promise<void> {
  if (action) return;
  action = { provider, kind };
  error = null;
  try {
    const route = api.api.integrations({ provider });
    const result =
      kind === "connect" ? await route.connect.post() : await route.disconnect.delete();
    if (result.error) throw new Error(errorMessage(result.error));
    await fetchExternalIntegrationStatuses();
  } catch (cause) {
    error = errorMessage(cause);
  } finally {
    action = null;
  }
}
