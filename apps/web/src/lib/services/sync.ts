import { fetchPinnedPrs, fetchPrs, fetchRepos, syncPrs } from "$lib/stores/prs.svelte";
import { connect, disconnect } from "$lib/stores/ws.svelte";

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(intervalSeconds: number, token: string): void {
  // Connect WebSocket for real-time updates
  connect(token);

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
}
