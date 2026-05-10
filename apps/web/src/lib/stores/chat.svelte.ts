// ── Chat store ──────────────────────────────────────────────────────────────
//
// Per-PR display state for the right-pane AI chat. Two sources hydrate it:
//
//   1. `loadChatHistory(prId)` — pulled from SQLite via GET /api/chat/:prId/
//      messages on panel mount or PR switch (gap A1: persistent history).
//   2. The streaming SSE callbacks during an in-flight turn — text chunks
//      append to the assistant bubble in place; structured activity frames
//      become rich `ChatItem` rows.
//
// State map shape:
//   - `chatHistories` — the message + activity list rendered in the panel
//   - `chatErrors`    — latest error per PR (NOT_CONFIGURED, RATE_LIMITED, …)
//   - `streamingPrIds`— who's mid-turn so the UI can show the indicator
//   - `loadedPrIds`   — set of PRs whose persisted history has been hydrated
//                       at least once. Prevents re-fetching on every panel
//                       remount.
//   - `proposedChanges` — commits the agent has made on its working branch,
//                         shown in the proposed-changes strip above the input
//
// Map-reassignment for Svelte-5 reactivity, matching the `loadedHeadShas`
// idiom in `review.svelte.ts` and the entry maps in `walkthrough.svelte.ts`.

import type { Activity, ActivityKind } from '@revv/shared';
import {
	clearChat,
	fetchChatMessages,
	fetchProposedChanges,
	streamChatMessage,
	type PersistedChatEntry,
	type ProposedChanges,
} from '$lib/api/chat';
import { toast } from 'svelte-sonner';

export type ChatItem =
	| {
			kind: 'message';
			id: string;
			role: 'user' | 'assistant';
			content: string;
			isStreaming: boolean;
			turnId?: string;
			/**
			 * Set when this turn errored mid-stream and we kept the bubble
			 * around so partial content + tool-use lines aren't orphaned.
			 * Renders an inline AlertTriangle + message under the body.
			 */
			error?: string;
	  }
	| {
			kind: 'activity';
			id: string;
			activityKind: ActivityKind;
			toolName: string;
			summary: string;
			turnId?: string;
	  };

let chatHistories = $state(new Map<string, ChatItem[]>());
let chatErrors = $state(
	new Map<string, { code: string; message: string } | null>(),
);
let streamingPrIds = $state(new Set<string>());
let loadedPrIds = $state(new Set<string>());
let proposedChanges = $state(new Map<string, ProposedChanges | null>());

// Non-reactive — abort controllers have no UI semantics.
const abortControllers = new Map<string, AbortController>();

// ── Reads ──────────────────────────────────────────────────────────────────

export function getChatItems(prId: string): ChatItem[] {
	return chatHistories.get(prId) ?? [];
}

export function getChatError(
	prId: string,
): { code: string; message: string } | null {
	return chatErrors.get(prId) ?? null;
}

export function isChatStreaming(prId: string): boolean {
	return streamingPrIds.has(prId);
}

export function isChatHistoryLoaded(prId: string): boolean {
	return loadedPrIds.has(prId);
}

export function getProposedChanges(prId: string): ProposedChanges | null {
	return proposedChanges.get(prId) ?? null;
}

// ── Internal mutators (each reassigns the container per Svelte-5 reactivity) ─

function setItems(prId: string, items: ChatItem[]): void {
	chatHistories.set(prId, items);
	chatHistories = new Map(chatHistories);
}

function appendItem(prId: string, item: ChatItem): void {
	const existing = chatHistories.get(prId) ?? [];
	setItems(prId, [...existing, item]);
}

function patchItem(
	prId: string,
	id: string,
	patch: (item: ChatItem) => ChatItem,
): void {
	const items = chatHistories.get(prId) ?? [];
	const idx = items.findIndex((i) => i.id === id);
	if (idx === -1) return;
	const next = [...items];
	next[idx] = patch(items[idx]!);
	setItems(prId, next);
}

function removeItem(prId: string, id: string): void {
	const items = chatHistories.get(prId) ?? [];
	const next = items.filter((i) => i.id !== id);
	if (next.length === items.length) return;
	setItems(prId, next);
}

function setError(
	prId: string,
	error: { code: string; message: string } | null,
): void {
	chatErrors.set(prId, error);
	chatErrors = new Map(chatErrors);
}

function setStreaming(prId: string, streaming: boolean): void {
	if (streaming) {
		streamingPrIds.add(prId);
	} else {
		streamingPrIds.delete(prId);
	}
	streamingPrIds = new Set(streamingPrIds);
}

function markLoaded(prId: string): void {
	if (loadedPrIds.has(prId)) return;
	loadedPrIds.add(prId);
	loadedPrIds = new Set(loadedPrIds);
}

function setProposedChanges(prId: string, value: ProposedChanges | null): void {
	proposedChanges.set(prId, value);
	proposedChanges = new Map(proposedChanges);
}

// ── Persisted-entry → ChatItem projection ─────────────────────────────────

function entryToChatItem(entry: PersistedChatEntry): ChatItem {
	if (entry.entryKind === 'message') {
		return {
			kind: 'message',
			id: entry.id,
			role: entry.role,
			content: entry.content,
			isStreaming: entry.isStreaming,
			turnId: entry.turnId,
			...(entry.error ? { error: entry.error } : {}),
		};
	}
	return {
		kind: 'activity',
		id: entry.id,
		activityKind: entry.activityKind as ActivityKind,
		toolName: entry.toolName ?? entry.activityKind,
		summary: entry.summary,
		turnId: entry.turnId,
	};
}

// ── Public actions ─────────────────────────────────────────────────────────

/**
 * Hydrate the panel from the server-persisted timeline. Idempotent — only
 * the first call per PR actually fetches; subsequent calls no-op until
 * `clearChatHistory` resets the loaded flag.
 */
export async function loadChatHistory(prId: string): Promise<void> {
	if (loadedPrIds.has(prId)) return;
	// Optimistically mark loaded to dedupe in-flight fetches if the panel
	// remounts during the request.
	markLoaded(prId);
	try {
		const timeline = await fetchChatMessages(prId);
		const items = timeline.entries.map(entryToChatItem);
		// Only overwrite if no streaming-in-flight items have arrived
		// since we started fetching. The streaming callbacks own the live
		// state — they shouldn't be clobbered by a stale history fetch.
		if (!streamingPrIds.has(prId)) {
			setItems(prId, items);
		}
	} catch (err) {
		// Best-effort — failures leave the panel empty + the user can still
		// send a fresh message. Don't toast; the panel renders an empty state.
		console.warn('Failed to load chat history', err);
	}
}

export interface SendChatMessageParams {
	prId: string;
	message: string;
}

export function sendChatMessage(params: SendChatMessageParams): void {
	const { prId, message } = params;
	const trimmed = message.trim();
	if (trimmed.length === 0) return;

	// Cancel any in-flight turn for this PR. The user is overriding it.
	abortControllers.get(prId)?.abort();
	abortControllers.delete(prId);
	setError(prId, null);

	// Append the user's message + a placeholder assistant message.
	const userId = crypto.randomUUID();
	const assistantId = crypto.randomUUID();
	appendItem(prId, {
		kind: 'message',
		id: userId,
		role: 'user',
		content: trimmed,
		isStreaming: false,
	});
	appendItem(prId, {
		kind: 'message',
		id: assistantId,
		role: 'assistant',
		content: '',
		isStreaming: true,
	});
	setStreaming(prId, true);

	const controller = streamChatMessage(
		{ prId, message: trimmed },
		{
			onText: (chunk) => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, content: item.content + chunk }
						: item,
				);
			},
			onActivity: (activity: Activity) => {
				// Activity entries are inserted BEFORE the streaming
				// assistant message so the visual order is: user → activity
				// → activity → … → assistant text. Find the placeholder and
				// splice in front.
				const items = chatHistories.get(prId) ?? [];
				const idx = items.findIndex((i) => i.id === assistantId);
				const item: ChatItem = {
					kind: 'activity',
					id: crypto.randomUUID(),
					activityKind: activity.activityKind,
					toolName: activity.toolName,
					summary: activity.summary,
				};
				if (idx === -1) {
					setItems(prId, [...items, item]);
				} else {
					const next = [...items.slice(0, idx), item, ...items.slice(idx)];
					setItems(prId, next);
				}
			},
			onDone: () => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message' ? { ...item, isStreaming: false } : item,
				);
				setStreaming(prId, false);
				abortControllers.delete(prId);
				// Refresh the proposed-changes strip — the agent may have made
				// commits during this turn.
				void refreshProposedChanges(prId);
			},
			onError: (err) => {
				// Preserve any partial content the agent already streamed —
				// activity lines were spliced *before* this bubble, so removing
				// it would leave them orphaned. Only drop the bubble if it's
				// truly empty (no streamed text yet); otherwise mark it errored
				// and let the renderer attach an inline error chip.
				const items = chatHistories.get(prId) ?? [];
				const placeholder = items.find((i) => i.id === assistantId);
				const hasContent =
					placeholder?.kind === 'message' && placeholder.content.length > 0;
				if (hasContent) {
					patchItem(prId, assistantId, (item) =>
						item.kind === 'message'
							? { ...item, isStreaming: false, error: err.message }
							: item,
					);
				} else {
					removeItem(prId, assistantId);
				}
				setError(prId, err);
				setStreaming(prId, false);
				abortControllers.delete(prId);
				toast.error(err.message || 'AI chat failed');
			},
		},
	);

	abortControllers.set(prId, controller);
}

export async function clearChatHistory(prId: string): Promise<void> {
	abortControllers.get(prId)?.abort();
	abortControllers.delete(prId);
	setItems(prId, []);
	setError(prId, null);
	setStreaming(prId, false);
	setProposedChanges(prId, null);
	// Reset the loaded flag so a subsequent navigation re-pulls the
	// (now-empty) timeline from the server. Clearing the agent-side session
	// also wipes chat_messages/chat_activities via FK CASCADE on
	// chat_sessions, so the next fetch will return an empty list.
	if (loadedPrIds.has(prId)) {
		loadedPrIds.delete(prId);
		loadedPrIds = new Set(loadedPrIds);
	}
	try {
		await clearChat(prId);
	} catch (err) {
		toast.error(
			err instanceof Error ? err.message : 'Failed to clear conversation',
		);
	}
}

export async function refreshProposedChanges(prId: string): Promise<void> {
	try {
		const data = await fetchProposedChanges(prId);
		setProposedChanges(prId, data);
	} catch {
		// Best-effort — the strip just won't update.
	}
}
