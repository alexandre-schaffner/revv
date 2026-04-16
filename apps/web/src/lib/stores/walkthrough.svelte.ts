import type { WalkthroughBlock, RiskLevel, WalkthroughStreamEvent, WalkthroughIssue, WalkthroughPhase } from '@rev/shared';
import { API_BASE_URL } from '@rev/shared';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';

let blocks = $state<WalkthroughBlock[]>([]);
let summary = $state<string | null>(null);
let riskLevel = $state<RiskLevel>('low');
let isStreaming = $state(false);
let streamError = $state<string | null>(null);
let walkthroughId = $state<string | null>(null);
let doneReceived = $state(false);
let explorationSteps = $state<Array<{ tool: string; description: string }>>([]);
let issues = $state<WalkthroughIssue[]>([]);
let currentPrId = $state<string | null>(null);
let phase = $state<WalkthroughPhase>('connecting');
let phaseMessage = $state<string>('Connecting...');
let streamStartedAt = $state<number | null>(null);
let abortController: AbortController | null = null;
let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

export function getBlocks(): WalkthroughBlock[] {
	return blocks;
}
export function getSummary(): string | null {
	return summary;
}
export function getRiskLevel(): RiskLevel {
	return riskLevel;
}
export function getIsStreaming(): boolean {
	return isStreaming;
}
export function getStreamError(): string | null {
	return streamError;
}
export function getWalkthroughId(): string | null {
	return walkthroughId;
}
export function getExplorationSteps(): Array<{ tool: string; description: string }> {
	return explorationSteps;
}

export function getIssues(): WalkthroughIssue[] {
	return issues;
}
export function getPhase(): WalkthroughPhase {
	return phase;
}
export function getPhaseMessage(): string {
	return phaseMessage;
}
export function getStreamStartedAt(): number | null {
	return streamStartedAt;
}

export async function streamWalkthrough(prId: string): Promise<void> {
	// Already streaming this PR — let it continue
	if (isStreaming && currentPrId === prId) return;
	if (summary !== null && blocks.length > 0 && !isStreaming && currentPrId === prId) return;

	abort();
	blocks = [];
	summary = null;
	riskLevel = 'low';
	streamError = null;
	isStreaming = true;
	walkthroughId = null;
	doneReceived = false;
	explorationSteps = [];
	issues = [];
	currentPrId = prId;
	phase = 'connecting';
	phaseMessage = 'Connecting...';
	streamStartedAt = Date.now();

	abortController = new AbortController();

	try {
		const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough`, {
			headers: authHeaders(),
			signal: abortController.signal,
		});
		if (!res.ok || !res.body) {
			const text = await res.text().catch(() => '');
			let message = `HTTP ${res.status}`;
			try {
				const body = JSON.parse(text);
				message = body.message ?? body.error ?? message;
			} catch { /* use default */ }
			throw new Error(message);
		}

		const reader = res.body.getReader();
		currentReader = reader;
		const decoder = new TextDecoder();
		let buffer = '';

		// Safety net: if no real events arrive for 3 minutes (only heartbeat
		// pings), something is hung — abort rather than spin the skeleton forever.
		const INACTIVITY_TIMEOUT_MS = 90 * 1000; // 90 seconds
		let lastEventTime = Date.now();

		// Separate tracker for meaningful progress (non-exploration events).
		// Exploration events alone don't constitute progress — the model can
		// read files indefinitely without ever producing a summary or blocks.
		// If only exploration events arrive for EXPLORATION_STALL_MS, abort.
		const EXPLORATION_STALL_MS = 3 * 60 * 1000;
		let lastProgressEventTime = Date.now();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer);
			buffer = result.remaining;

			// Apply all events from this chunk in one batch
			if (result.events.length > 0) {
				lastEventTime = Date.now();

				// Check for meaningful progress (anything that isn't just exploration)
				const hasProgress = result.events.some(e => e.type !== 'exploration');
				if (hasProgress) {
					lastProgressEventTime = Date.now();
				} else if (Date.now() - lastProgressEventTime > EXPLORATION_STALL_MS) {
					throw new Error('Walkthrough stalled — the model explored files for 3 minutes without producing output. Try regenerating.');
				}

				applyEvents(result.events);
			} else if (Date.now() - lastEventTime > INACTIVITY_TIMEOUT_MS) {
				throw new Error('Walkthrough generation appears stuck — no progress for 3 minutes. Try regenerating.');
			}

			// Respect the SSE [DONE] signal instead of waiting for TCP close
			if (result.done) break;
		}

		// Process any remaining buffer after stream ends
		if (buffer.trim()) {
			const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer + '\n\n');
			if (result.events.length > 0) {
				applyEvents(result.events);
			}
		}
	} catch (e) {
		if ((e as Error).name !== 'AbortError') {
			streamError = e instanceof Error ? e.message : 'Stream failed';
		}
	} finally {
		// If the stream ended but we never received a terminal event (done/error),
		// the generator exited silently. Surface this as an error rather than
		// leaving the UI in a blank state.
		if (isStreaming && !doneReceived && !streamError) {
			streamError = 'Walkthrough generation ended unexpectedly. Try regenerating.';
		}
		isStreaming = false;
		abortController = null;
		currentReader = null;
	}
}

function applyEvents(events: WalkthroughStreamEvent[]): void {
	let newBlocks: WalkthroughBlock[] | null = null;

	for (const event of events) {
		switch (event.type) {
			case 'summary':
				summary = event.data.summary;
				riskLevel = event.data.riskLevel;
				break;
			case 'block':
				if (!newBlocks) newBlocks = [...blocks];
				newBlocks.push(event.data);
				break;
			case 'done':
				walkthroughId = event.data.walkthroughId;
				doneReceived = true;
				isStreaming = false;
				break;
			case 'exploration':
				explorationSteps = [...explorationSteps, event.data];
				break;
			case 'issue':
				issues = [...issues, event.data];
				break;
			case 'phase':
				phase = event.data.phase;
				phaseMessage = event.data.message;
				break;
			case 'error':
				streamError = event.data.message;
				isStreaming = false;
				break;
		}
	}

	// Single array mutation for all blocks in this chunk
	if (newBlocks) {
		blocks = newBlocks;
	}
}

export function abort(): void {
	// Cancel the reader first to release its lock on the stream,
	// then abort the fetch controller
	currentReader?.cancel().catch(() => {});
	currentReader = null;
	abortController?.abort();
	abortController = null;
	isStreaming = false;
}

export async function regenerate(prId: string): Promise<void> {
	await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/regenerate`, {
		method: 'POST',
		headers: authHeaders(),
	});
	reset();
	await streamWalkthrough(prId);
}

export function reset(): void {
	abort();
	blocks = [];
	summary = null;
	riskLevel = 'low';
	streamError = null;
	walkthroughId = null;
	doneReceived = false;
	explorationSteps = [];
	issues = [];
	currentPrId = null;
	phase = 'connecting';
	phaseMessage = 'Connecting...';
	streamStartedAt = null;
}
