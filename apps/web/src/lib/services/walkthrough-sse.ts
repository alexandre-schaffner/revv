import type { WalkthroughStreamEvent } from '@revv/shared';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';

/**
 * No-bytes inactivity timeout — the stream is considered dead.
 *
 * The server emits `: ping` heartbeats every 15s, so this only fires when the
 * transport itself is dead (connection closed silently, network gone). Real
 * "agent stalled" cases are detected server-side and arrive as structured
 * `error` events.
 */
const INACTIVITY_TIMEOUT_MS = 90 * 1000;

/** Exploration-only stall timeout — AI explored files but produced no output. */
const EXPLORATION_STALL_MS = 3 * 60 * 1000;

export interface RunWalkthroughSseOptions {
	/** Absolute URL to the SSE endpoint. */
	readonly url: string;
	/** AbortSignal to wire into the underlying `fetch`. */
	readonly signal: AbortSignal;
	/** Fires once the HTTP body reader is available, so callers can track it for cancellation. */
	readonly onReaderReady?: (reader: ReadableStreamDefaultReader<Uint8Array>) => void;
	/** Fires for every batch of parsed SSE events. Callers apply them to store state. */
	readonly onEvents: (events: WalkthroughStreamEvent[]) => void;
	/** Override for the exploration-stall error message (default: generic). */
	readonly explorationStallMessage?: string;
	/** Override for the inactivity-timeout error message (default: generic). */
	readonly inactivityMessage?: string;
}

/**
 * Run a walkthrough SSE connection end-to-end.
 *
 * Owns the fetch, body reader, decode buffer, SSE parser loop, and the two
 * stall/timeout guards. Callers supply just the URL, AbortSignal, and an
 * `onEvents` callback to apply parsed events to their store.
 *
 * Replaces ~100 lines of duplicated SSE plumbing that previously lived in
 * both `streamWalkthrough` and `prefetchWalkthrough`. Each caller now only
 * owns its own lifecycle concerns (UI toasts, controller bookkeeping,
 * activePrId switching, etc.), not the wire protocol.
 *
 * Throws:
 *  - `Error(HTTP nnn)` on non-2xx response (extracts JSON `message`/`error`
 *    from the response body when available)
 *  - `Error(explorationStallMessage)` if only exploration events arrive for
 *    3+ minutes
 *  - `Error(inactivityMessage)` if no events arrive for 90+ seconds
 *  - `AbortError` when the signal is aborted (caller must ignore this)
 */
export async function runWalkthroughSse(opts: RunWalkthroughSseOptions): Promise<void> {
	const res = await fetch(opts.url, {
		headers: authHeaders(),
		signal: opts.signal,
	});

	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => '');
		let message = `HTTP ${res.status}`;
		try {
			const body = JSON.parse(text);
			message = body.message ?? body.error ?? message;
		} catch {
			/* use default */
		}
		throw new Error(message);
	}

	const reader = res.body.getReader();
	opts.onReaderReady?.(reader);
	const decoder = new TextDecoder();
	let buffer = '';

	let lastEventTime = Date.now();
	let lastProgressEventTime = Date.now();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		// Any bytes from the server — including `: ping` heartbeats that the SSE
		// parser strips as comments — prove the transport is alive. Reset the
		// inactivity timer here so the 90s guard only fires on a genuinely dead
		// connection. Real "agent stalled" detection lives on the server
		// (WALKTHROUGH_INACTIVITY_TIMEOUT_MS + stream-guard) and arrives as a
		// structured `error` event.
		if (value && value.byteLength > 0) {
			lastEventTime = Date.now();
		}

		buffer += decoder.decode(value, { stream: true });

		const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer);
		buffer = result.remaining;

		if (result.events.length > 0) {
			const hasProgress = result.events.some((e) => e.type !== 'exploration');
			if (hasProgress) {
				lastProgressEventTime = Date.now();
			} else if (Date.now() - lastProgressEventTime > EXPLORATION_STALL_MS) {
				throw new Error(
					opts.explorationStallMessage ??
						'Walkthrough stalled — the model explored files without producing output.',
				);
			}

			opts.onEvents(result.events);
		} else if (Date.now() - lastEventTime > INACTIVITY_TIMEOUT_MS) {
			// Reachable only if even heartbeats have stopped — the connection is
			// dead, not just the model thinking.
			throw new Error(
				opts.inactivityMessage ??
					'Walkthrough connection lost — no data from server for 90 seconds.',
			);
		}

		if (result.done) break;
	}

	// Flush any trailing partial event left in the buffer on clean close.
	if (buffer.trim()) {
		const result = parseSSEBuffer<WalkthroughStreamEvent>(buffer + '\n\n');
		if (result.events.length > 0) {
			opts.onEvents(result.events);
		}
	}
}
