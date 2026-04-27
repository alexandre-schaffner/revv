// ── Chat store ──────────────────────────────────────────────────────────────
//
// Per-PR display state for the right-pane AI chat. The agent owns the
// authoritative conversation (Claude SDK JSONL or opencode session); this
// store is only the UI cache:
//
//   - `chatHistories` — the message + tool-use list rendered in the panel
//   - `chatErrors`    — latest error per PR (NOT_CONFIGURED, RATE_LIMITED, …)
//   - `streamingPrIds`— who's mid-turn so the UI can show the indicator
//   - `proposedChanges` — commits the agent has made on its working branch,
//                         shown in the proposed-changes strip above the input
//
// Map-reassignment for Svelte-5 reactivity, matching the `loadedHeadShas`
// idiom in `review.svelte.ts` and the entry maps in `walkthrough.svelte.ts`.

import {
	clearChat,
	fetchProposedChanges,
	streamChatMessage,
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
	  }
	| {
			kind: 'tool';
			id: string;
			description: string;
	  };

let chatHistories = $state(new Map<string, ChatItem[]>());
let chatErrors = $state(
	new Map<string, { code: string; message: string } | null>(),
);
let streamingPrIds = $state(new Set<string>());
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

function setProposedChanges(prId: string, value: ProposedChanges | null): void {
	proposedChanges.set(prId, value);
	proposedChanges = new Map(proposedChanges);
}

// ── Public actions ─────────────────────────────────────────────────────────

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
			onTool: (description) => {
				// Tool entries are inserted BEFORE the streaming assistant
				// message so the visual order is: user → tool → tool → … →
				// assistant text. Find the placeholder and splice in front.
				const items = chatHistories.get(prId) ?? [];
				const idx = items.findIndex((i) => i.id === assistantId);
				const toolItem: ChatItem = {
					kind: 'tool',
					id: crypto.randomUUID(),
					description,
				};
				if (idx === -1) {
					setItems(prId, [...items, toolItem]);
				} else {
					const next = [...items.slice(0, idx), toolItem, ...items.slice(idx)];
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
				// Drop the empty assistant placeholder so the error banner stands alone.
				removeItem(prId, assistantId);
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
