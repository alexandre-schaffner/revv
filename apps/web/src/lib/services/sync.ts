import {
  connect as connectEvents,
  disconnect as disconnectEvents,
} from "$lib/stores/events.svelte";
import { fetchPinnedPrs, fetchPrs, fetchRepos, syncPrs } from "$lib/stores/prs.svelte";
import { connect, disconnect } from "$lib/stores/ws.svelte";

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(intervalSeconds: number, token: string): void {
  // Connect WebSocket for real-time updates (PR/repo/chat envelopes)
  connect(token);
  // Connect the global SSE stream for walkthrough events. Without this the
  // browser never opens `/api/events`, so `EventBus.broadcastToAccount`
  // fan-outs land in an empty registration set and the UI sees zero progress
  // (and falls back to rendering the persisted error state from DB).
  // Account-switch in auth.svelte.ts reconnects this same channel; here is
  // the missing first-time-on-app-boot symmetric call.
  connectEvents(token);

  // Fetch initial data
  Promise.all([fetchPrs(), fetchRepos(), fetchPinnedPrs()]).catch(() => {
    // errors handled by stores
  });

  // Set up polling
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(() => {
    syncPrs().catch(() => {
      // errors arrive via WebSocket
    });
  }, intervalSeconds * 1000);
}

export function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  disconnect();
  disconnectEvents();
}

/**
 * Pause only the periodic `syncPrs()` timer without tearing down WebSocket or
 * SSE. Used by account-switch so an in-flight `syncNow()` can't race with the
 * new account's hydration. WS reconnect is handled by the caller.
 */
export function pauseSyncTimer(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Restart the periodic `syncPrs()` timer. Idempotent — clears any existing
 * interval first.
 */
export function resumeSyncTimer(intervalSeconds: number): void {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(() => {
    syncPrs().catch(() => {
      // errors arrive via WebSocket
    });
  }, intervalSeconds * 1000);
}
