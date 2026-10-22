import type { AppChannel } from "@revv/shared";
import { API_BASE_URL, APP_CHANNEL } from "$lib/api/base-url";

export type RuntimeHealth = {
  status: "ok";
  channel: AppChannel;
  port: number;
  timestamp: string;
};

export async function assertRuntimeChannel(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/health`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API health check failed with HTTP ${res.status}`);
  }

  const health = (await res.json()) as RuntimeHealth;
  if (health.channel !== APP_CHANNEL) {
    throw new Error(
      `Wrong Revv API server: web channel is ${APP_CHANNEL}, but http://localhost:${health.port} is ${health.channel}.`,
    );
  }
}
