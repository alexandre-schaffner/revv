import {
  connect as connectEvents,
  disconnect as disconnectEvents,
} from "$lib/stores/events.svelte";
import { fetchPinnedPrs, fetchPrs, fetchRepos, syncPrs } from "$lib/stores/prs.svelte";
import { getSettings } from "$lib/stores/settings.svelte";

let pollingInterval: ReturnType<typeof setInterval> | null = null;
/** Set by `startPolling`, cleared by `stopPolling`: a signed-out app never polls. */
let pollingStarted = false;

export function startPolling(intervalMinutes: number, token: string): void {
  pollingStarted = true;
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

  resumeSyncTimer(intervalMinutes);
}

export function stopPolling(): void {
  pollingStarted = false;
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  disconnectEvents();
}

/**
 * Re-arm the background sync timer at a new cadence, e.g. after the user
 * changes the refresh interval in Settings. A no-op until `startPolling` has
 * run, so changing the setting while signed out doesn't start syncing.
 */
export function restartPolling(intervalMinutes: number): void {
  if (!pollingStarted) return;
  resumeSyncTimer(intervalMinutes);
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
