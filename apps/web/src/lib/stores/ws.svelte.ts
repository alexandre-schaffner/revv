import type { WsServerMessage } from '@rev/shared';
import { API_BASE_URL } from '@rev/shared';
import * as prs from './prs.svelte';
import * as errors from './errors.svelte';
import {
	addThreadFromWs,
	updateThreadStatusFromWs,
	addMessageFromWs,
} from './review.svelte';

let ws: WebSocket | null = null;
let connected = $state(false);
let reconnectAttempts = $state(0);
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_RECONNECT_DELAY_MS = 30_000;

function getReconnectDelay(): number {
	return Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
}

function handleMessage(msg: WsServerMessage): void {
	switch (msg.type) {
		case 'prs:updated':
			prs.setPullRequests(msg.data);
			break;
		case 'prs:sync-started':
			// prs.isLoading handled via store
			break;
		case 'prs:sync-complete':
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
