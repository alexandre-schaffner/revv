/**
 * Result of parsing SSE frames from a buffer.
 */
export interface SSEParseResult<T> {
	/** Successfully parsed events. */
	events: T[];
	/** Incomplete data left in the buffer (not yet terminated by \n\n). */
	remaining: string;
	/** Whether a `data: [DONE]` frame was encountered. */
	done: boolean;
	/** If an `event: error` frame was found, the parsed error payload. */
	error?: { code: string; message: string } | undefined;
}

/**
 * Parse SSE frames from a text buffer.
 *
 * Splits on double-newline boundaries, extracts `data:` and `event:` lines,
 * and returns parsed events plus any incomplete trailing data.
 *
 * @param buffer - The accumulated text buffer (may contain partial frames).
 * @param parse  - Optional custom parser; defaults to JSON.parse. Return null to skip an event.
 */
export function parseSSEBuffer<T>(
	buffer: string,
	parse: (raw: string) => T | null = (r) => JSON.parse(r) as T
): SSEParseResult<T> {
	const parts = buffer.split('\n\n');
	// Last element is an incomplete frame — keep it in the buffer
	const remaining = parts.pop() ?? '';
	const events: T[] = [];
	let done = false;
	let error: { code: string; message: string } | undefined;

	for (const part of parts) {
		// Skip SSE comments (lines starting with ':')
		if (part.startsWith(':')) continue;

		const lines = part.split('\n');

		// Check for error event
		const eventLine = lines.find((l) => l.startsWith('event: '));
		if (eventLine?.slice(7) === 'error') {
			const dataLine = lines.find((l) => l.startsWith('data: '));
			if (dataLine) {
				try {
					error = JSON.parse(dataLine.slice(6)) as { code: string; message: string };
				} catch {
					error = { code: 'PARSE_ERROR', message: 'Failed to parse error' };
				}
			}
			continue;
		}

		// Regular data events
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const payload = line.slice(6);
			if (payload === '[DONE]') {
				done = true;
				continue;
			}
			try {
				const parsed = parse(payload);
				if (parsed !== null) events.push(parsed);
			} catch {
				// Skip malformed data lines
			}
		}
	}

	return { events, remaining, done, error };
}
