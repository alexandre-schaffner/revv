import type { RuntimeHealth } from "@revv/shared";
import { APP_CHANNEL } from "$lib/api/base-url";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";

export async function fetchRuntimeHealth(): Promise<RuntimeHealth> {
  return call(api.api.health.get({ fetch: { cache: "no-store" } }), "API health check failed");
}

export function assertRuntimeChannel(health: RuntimeHealth): void {
  if (health.channel !== APP_CHANNEL) {
    throw new Error(
      `Wrong Revv API server: web channel is ${APP_CHANNEL}, but http://localhost:${health.port} is ${health.channel}.`,
    );
  }
}
