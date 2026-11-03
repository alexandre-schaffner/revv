import type { AppChannel } from "@revv/shared";
import { API_BASE_URL, APP_CHANNEL } from "$lib/api/base-url";

export type RuntimeHealth = {
  status: "ok";
  channel: AppChannel;
  /**
   * Commit of the source checkout the server runs from; `null` when it can't
   * be read. Absent on servers that predate this field.
   */
  commit?: string | null;
  port: number;
  timestamp: string;
};

export async function fetchRuntimeHealth(): Promise<RuntimeHealth> {
  const res = await fetch(`${API_BASE_URL}/api/health`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API health check failed with HTTP ${res.status}`);
  }
  return (await res.json()) as RuntimeHealth;
}

export function assertRuntimeChannel(health: RuntimeHealth): void {
  if (health.channel !== APP_CHANNEL) {
    throw new Error(
      `Wrong Revv API server: web channel is ${APP_CHANNEL}, but http://localhost:${health.port} is ${health.channel}.`,
    );
  }
}
