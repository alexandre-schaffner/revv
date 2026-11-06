import type { RuntimeHealth } from "@revv/shared";
import { APP_CHANNEL } from "$lib/api/base-url";
import { api } from "$lib/api/client";

export async function fetchRuntimeHealth(): Promise<RuntimeHealth> {
  const { data, error } = await api.api.health.get({ fetch: { cache: "no-store" } });
  if (error) throw new Error(`API health check failed with HTTP ${String(error.status)}`);
  return data;
}

export function assertRuntimeChannel(health: RuntimeHealth): void {
  if (health.channel !== APP_CHANNEL) {
    throw new Error(
      `Wrong Revv API server: web channel is ${APP_CHANNEL}, but http://localhost:${health.port} is ${health.channel}.`,
    );
  }
}
