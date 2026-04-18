import type { WsServerMessage, SyncChange } from '@revv/shared';
import { API_BASE_URL } from '@revv/shared';
import { toast } from 'svelte-sonner';
import * as prs from './prs.svelte';
import { getSelectedPrId, mergePullRequests } from './prs.svelte';
import * as errors from './errors.svelte';
import * as sync from './sync.svelte';
import { resetForSync } from './sync.svelte';
import {
	addThreadFromWs,
	updateThreadStatusFromWs,
	addMessageFromWs,
	removeThreadFromWs,
	updateMessageFromWs,
	loadSession,
} from './review.svelte';
import {
	onWalkthroughComplete,
	onWalkthroughError,
	prefetchWalkthrough,
} from './walkthrough.svelte';

let ws: WebSocket | null = null;
let connected = $state(false);
let reconnectAttempts = $state(0);
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pendingThreadSync: string | null = null;

const MAX_RECONNECT_DELAY_MS = 30_000;

function getReconnectDelay(): number {
	return Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
}

function notifySyncChanges(changes: SyncChange[]): void {
	if (changes.length === 0) return;
	if (changes.length > 3) {
		toast.info(`${changes.length} pull request updates`);
		// Skip per-PR prefetching when many changes arrive at once to avoid
		// saturating the SSE connection pool (capped at MAX_CONCURRENT_STREAMS).
		return;
	}
	for (const change of changes) {
		const description = `${change.repoFullName} #${change.prNumber}: ${change.prTitle}`;
		switch (change.kind) {
			case 'review_requested':
				toast.info('Review requested', { description });
				void prefetchWalkthrough(change.prId);
				break;
			case 'pr_updated':
				toast.info('PR updated', { description });
				break;
			case 'pr_closed':
				toast.info('PR closed', { description });
				break;
			case 'pr_authored':
				toast.info('Your new PR', { description });
				break;
		}
	}
}

function handleMessage(msg: WsServerMessage): void {
	switch (msg.type) {
		case 'prs:updated':
			mergePullRequests(msg.data);
			break;
		case 'prs:sync-started':
			sync.setSyncing(true);
			break;
		case 'prs:sync-complete':
			sync.setSyncing(false);
			break;
		case 'repos:updated':
			prs.setRepositories(msg.data);
			break;
		case 'repos:clone-status':
			prs.updateRepoCloneStatus(msg.data.repoId, msg.data.status, msg.data.error);
			break;
		case 'error':
			errors.setError(msg.data);
			break;
		case 'thread:created':
			addThreadFromWs(msg.data.thread, msg.data.message);
			break;
		case 'thread:updated':
			updateThreadStatusFromWs(msg.data.threadId, msg.data.status);
			break;
		case 'thread:message':
			addMessageFromWs(msg.data.threadId, msg.data.message);
			break;
		case 'thread:deleted':
			removeThreadFromWs(msg.data.threadId);
			break;
		case 'thread:message:edited':
			updateMessageFromWs(msg.data.threadId, msg.data.message);
			break;
		case 'threads:synced':
			sync.applySynced(msg.data.prId, msg.data.summary, msg.data.timestamp);
			if (msg.data.prId === getSelectedPrId()) {
				void loadSession(msg.data.prId);
			}
			break;
		case 'threads:sync-error':
			console.error('[ws] Thread sync error for PR', msg.data.prId, msg.data.message);
			sync.setSyncing(false);
			sync.setSyncError(msg.data.message);
			toast.error('Failed to sync comments from GitHub', {
				description: 'Check your connection or try re-authenticating.',
				duration: 6000,
			});
			break;
		case 'threads:new-reply':
			addThreadFromWs(msg.data.thread, msg.data.message);
			break;
		case 'walkthrough:complete':
			onWalkthroughComplete(msg.data.prId, msg.data.walkthroughId);
			break;
		case 'walkthrough:error':
			onWalkthroughError(msg.data.prId, msg.data.message);
			break;
		case 'prs:sync-summary':
			notifySyncChanges(msg.data);
			break;
		case 'cache:invalidated':
			break;
	}
}

export function connect(token: string): void {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

	const wsUrl = API_BASE_URL.replace(/^http/, 'ws');
	ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`);

	ws.addEventListener('open', () => {
		connected = true;
		reconnectAttempts = 0;
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		// Flush any pending thread sync requested before connection was ready
		if (pendingThreadSync) {
			const prId = pendingThreadSync;
			pendingThreadSync = null;
			resetForSync();
			ws?.send(JSON.stringify({ type: 'threads:request-sync', data: { prId } }));
		}
	});

	ws.addEventListener('close', () => {
		connected = false;
		ws = null;
		scheduleReconnect(token);
	});

	ws.addEventListener('error', () => {
		// close event will fire next, which handles reconnect
	});

	ws.addEventListener('message', (event) => {
		try {
			const msg = JSON.parse(event.data as string) as WsServerMessage;
			handleMessage(msg);
		} catch {
			// ignore malformed messages
		}
	});
}

function scheduleReconnect(token: string): void {
	const delay = getReconnectDelay();
	reconnectAttempts += 1;
	reconnectTimer = setTimeout(() => {
		connect(token);
	}, delay);
}

export function requestSync(): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: 'prs:request-sync' }));
	}
}

export function requestThreadSync(prId: string): void {
	resetForSync();
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: 'threads:request-sync', data: { prId } }));
	} else {
		// WS not ready yet — queue it to be sent on connect
		pendingThreadSync = prId;
	}
}

export function requestFullSync(prId: string): void {
	resetForSync();
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: 'prs:request-sync' }));
		ws.send(JSON.stringify({ type: 'threads:request-sync', data: { prId } }));
	} else {
		pendingThreadSync = prId;
	}
}

export function disconnect(): void {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	ws?.close(1000, 'Client disconnecting');
	ws = null;
	connected = false;
	reconnectAttempts = 0;
}

export function getConnected(): boolean {
	return connected;
}

export function getReconnectAttempts(): number {
	return reconnectAttempts;
}
