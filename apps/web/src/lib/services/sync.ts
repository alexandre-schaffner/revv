import {
  connect as connectEvents,
  disconnect as disconnectEvents,
} from "$lib/stores/events.svelte";
import { fetchPinnedPrs, fetchPrs, fetchRepos, syncPrs } from "$lib/stores/prs.svelte";
import { getSettings } from "$lib/stores/settings.svelte";

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(intervalMinutes: number, token: string): void {
  // Connect the global SSE stream for realtime events. Without this the
  // browser never opens `/api/events`, so `Broadcaster.broadcastToAccount`
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
  if (intervalMinutes <= 0) {
    pollingInterval = null;
    return;
  }
  pollingInterval = setInterval(
    () => {
      syncPrs().catch(() => {
        // errors arrive via SSE
      });
    },
    intervalMinutes * 60 * 1000,
  );
}

export function stopPolling(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  disconnectEvents();
}

function pauseSyncTimer(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function resumeSyncTimer(intervalMinutes: number): void {
  if (pollingInterval) clearInterval(pollingInterval);
  if (intervalMinutes <= 0) {
    pollingInterval = null;
    return;
  }
  pollingInterval = setInterval(
    () => {
      syncPrs().catch(() => {
        // errors arrive via SSE
      });
    },
    intervalMinutes * 60 * 1000,
  );
}

/**
 * Run `fn` with the background sync timer suspended, then resume it at the
 * cadence the current settings prefer. Used by account switch so an in-flight
 * `syncPrs()` can't race with the new account's hydration.
 */
export async function withSyncSuspended<T>(fn: () => Promise<T>): Promise<T> {
  pauseSyncTimer();
  try {
    return await fn();
  } finally {
    resumeSyncTimer(getSettings()?.autoFetchInterval ?? 5);
  }
}
