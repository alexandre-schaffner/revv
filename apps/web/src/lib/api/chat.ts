// ── Chat API ────────────────────────────────────────────────────────────────
//
// Right-pane AI chat HTTP/SSE client. Mirrors the explain client's shape but
// posts a JSON body and surfaces typed frames (`{kind: 'text' | 'tool', data}`)
// so the chat panel can render tool-use entries inline between messages.

import { API_BASE_URL } from '$lib/api/base-url';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';

export type ChatStreamFrame =
	| { kind: 'text'; data: string }
	| { kind: 'tool'; data: string };

export interface ChatRequestParams {
	prId: string;
	message: string;
}

export interface ChatCallbacks {
	onText: (chunk: string) => void;
	onTool: (description: string) => void;
	onDone: () => void;
	onError: (error: { code: string; message: string }) => void;
}

/**
 * Open a streaming chat turn. Returns an AbortController so the caller can
 * cancel mid-stream (e.g. when the user sends a new message before the
 * previous one finishes).
 */
export function streamChatMessage(
	params: ChatRequestParams,
	callbacks: ChatCallbacks,
): AbortController {
	const controller = new AbortController();

	fetch(`${API_BASE_URL}/api/chat`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...authHeaders(),
		},
		body: JSON.stringify({
			prId: params.prId,
			message: params.message,
		}),
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

				const result = parseSSEBuffer<ChatStreamFrame>(buffer);
				buffer = result.remaining;

				if (result.error) {
					callbacks.onError(result.error);
					gotError = true;
					continue;
				}

				for (const frame of result.events) {
					if (frame.kind === 'text') {
						callbacks.onText(frame.data);
					} else if (frame.kind === 'tool') {
						callbacks.onTool(frame.data);
					}
				}

				if (result.done) {
					callbacks.onDone();
					return;
				}
			}

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

/** Clear the agent-side session and worktree+branch for this PR's chat. */
export async function clearChat(prId: string): Promise<void> {
	const res = await fetch(`${API_BASE_URL}/api/chat/${prId}`, {
		method: 'DELETE',
		headers: authHeaders(),
	});
	if (!res.ok && res.status !== 204) {
		throw new Error(`Failed to clear chat: ${res.status}`);
	}
}

export interface ProposedCommit {
	sha: string;
	shortSha: string;
	subject: string;
	committedAt: string;
	files: string[];
}

export interface ProposedChanges {
	branchName: string | null;
	prHeadSha: string | null;
	commits: ProposedCommit[];
}

/** Fetch the list of commits the agent has made on top of the PR's head SHA. */
export async function fetchProposedChanges(prId: string): Promise<ProposedChanges> {
	const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/proposed-changes`, {
		headers: authHeaders(),
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch proposed changes: ${res.status}`);
	}
	return (await res.json()) as ProposedChanges;
}

/** Fetch the unified diff for a single proposed-changes commit. */
export async function fetchProposedDiff(
	prId: string,
	sha: string,
): Promise<string> {
	const res = await fetch(
		`${API_BASE_URL}/api/chat/${prId}/proposed-changes/${sha}/diff`,
		{ headers: authHeaders() },
	);
	if (!res.ok) {
		throw new Error(`Failed to fetch diff for ${sha}: ${res.status}`);
	}
	return await res.text();
}
