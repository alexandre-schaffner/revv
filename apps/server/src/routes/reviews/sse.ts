/**
 * SSE stream helper — produces a {@link ReadableStream} and a writer object
 * with ergonomic methods for the patterns we use in the walkthrough handler.
 *
 * The old inline implementation scattered `controller.enqueue(encoder.encode(...))`
 * calls and try/catch blocks across 370 lines of handler. Factoring it into a
 * small writer surface cleans up the handler to read as a linear story of
 * "resolve context → ensure worktree → build generator → iterate events".
 *
 * Design notes:
 *  - `start()` captures the controller synchronously so the handler can return
 *    the Response immediately while generation runs in the background.
 *  - `close()` is idempotent. It's called from the finally block and also in
 *    error paths, so swallowing the "already closed" error is intentional.
 *  - `send*()` methods return `false` if the client has disconnected. Callers
 *    use this signal to fall back to "keep generating, stop streaming."
 *  - Heartbeats prevent proxies and Tauri webviews from timing out long-lived
 *    SSE connections during git clone (10–30s) and AI streaming (minutes).
 */

const encoder = new TextEncoder();

export interface SseWriter {
	/** Send a typed SSE `data:` payload. Returns false if the client is gone. */
	send: (event: unknown) => boolean;
	/** Shortcut for emitting a `{ type: 'phase', data: { phase, message } }` event. */
	sendPhase: (phase: string, message: string) => boolean;
	/** Send a terminal `data: [DONE]` marker and close the stream. */
	sendDone: () => void;
	/** Close the controller. Safe to call multiple times. */
	close: () => void;
	/** True once the client has disconnected (cancel() or enqueue threw). */
	isCancelled: () => boolean;
}

export interface SseStream {
	stream: ReadableStream<Uint8Array>;
	writer: SseWriter;
	/** Stops the heartbeat interval. Call from the finally block of the handler. */
	stopHeartbeat: () => void;
	/**
	 * Register a callback that fires once when the client disconnects OR the
	 * writer is closed. Useful for unsubscribing from long-lived pub/sub
	 * sources (e.g. {@link WalkthroughJobs.subscribe}) without polling
	 * `isCancelled()` from a timer. Safe to register multiple callbacks; they
	 * all fire in registration order and each runs at most once.
	 */
	onCancel: (fn: () => void) => void;
}

/**
 * Create an SSE stream + writer pair, wired up with a 15-second heartbeat
 * (`: ping` comment) to prevent proxy and webview timeouts.
 */
export function createSseStream(heartbeatIntervalMs = 15_000): SseStream {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const cancelCallbacks: Array<() => void> = [];

	const fireCancelCallbacks = () => {
		// Drain the queue so repeat close/cancel calls don't double-fire.
		while (cancelCallbacks.length > 0) {
			const fn = cancelCallbacks.shift();
			if (!fn) continue;
			try {
				fn();
			} catch {
				// Swallow — a misbehaving cleanup hook shouldn't poison siblings.
			}
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel() {
			cancelled = true;
			fireCancelCallbacks();
		},
	});

	const tryEnqueue = (bytes: Uint8Array): boolean => {
		if (cancelled) return false;
		try {
			controller.enqueue(bytes);
			return true;
		} catch {
			// Controller closed or client disconnected
			cancelled = true;
			fireCancelCallbacks();
			return false;
		}
	};

	const writer: SseWriter = {
		send: (event) => tryEnqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
		sendPhase: (phase, message) =>
			tryEnqueue(encoder.encode(`data: ${JSON.stringify({ type: 'phase', data: { phase, message } })}\n\n`)),
		sendDone: () => {
			tryEnqueue(encoder.encode('data: [DONE]\n\n'));
			writer.close();
		},
		close: () => {
			cancelled = true;
			try {
				controller.close();
			} catch {
				// Already closed — fine
			}
			fireCancelCallbacks();
		},
		isCancelled: () => cancelled,
	};

	// Keep the connection alive through slow phases (git clone, AI latency).
	const heartbeat = setInterval(() => {
		tryEnqueue(encoder.encode(': ping\n\n'));
	}, heartbeatIntervalMs);

	return {
		stream,
		writer,
		stopHeartbeat: () => clearInterval(heartbeat),
		onCancel: (fn) => {
			// Late registration after disconnect should still run the hook
			// so callers don't accidentally leak subscriptions.
			if (cancelled) {
				try {
					fn();
				} catch {
					/* ignore */
				}
				return;
			}
			cancelCallbacks.push(fn);
		},
	};
}

/** Standard headers for an SSE response. */
export const sseHeaders = {
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive',
} as const;
