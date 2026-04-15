import { API_BASE_URL } from '@rev/shared';

export interface ExplainRequestParams {
	prId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	codeSnippet: string;
}

export interface ExplainCallbacks {
	onChunk: (text: string) => void;
	onDone: () => void;
	onError: (error: { code: string; message: string }) => void;
}

/**
 * Opens an SSE connection to the /api/explain endpoint and streams
 * AI explanation chunks. Returns an AbortController for cancellation.
 */
export function streamExplanation(
	params: ExplainRequestParams,
	callbacks: ExplainCallbacks
): AbortController {
	const controller = new AbortController();
	const token =
		typeof localStorage !== 'undefined' ? (localStorage.getItem('rev_session_token') ?? '') : '';

	const queryParams = new URLSearchParams({
		prId: params.prId,
		filePath: params.filePath,
		startLine: String(params.startLine),
		endLine: String(params.endLine),
		codeSnippet: params.codeSnippet,
	});

	fetch(`${API_BASE_URL}/api/explain?${queryParams.toString()}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
		signal: controller.signal,
	})
		.then(async (res) => {
			if (!res.ok) {
				const body = await res
					.json()
					.catch(() => ({ code: 'UNKNOWN', message: res.statusText }));
				callbacks.onError(body as { code: string; message: string });
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				callbacks.onError({ code: 'NO_BODY', message: 'No response body' });
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let gotError = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE frames from the buffer
				const parts = buffer.split('\n\n');
				// Last element is incomplete — keep it in the buffer
				buffer = parts.pop() ?? '';

				for (const part of parts) {
					const lines = part.split('\n');

					// Check for error event
					const eventLine = lines.find((l) => l.startsWith('event: '));
					if (eventLine?.slice(7) === 'error') {
						const dataLine = lines.find((l) => l.startsWith('data: '));
						if (dataLine) {
							try {
								const errData = JSON.parse(dataLine.slice(6)) as {
									code: string;
									message: string;
								};
								callbacks.onError(errData);
								gotError = true;
							} catch {
								callbacks.onError({
									code: 'PARSE_ERROR',
									message: 'Failed to parse error',
								});
								gotError = true;
							}
						}
						continue;
					}

					// Regular data event
					for (const line of lines) {
						if (!line.startsWith('data: ')) continue;
						const payload = line.slice(6);
						if (payload === '[DONE]') {
							callbacks.onDone();
							return;
						}
						try {
							const text = JSON.parse(payload) as string;
							callbacks.onChunk(text);
						} catch {
							// Skip malformed data lines
						}
					}
				}
			}

			// Stream ended without [DONE] and no error — treat as done
			if (!gotError) {
				callbacks.onDone();
			}
		})
		.catch((err: Error) => {
			if (err.name !== 'AbortError') {
				callbacks.onError({ code: 'NETWORK_ERROR', message: err.message });
			}
		});

	return controller;
}
