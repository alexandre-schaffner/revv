// ── Chat API ────────────────────────────────────────────────────────────────
//
// Right-pane AI chat HTTP/SSE client. Surfaces typed frames
// (`{kind: 'text' | 'activity', ...}`) so the chat panel can render rich
// activity entries inline between messages.
//
// History reload (gap A1) — `fetchChatMessages(prId)` pulls the persisted
// timeline (messages + activities, ordered by sequence) so the panel hydrates
// from SQLite on mount instead of starting empty after a desktop reload.

import type { Activity, ActivityKind } from '@revv/shared';
import { API_BASE_URL } from '$lib/api/base-url';
import { authHeaders } from '$lib/utils/session-token';
import { parseSSEBuffer } from '$lib/utils/sse-parser';

// Re-export the canonical activity types so existing call sites in stores
// and components can keep importing from `$lib/api/chat`.
export type { Activity, ActivityKind };

export type ChatStreamFrame =
	| { kind: 'text'; data: string }
	| ({ kind: 'activity' } & Activity);

export interface ChatRequestParams {
	prId: string;
	message: string;
}

export interface ChatCallbacks {
	onText: (chunk: string) => void;
	onActivity: (activity: Activity) => void;
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
					} else if (frame.kind === 'activity') {
						callbacks.onActivity({
							activityKind: frame.activityKind,
							toolName: frame.toolName,
							summary: frame.summary,
							payload: frame.payload,
						});
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

// ── History reload ────────────────────────────────────────────────────────

export interface PersistedChatMessage {
	entryKind: 'message';
	id: string;
	chatSessionId: string;
	role: 'user' | 'assistant';
	content: string;
	isStreaming: boolean;
	sequence: number;
	turnId: string;
	error: string | null;
	createdAt: string;
	finalizedAt: string | null;
}

export interface PersistedChatActivity {
	entryKind: 'activity';
	id: string;
	chatSessionId: string;
	turnId: string;
	activityKind: string;
	toolName: string | null;
	summary: string;
	payloadJson: string | null;
	sequence: number;
	createdAt: string;
}

export type PersistedChatEntry = PersistedChatMessage | PersistedChatActivity;

export interface ChatTimeline {
	chatSessionId: string | null;
	entries: PersistedChatEntry[];
}

/** Fetch the persisted timeline for a PR's current head-SHA chat session. */
export async function fetchChatMessages(prId: string): Promise<ChatTimeline> {
	const res = await fetch(`${API_BASE_URL}/api/chat/${prId}/messages`, {
		headers: authHeaders(),
	});
	if (!res.ok) {
		throw new Error(`Failed to fetch chat messages: ${res.status}`);
	}
	return (await res.json()) as ChatTimeline;
}

// ── Proposed changes ──────────────────────────────────────────────────────

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

// ── Merge & push ──────────────────────────────────────────────────────────

export type MergePushResult =
	| {
			status: 'pushed';
			newSha: string;
			pushedCommits: number;
			branch: string;
	  }
	| { status: 'conflict'; files: string[]; branch: string }
	| { status: 'remote-changed'; branch: string }
	| { status: 'ref-exists'; branch: string };

export interface MergePushError {
	code:
		| 'CONCURRENT_PUSH'
		| 'CHAT_STREAMING'
		| 'DIRTY_WORKTREE'
		| 'NO_CHANGES'
		| 'NO_CHAT_SESSION'
		| 'PUSH_REJECTED'
		| 'INVALID_BRANCH_NAME'
		| 'REF_EXISTS'
		| 'GENERIC_ERROR';
	message: string;
}

export interface PushProposedOptions {
	/** Push the agent's commits to a brand-new branch instead of merging into the PR's source branch. */
	newBranchName?: string;
	/** When `newBranchName` is set: force-push (overwrite an existing remote ref). Ignored otherwise. */
	force?: boolean;
}

/**
 * Attempt to merge the agent's local commits into the PR's source branch
 * and push. Returns a tagged result on success-ish outcomes (including
 * conflict + remote-changed); throws a structured MergePushError on hard
 * failures.
 *
 * When `options.newBranchName` is provided the server bypasses the merge
 * step and pushes the agent's local branch as-is to that new ref. If the
 * ref already exists remotely, the result is `{ status: 'ref-exists' }` so
 * the caller can confirm overwrite and retry with `force: true`.
 */
export async function pushProposedChanges(
	prId: string,
	options?: PushProposedOptions,
): Promise<MergePushResult> {
	const headers: Record<string, string> = { ...authHeaders() };
	let bodyJson: string | undefined;
	if (options && (options.newBranchName !== undefined || options.force !== undefined)) {
		headers['Content-Type'] = 'application/json';
		bodyJson = JSON.stringify({
			...(options.newBranchName !== undefined
				? { newBranchName: options.newBranchName }
				: {}),
			...(options.force !== undefined ? { force: options.force } : {}),
		});
	}
	const res = await fetch(
		`${API_BASE_URL}/api/chat/${prId}/proposed-changes/merge-and-push`,
		{
			method: 'POST',
			headers,
			...(bodyJson !== undefined ? { body: bodyJson } : {}),
		},
	);
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

	// 200 / 409: body is the structured result.
	if (res.ok || res.status === 409) {
		const status = body['status'];
		if (status === 'pushed') {
			return {
				status: 'pushed',
				newSha: String(body['newSha']),
				pushedCommits: Number(body['pushedCommits'] ?? 0),
				branch: String(body['branch']),
			};
		}
		if (status === 'conflict') {
			return {
				status: 'conflict',
				files: Array.isArray(body['files'])
					? (body['files'] as string[])
					: [],
				branch: String(body['branch']),
			};
		}
		if (status === 'remote-changed') {
			return {
				status: 'remote-changed',
				branch: String(body['branch']),
			};
		}
		if (status === 'ref-exists') {
			return {
				status: 'ref-exists',
				branch: String(body['branch']),
			};
		}
	}

	// Otherwise it's a structured error.
	const code = (body['code'] as MergePushError['code']) ?? 'GENERIC_ERROR';
	const message =
		(body['message'] as string) ??
		(body['error'] as string) ??
		`Push failed (${res.status})`;
	const err: MergePushError = { code, message };
	throw err;
}

// ── Resolve & push (SSE) ──────────────────────────────────────────────────

export type ResolvePushFrame =
	| { kind: 'status'; message: string }
	| { kind: 'conflict-files'; files: string[] }
	| { kind: 'agent-text'; data: string }
	| {
			kind: 'agent-activity';
			activityKind: string;
			toolName: string | null;
			summary: string;
			payload?: unknown;
	  }
	| {
			kind: 'result';
			status: 'pushed';
			newSha: string;
			pushedCommits: number;
			branch: string;
	  }
	| { kind: 'result'; status: 'remote-changed'; branch: string }
	| { kind: 'result'; status: 'failed'; message: string };

export interface ResolvePushCallbacks {
	onStatus?: (message: string) => void;
	onConflictFiles?: (files: string[]) => void;
	onAgentText?: (chunk: string) => void;
	onAgentActivity?: (activity: {
		activityKind: string;
		toolName: string | null;
		summary: string;
		payload?: unknown;
	}) => void;
	onResult: (result: Extract<ResolvePushFrame, { kind: 'result' }>) => void;
	onError: (error: { code: string; message: string }) => void;
	onDone: () => void;
}

/**
 * Stream the conflict-resolution + push flow. The agent's progress (file
 * edits, bash commands, brief commentary) is emitted inline; the terminal
 * frame describes the push outcome.
 */
export function resolveConflictsAndPush(
	prId: string,
	callbacks: ResolvePushCallbacks,
): AbortController {
	const controller = new AbortController();

	fetch(
		`${API_BASE_URL}/api/chat/${prId}/proposed-changes/resolve-and-push`,
		{
			method: 'POST',
			headers: authHeaders(),
			signal: controller.signal,
		},
	)
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

				const result = parseSSEBuffer<ResolvePushFrame>(buffer);
				buffer = result.remaining;

				if (result.error) {
					callbacks.onError(result.error);
					gotError = true;
					continue;
				}

				for (const frame of result.events) {
					switch (frame.kind) {
						case 'status':
							callbacks.onStatus?.(frame.message);
							break;
						case 'conflict-files':
							callbacks.onConflictFiles?.(frame.files);
							break;
						case 'agent-text':
							callbacks.onAgentText?.(frame.data);
							break;
						case 'agent-activity':
							callbacks.onAgentActivity?.({
								activityKind: frame.activityKind,
								toolName: frame.toolName,
								summary: frame.summary,
								...(frame.payload !== undefined
									? { payload: frame.payload }
									: {}),
							});
							break;
						case 'result':
							callbacks.onResult(frame);
							break;
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
