import type { ExternalAgentProvider, ExternalIntegrationStatus } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";

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

export async function fetchExternalIntegrationStatuses(): Promise<void> {
  try {
    statuses = [
      ...(await call(api.api.integrations.status.get(), "Couldn't read the integrations")),
    ];
    error = null;
  } catch (cause) {
    error = thrownMessage(cause);
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
    await (kind === "connect"
      ? call(route.connect.post(), `Couldn't connect ${provider}`)
      : call(route.disconnect.delete(), `Couldn't disconnect ${provider}`));
    await fetchExternalIntegrationStatuses();
  } catch (cause) {
    error = thrownMessage(cause);
  } finally {
    action = null;
  }
}
