import { API_BASE_URL } from '@revv/shared';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';

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

	const queryParams = new URLSearchParams({
		prId: params.prId,
		filePath: params.filePath,
		startLine: String(params.startLine),
		endLine: String(params.endLine),
		codeSnippet: params.codeSnippet,
	});

	fetch(`${API_BASE_URL}/api/explain?${queryParams.toString()}`, {
		headers: authHeaders(),
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

				const result = parseSSEBuffer<string>(buffer);
				buffer = result.remaining;

				if (result.error) {
					callbacks.onError(result.error);
					gotError = true;
					continue;
				}

				for (const text of result.events) {
					callbacks.onChunk(text);
				}

				if (result.done) {
					callbacks.onDone();
					return;
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
