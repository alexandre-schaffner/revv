import * as prs from '$lib/stores/prs.svelte';
import * as ws from '$lib/stores/ws.svelte';

let pollingInterval: ReturnType<typeof setInterval> | null = null;

export function startPolling(intervalSeconds: number, token: string): void {
	// Connect WebSocket for real-time updates
	ws.connect(token);

	// Fetch initial data
	Promise.all([prs.fetchPrs(), prs.fetchRepos()]).catch(() => {
		// errors handled by stores
	});

	// Set up polling
	if (pollingInterval) clearInterval(pollingInterval);
	pollingInterval = setInterval(() => {
		prs.syncPrs().catch(() => {
			// errors arrive via WebSocket
		});
	}, intervalSeconds * 1000);
}

export function stopPolling(): void {
	if (pollingInterval) {
		clearInterval(pollingInterval);
		pollingInterval = null;
	}
	ws.disconnect();
}
