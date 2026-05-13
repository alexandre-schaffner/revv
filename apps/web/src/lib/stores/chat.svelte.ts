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

import type {
	Activity,
	ActivityKind,
	ChatPlan,
	ChatTask,
	InteractionMode,
} from '@revv/shared';
import {
	approvePlan,
	clearChat,
	cherryPickProposedCommit,
	discardProposedCommit,
	fetchAvailableAgents,
	rebaseProposedCommits,
	rejectPlan,
	advanceWorktree,
	fetchChatMessages,
	fetchProposedChanges,
	pushProposedChanges,
	resolveConflictsAndPush,
	setInteractionMode as setInteractionModeApi,
	streamChatMessage,
	type AvailableAgents,
	type MergePushError,
	type MergePushResult,
	type PersistedChatEntry,
	type ProposedChanges,
	type PushProposedOptions,
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
			/**
			 * When set, this activity row was emitted by a sub-agent. The
			 * SubagentInvocation card filters its nested activities by this
			 * id; the top-level render loop skips them.
			 */
			subagentInvocationId?: string;
	  }
	| {
			kind: 'task-list';
			id: string;
			turnId: string;
			tasks: ReadonlyArray<ChatTask>;
	  }
	| {
			kind: 'plan';
			id: string;
			turnId: string;
			markdown: string;
			status: 'pending' | 'approved' | 'rejected' | 'superseded';
	  }
	| {
			kind: 'subagent';
			id: string;
			parentTurnId: string;
			subagentType: string;
			description: string;
			status: 'running' | 'completed' | 'errored';
			result: string | null;
	  };

let chatHistories = $state(new Map<string, ChatItem[]>());
let chatErrors = $state(
	new Map<string, { code: string; message: string } | null>(),
);
let streamingPrIds = $state(new Set<string>());
let loadedPrIds = $state(new Set<string>());
let proposedChanges = $state(new Map<string, ProposedChanges | null>());
let pushingPrIds = $state(new Set<string>());
let resolvingPushPrIds = $state(new Set<string>());
// Session-level interaction mode, keyed by prId. Sourced from the persisted
// timeline fetch and from explicit toggles. Defaults to 'default'.
let interactionModes = $state(new Map<string, InteractionMode>());
// Cached agent-availability probe (one global value — depends on the chosen
// CLI agent, not on the PR).
let availableAgents = $state<AvailableAgents | null>(null);
let availableAgentsLoading = $state(false);

// In-progress reviewer comments left on a proposed-changes diff. These are
// ephemeral feedback bound for the chat agent (NOT PR review threads — the
// commits aren't on the remote yet, so a real thread would orphan the moment
// the agent rewrites the SHA). Keyed by `${prId}::${sha}` so they survive
// closing/reopening the modal but don't bleed across commits.
export interface ProposedComment {
	id: string;
	filePath: string;
	lineNumber: number;
	side: 'deletions' | 'additions';
	body: string;
}
let proposedComments = $state(new Map<string, ProposedComment[]>());

// ── Worktree-blocked state ─────────────────────────────────────────────────
//
// When the PR head SHA advances but the worktree has unpushed agent commits,
// the POST /api/chat returns a 409 WORKTREE_BLOCKED response. The blocked
// state is stored here so the UI can present the commit list and offer
// discard / rebase actions.

export interface BlockedCommit {
	sha: string;
	shortSha: string;
	subject: string;
	committedAt: string;
	files: string[];
}

export interface WorktreeBlockedState {
	oldHeadSha: string;
	newHeadSha: string;
	commits: BlockedCommit[];
}

let worktreeBlocked = $state(new Map<string, WorktreeBlockedState | null>());
let discardingCommits = $state(new Set<string>());
let cherryPickingCommits = $state(new Set<string>());
let rebasingPrIds = $state(new Set<string>());

// Non-reactive — abort controllers have no UI semantics.
const abortControllers = new Map<string, AbortController>();
const resolveAbortControllers = new Map<string, AbortController>();

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

export function isPushingProposed(prId: string): boolean {
	return pushingPrIds.has(prId);
}

export function isResolvingPush(prId: string): boolean {
	return resolvingPushPrIds.has(prId);
}

function commentKey(prId: string, sha: string): string {
	return `${prId}::${sha}`;
}

export function getProposedComments(prId: string, sha: string): ProposedComment[] {
	return proposedComments.get(commentKey(prId, sha)) ?? [];
}

export function getWorktreeBlocked(prId: string): WorktreeBlockedState | null {
	return worktreeBlocked.get(prId) ?? null;
}

export function isDiscardingCommit(sha: string): boolean {
	return discardingCommits.has(sha);
}

export function isCherryPickingCommit(sha: string): boolean {
	return cherryPickingCommits.has(sha);
}

export function isRebasingProposed(prId: string): boolean {
	return rebasingPrIds.has(prId);
}

export function getInteractionMode(prId: string): InteractionMode {
	return interactionModes.get(prId) ?? 'default';
}

export function getAvailableAgents(): AvailableAgents | null {
	return availableAgents;
}

export function isPlanModeAvailable(): boolean {
	return availableAgents?.planAvailable ?? false;
}

export async function loadAvailableAgents(): Promise<void> {
	if (availableAgentsLoading || availableAgents !== null) return;
	availableAgentsLoading = true;
	try {
		availableAgents = await fetchAvailableAgents();
	} catch {
		// Best-effort — the composer falls back to disabled plan mode.
		availableAgents = {
			agent: 'opencode',
			agents: [],
			planAvailable: false,
		};
	} finally {
		availableAgentsLoading = false;
	}
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

function setPushing(prId: string, pushing: boolean): void {
	if (pushing) {
		pushingPrIds.add(prId);
	} else {
		pushingPrIds.delete(prId);
	}
	pushingPrIds = new Set(pushingPrIds);
}

function setResolvingPush(prId: string, resolving: boolean): void {
	if (resolving) {
		resolvingPushPrIds.add(prId);
	} else {
		resolvingPushPrIds.delete(prId);
	}
	resolvingPushPrIds = new Set(resolvingPushPrIds);
}

function setProposedComments(
	prId: string,
	sha: string,
	comments: ProposedComment[],
): void {
	const key = commentKey(prId, sha);
	if (comments.length === 0) {
		proposedComments.delete(key);
	} else {
		proposedComments.set(key, comments);
	}
	proposedComments = new Map(proposedComments);
}

function setWorktreeBlocked(prId: string, state: WorktreeBlockedState | null): void {
	worktreeBlocked.set(prId, state);
	worktreeBlocked = new Map(worktreeBlocked);
}

export function addProposedComment(
	prId: string,
	sha: string,
	comment: ProposedComment,
): void {
	const existing = getProposedComments(prId, sha);
	setProposedComments(prId, sha, [...existing, comment]);
}

export function updateProposedComment(
	prId: string,
	sha: string,
	id: string,
	body: string,
): void {
	const existing = getProposedComments(prId, sha);
	const next = existing.map((c) => (c.id === id ? { ...c, body } : c));
	setProposedComments(prId, sha, next);
}

export function removeProposedComment(
	prId: string,
	sha: string,
	id: string,
): void {
	const existing = getProposedComments(prId, sha);
	setProposedComments(
		prId,
		sha,
		existing.filter((c) => c.id !== id),
	);
}

export function clearProposedComments(prId: string, sha: string): void {
	setProposedComments(prId, sha, []);
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
	if (entry.entryKind === 'activity') {
		return {
			kind: 'activity',
			id: entry.id,
			activityKind: entry.activityKind as ActivityKind,
			toolName: entry.toolName ?? entry.activityKind,
			summary: entry.summary,
			turnId: entry.turnId,
			...(entry.subagentInvocationId
				? { subagentInvocationId: entry.subagentInvocationId }
				: {}),
		};
	}
	if (entry.entryKind === 'task-list') {
		return {
			kind: 'task-list',
			id: `task-list-${entry.turnId}`,
			turnId: entry.turnId,
			tasks: entry.tasks,
		};
	}
	if (entry.entryKind === 'plan') {
		return {
			kind: 'plan',
			id: entry.id,
			turnId: entry.turnId,
			markdown: entry.planMarkdown,
			status: entry.status,
		};
	}
	// subagent
	return {
		kind: 'subagent',
		id: entry.id,
		parentTurnId: entry.parentTurnId,
		subagentType: entry.subagentType,
		description: entry.description,
		status: entry.status,
		result: entry.result,
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
		// Pull the stored interaction mode so the composer toggle reflects
		// the persisted state across reloads.
		interactionModes.set(prId, timeline.interactionMode);
		interactionModes = new Map(interactionModes);
	} catch (err) {
		// Best-effort — failures leave the panel empty + the user can still
		// send a fresh message. Don't toast; the panel renders an empty state.
		console.warn('Failed to load chat history', err);
	}
}

export interface SendChatMessageParams {
	prId: string;
	message: string;
	/** Plan id being approved with this message. Server flips session to 'default'. */
	approvedPlanId?: string;
	/** Override the session's stored interaction mode for this turn. */
	interactionMode?: InteractionMode;
}

function spliceBeforeAssistant(prId: string, assistantId: string, item: ChatItem): void {
	const items = chatHistories.get(prId) ?? [];
	const idx = items.findIndex((i) => i.id === assistantId);
	if (idx === -1) {
		setItems(prId, [...items, item]);
	} else {
		setItems(prId, [...items.slice(0, idx), item, ...items.slice(idx)]);
	}
}

export function sendChatMessage(params: SendChatMessageParams): void {
	const { prId, message, approvedPlanId, interactionMode } = params;
	const trimmed = message.trim();
	if (trimmed.length === 0) return;

	// Cancel any in-flight turn for this PR. The user is overriding it.
	abortControllers.get(prId)?.abort();
	abortControllers.delete(prId);
	setError(prId, null);

	// Append the user's message + a placeholder assistant message.
	// `turnId` correlates the assistant placeholder with the activities that
	// stream in for the same turn — the RightPanel uses it to fold the last
	// 2 tool calls into the bubble's dot-matrix loader.
	const userId = crypto.randomUUID();
	const assistantId = crypto.randomUUID();
	const turnId = crypto.randomUUID();
	appendItem(prId, {
		kind: 'message',
		id: userId,
		role: 'user',
		content: trimmed,
		isStreaming: false,
		turnId,
	});
	appendItem(prId, {
		kind: 'message',
		id: assistantId,
		role: 'assistant',
		content: '',
		isStreaming: true,
		turnId,
	});
	setStreaming(prId, true);

	const controller = streamChatMessage(
		{
			prId,
			message: trimmed,
			...(approvedPlanId !== undefined ? { approvedPlanId } : {}),
			...(interactionMode !== undefined ? { interactionMode } : {}),
		},
		{
			onText: (chunk) => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, content: item.content + chunk }
						: item,
				);
			},
			onActivity: (activity) => {
				// Activity entries are inserted BEFORE the streaming
				// assistant message so the visual order is: user → activity
				// → activity → … → assistant text. Find the placeholder and
				// splice in front.
				spliceBeforeAssistant(prId, assistantId, {
					kind: 'activity',
					id: crypto.randomUUID(),
					activityKind: activity.activityKind,
					toolName: activity.toolName,
					summary: activity.summary,
					turnId,
					...(activity.subagentInvocationId
						? { subagentInvocationId: activity.subagentInvocationId }
						: {}),
				});
			},
			onTaskList: ({ turnId: taskTurnId, tasks }) => {
				// Reconcile with any existing task-list for the same turn —
				// snapshot semantics. If we already have a row, update in
				// place; otherwise insert.
				const items = chatHistories.get(prId) ?? [];
				const existingIdx = items.findIndex(
					(i) => i.kind === 'task-list' && i.turnId === taskTurnId,
				);
				if (existingIdx === -1) {
					spliceBeforeAssistant(prId, assistantId, {
						kind: 'task-list',
						id: `task-list-${taskTurnId}`,
						turnId: taskTurnId,
						tasks,
					});
				} else {
					patchItem(prId, items[existingIdx]!.id, (item) =>
						item.kind === 'task-list' ? { ...item, tasks } : item,
					);
				}
			},
			onPlanPresented: ({ planId, turnId: planTurnId, markdown }) => {
				spliceBeforeAssistant(prId, assistantId, {
					kind: 'plan',
					id: planId,
					turnId: planTurnId,
					markdown,
					status: 'pending',
				});
			},
			onSubagentStart: ({
				invocationId,
				parentTurnId,
				subagentType,
				description,
			}) => {
				spliceBeforeAssistant(prId, assistantId, {
					kind: 'subagent',
					id: invocationId,
					parentTurnId,
					subagentType,
					description,
					status: 'running',
					result: null,
				});
			},
			onSubagentEnd: ({ invocationId, result, ok }) => {
				patchItem(prId, invocationId, (item) =>
					item.kind === 'subagent'
						? {
								...item,
								status: ok ? 'completed' : 'errored',
								result,
							}
						: item,
				);
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
				// Plan-pending: the user tried to send a new message while a
				// plan is awaiting decision. Drop the assistant placeholder,
				// surface a focused toast pointing at the open plan, and let
				// the UI scroll the card into view. Keep the user message —
				// they'll likely want to retry after deciding.
				if (err.code === 'PLAN_PENDING') {
					removeItem(prId, assistantId);
					setStreaming(prId, false);
					abortControllers.delete(prId);
					toast.error(
						'Approve or reject the open plan before sending a new message.',
					);
					return;
				}
				// AGENT_UNAVAILABLE: user toggled plan mode but the opencode
				// daemon has no `plan` agent. Disable the toggle and surface
				// the message so the user knows what to do.
				if (err.code === 'AGENT_UNAVAILABLE') {
					removeItem(prId, assistantId);
					setStreaming(prId, false);
					abortControllers.delete(prId);
					interactionModes.set(prId, 'default');
					interactionModes = new Map(interactionModes);
					toast.error(err.message ?? 'Plan mode unavailable on this opencode install.');
					return;
				}
				// Special case: the PR head advanced but the worktree has
				// unpushed agent commits. Surface the blocked state so the UI
				// can show the discard/rebase panel instead of a generic error.
				if (err.code === 'WORKTREE_BLOCKED') {
					const blocked = err as unknown as {
						code: string;
						commits: BlockedCommit[];
						oldHeadSha: string;
						newHeadSha: string;
					};
					setWorktreeBlocked(prId, {
						oldHeadSha: blocked.oldHeadSha,
						newHeadSha: blocked.newHeadSha,
						commits: blocked.commits,
					});
					// The assistant placeholder has no content — remove it.
					removeItem(prId, assistantId);
					setStreaming(prId, false);
					abortControllers.delete(prId);
					return;
				}
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
				// The agent may have committed before the stream errored —
				// refresh so the proposed-changes strip reflects whatever
				// landed in the worktree.
				void refreshProposedChanges(prId);
				toast.error(err.message || 'AI chat failed');
			},
		},
	);

	abortControllers.set(prId, controller);
}

// ── Plan / interaction-mode actions ──────────────────────────────────────

export async function setInteractionMode(
	prId: string,
	mode: InteractionMode,
): Promise<void> {
	const prior = interactionModes.get(prId) ?? 'default';
	interactionModes.set(prId, mode);
	interactionModes = new Map(interactionModes);
	try {
		await setInteractionModeApi(prId, mode);
	} catch (err) {
		// Roll back on failure.
		interactionModes.set(prId, prior);
		interactionModes = new Map(interactionModes);
		toast.error(
			err instanceof Error ? err.message : 'Failed to set interaction mode',
		);
	}
}

export async function approvePlanAction(
	prId: string,
	planId: string,
): Promise<void> {
	try {
		await approvePlan(prId, planId);
		patchItem(prId, planId, (item) =>
			item.kind === 'plan' ? { ...item, status: 'approved' } : item,
		);
		// Flipping out of plan mode for the execution turn is server-side;
		// mirror it locally so the toggle UI reflects the new state until
		// the next refresh.
		interactionModes.set(prId, 'default');
		interactionModes = new Map(interactionModes);
		// Kick off the execution turn carrying the approved plan id.
		sendChatMessage({
			prId,
			message: 'Proceed with the plan above.',
			approvedPlanId: planId,
			interactionMode: 'default',
		});
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Approve failed');
	}
}

export async function rejectPlanAction(
	prId: string,
	planId: string,
): Promise<void> {
	try {
		await rejectPlan(prId, planId);
		patchItem(prId, planId, (item) =>
			item.kind === 'plan' ? { ...item, status: 'rejected' } : item,
		);
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Reject failed');
	}
}

export interface SendProposedFeedbackParams {
	prId: string;
	sha: string;
	subject: string;
}

/**
 * Bundle the reviewer's accumulated inline comments on a proposed commit into
 * a single chat message and dispatch it through the normal chat pipeline. The
 * agent receives standard markdown with file/line citations and reacts on its
 * next turn (typically by amending or appending a commit).
 *
 * Returns true if anything was sent, false if there were no comments to send.
 */
export function sendProposedFeedback(params: SendProposedFeedbackParams): boolean {
	const { prId, sha, subject } = params;
	const comments = getProposedComments(prId, sha);
	if (comments.length === 0) return false;

	const shortSha = sha.slice(0, 8);
	const header = `Reviewer feedback on commit \`${shortSha}\` — "${subject}":`;
	const lines = comments.map((c) => {
		const sideLabel = c.side === 'deletions' ? 'old' : 'new';
		return `- **${c.filePath}:${c.lineNumber}** (${sideLabel}) — ${c.body}`;
	});
	const message = [header, '', ...lines].join('\n');

	sendChatMessage({ prId, message });
	clearProposedComments(prId, sha);
	return true;
}

export async function clearChatHistory(prId: string): Promise<void> {
	abortControllers.get(prId)?.abort();
	abortControllers.delete(prId);
	setItems(prId, []);
	setError(prId, null);
	setStreaming(prId, false);
	setProposedChanges(prId, null);
	setWorktreeBlocked(prId, null);
	interactionModes.set(prId, 'default');
	interactionModes = new Map(interactionModes);
	// Reset the loaded flag so a subsequent navigation re-pulls the
	// (now-empty) timeline from the server. Clearing the agent-side session
	// also wipes chat_messages/chat_activities via FK CASCADE on
	// chat_sessions, so the next fetch will return an empty list.
	if (loadedPrIds.has(prId)) {
		loadedPrIds.delete(prId);
		loadedPrIds = new Set(loadedPrIds);
	}
	// Clear all proposedComments entries for this prId.
	for (const key of proposedComments.keys()) {
		if (key.startsWith(`${prId}::`)) {
			proposedComments.delete(key);
		}
	}
	proposedComments = new Map(proposedComments);
	try {
		await clearChat(prId);
	} catch (err) {
		toast.error(
			err instanceof Error ? err.message : 'Failed to clear conversation',
		);
	}
}

/**
 * Cancel the in-flight chat turn for a PR. Aborts the SSE fetch, finalizes
 * the streaming assistant bubble in place (preserving any partial content
 * + activity rows that already arrived), and clears the streaming flag.
 * No-op if no turn is in flight.
 */
export function abortChatTurn(prId: string): void {
	// Abort the in-flight fetch if one exists. The streaming flag and the
	// assistant bubble can outlive the controller (e.g. an SSE error cleared
	// the controller but a stale streaming flag survived, or HMR reset the
	// module-level controller map), so the cleanup below runs unconditionally
	// — otherwise the Stop button becomes a no-op and the user is stuck.
	const controller = abortControllers.get(prId);
	if (controller) {
		controller.abort();
		abortControllers.delete(prId);
	}

	// Finalize whichever assistant bubble is still streaming. The streaming
	// callbacks won't fire onDone for an aborted fetch, so we close out the
	// bubble here.
	const items = chatHistories.get(prId) ?? [];
	const streamingMsg = items.find(
		(i) => i.kind === 'message' && i.role === 'assistant' && i.isStreaming,
	);
	if (streamingMsg && streamingMsg.kind === 'message') {
		const hasContent = streamingMsg.content.length > 0;
		if (hasContent) {
			patchItem(prId, streamingMsg.id, (item) =>
				item.kind === 'message'
					? { ...item, isStreaming: false, error: 'Stopped' }
					: item,
			);
		} else {
			removeItem(prId, streamingMsg.id);
		}
	}
	setStreaming(prId, false);
	// The agent may have committed before the user hit Stop — refresh so the
	// proposed-changes strip reflects whatever landed in the worktree.
	void refreshProposedChanges(prId);
}

export async function refreshProposedChanges(prId: string): Promise<void> {
	try {
		const data = await fetchProposedChanges(prId);
		setProposedChanges(prId, data);
	} catch {
		// Best-effort — the strip just won't update.
	}
}

// ── Merge & push ───────────────────────────────────────────────────────────

/**
 * Attempt to merge the agent's local commits into the PR's source branch
 * and push. Returns the structured result so the caller can branch on
 * conflict / remote-changed / pushed. Toasts success/error itself.
 *
 * When `options.newBranchName` is provided the agent's commits are pushed
 * to that brand-new branch instead of merged into the PR. The caller is
 * responsible for handling the `ref-exists` result (typically by asking
 * the user to confirm an overwrite, then re-calling with `force: true`).
 */
export async function pushProposed(
	prId: string,
	options?: PushProposedOptions,
): Promise<MergePushResult | null> {
	if (pushingPrIds.has(prId)) return null;
	setPushing(prId, true);
	try {
		const result = await pushProposedChanges(prId, options);
		if (result.status === 'pushed') {
			toast.success(
				`Pushed ${result.pushedCommits} commit${
					result.pushedCommits === 1 ? '' : 's'
				} to ${result.branch}`,
			);
			// For the merge path the server has cleared the proposed-changes
			// baseline (PR head moved); refresh so the strip clears. For the
			// new-branch path the PR head is unchanged, but refreshing is a
			// cheap no-op against the same baseline.
			void refreshProposedChanges(prId);
		} else if (result.status === 'remote-changed') {
			toast.error(
				`The PR branch (${result.branch}) was updated remotely. Sync the latest changes and try again.`,
			);
		}
		// `ref-exists` is intentionally silent — the UI prompts the user
		// for overwrite confirmation and may retry with force.
		return result;
	} catch (e) {
		const err = e as MergePushError;
		// DIRTY_WORKTREE / NO_CHAT_SESSION etc. surface as toast — UI also
		// disables the button when commitCount === 0 or streaming.
		toast.error(err.message ?? 'Push failed');
		return null;
	} finally {
		setPushing(prId, false);
	}
}

/**
 * Stream the conflict-resolution + push flow. Agent activities and short
 * status notes are folded into the chat panel as ephemeral items so the
 * user sees what's happening; on resolution the proposed-changes strip
 * clears and a success toast fires.
 *
 * Note that the conflict-resolution turn is intentionally NOT persisted on
 * the server (one-shot non-conversational system prompt). The chat items
 * appended here will disappear on a fresh load — that's acceptable since
 * the PR's branch state is the durable record of what happened.
 */
export async function resolveAndPushProposed(prId: string): Promise<void> {
	if (resolvingPushPrIds.has(prId)) return;
	setResolvingPush(prId, true);

	const turnId = crypto.randomUUID();
	appendItem(prId, {
		kind: 'message',
		id: crypto.randomUUID(),
		role: 'user',
		content: '(Resolve push conflicts)',
		isStreaming: false,
		turnId,
	});
	const assistantId = crypto.randomUUID();
	appendItem(prId, {
		kind: 'message',
		id: assistantId,
		role: 'assistant',
		content: '',
		isStreaming: true,
		turnId,
	});

	return new Promise<void>((resolve) => {
		const controller = resolveConflictsAndPush(prId, {
			onStatus: (message) => {
				const items = chatHistories.get(prId) ?? [];
				const idx = items.findIndex((i) => i.id === assistantId);
				const item: ChatItem = {
					kind: 'activity',
					id: crypto.randomUUID(),
					activityKind: 'tool.other' as ActivityKind,
					toolName: 'merge-and-push',
					summary: message,
					turnId,
				};
				if (idx === -1) {
					setItems(prId, [...items, item]);
				} else {
					setItems(prId, [
						...items.slice(0, idx),
						item,
						...items.slice(idx),
					]);
				}
			},
			onConflictFiles: (files) => {
				const summary = `Conflicts in ${files.length} file${
					files.length === 1 ? '' : 's'
				}: ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}`;
				const items = chatHistories.get(prId) ?? [];
				const idx = items.findIndex((i) => i.id === assistantId);
				const item: ChatItem = {
					kind: 'activity',
					id: crypto.randomUUID(),
					activityKind: 'tool.other' as ActivityKind,
					toolName: 'merge-and-push',
					summary,
					turnId,
				};
				if (idx === -1) {
					setItems(prId, [...items, item]);
				} else {
					setItems(prId, [
						...items.slice(0, idx),
						item,
						...items.slice(idx),
					]);
				}
			},
			onAgentText: (chunk) => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, content: item.content + chunk }
						: item,
				);
			},
			onAgentActivity: (activity) => {
				const items = chatHistories.get(prId) ?? [];
				const idx = items.findIndex((i) => i.id === assistantId);
				const item: ChatItem = {
					kind: 'activity',
					id: crypto.randomUUID(),
					activityKind: activity.activityKind as ActivityKind,
					toolName: activity.toolName ?? activity.activityKind,
					summary: activity.summary,
					turnId,
				};
				if (idx === -1) {
					setItems(prId, [...items, item]);
				} else {
					setItems(prId, [
						...items.slice(0, idx),
						item,
						...items.slice(idx),
					]);
				}
			},
			onResult: (result) => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, isStreaming: false }
						: item,
				);
				if (result.status === 'pushed') {
					toast.success(
						`Pushed ${result.pushedCommits} commit${
							result.pushedCommits === 1 ? '' : 's'
						} to ${result.branch}`,
					);
					void refreshProposedChanges(prId);
				} else if (result.status === 'remote-changed') {
					toast.error(
						`The PR branch (${result.branch}) moved during push. Sync and retry.`,
					);
				} else {
					toast.error(result.message);
				}
			},
			onError: (err) => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, isStreaming: false, error: err.message }
						: item,
				);
				toast.error(err.message || 'Conflict resolution failed');
			},
			onDone: () => {
				patchItem(prId, assistantId, (item) =>
					item.kind === 'message'
						? { ...item, isStreaming: false }
						: item,
				);
				resolveAbortControllers.delete(prId);
				setResolvingPush(prId, false);
				resolve();
			},
		});

		resolveAbortControllers.set(prId, controller);
	});
}

// ── Blocked-commit actions ─────────────────────────────────────────────────

/**
 * Discard a single agent commit from the blocked worktree via rebase --onto.
 * When all commits are discarded, advances the worktree to the new PR head.
 */
export async function discardProposedCommitAction(
	prId: string,
	sha: string,
): Promise<void> {
	if (discardingCommits.has(sha)) return;
	discardingCommits.add(sha);
	discardingCommits = new Set(discardingCommits);
	try {
		await discardProposedCommit(prId, sha);
		const blocked = worktreeBlocked.get(prId);
		if (blocked) {
			const remainingCommits = blocked.commits.filter((c) => c.sha !== sha);
			if (remainingCommits.length === 0) {
				// Last commit discarded — advance the worktree.
				await advanceWorktree(prId, blocked.newHeadSha);
				setWorktreeBlocked(prId, null);
				await refreshProposedChanges(prId);
			} else {
				setWorktreeBlocked(prId, { ...blocked, commits: remainingCommits });
			}
		} else {
			await refreshProposedChanges(prId);
			// Remove orphaned comment state for the discarded SHA.
			const key = commentKey(prId, sha);
			if (proposedComments.has(key)) {
				proposedComments.delete(key);
				proposedComments = new Map(proposedComments);
			}
		}
		toast.success('Commit discarded');
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to discard commit');
	} finally {
		discardingCommits.delete(sha);
		discardingCommits = new Set(discardingCommits);
	}
}

/**
 * Rebase all agent commits onto the new PR head SHA, then advance the worktree.
 */
export async function rebaseAllProposedAction(prId: string): Promise<void> {
	const blocked = worktreeBlocked.get(prId);
	if (!blocked) return;
	if (rebasingPrIds.has(prId)) return;
	rebasingPrIds.add(prId);
	rebasingPrIds = new Set(rebasingPrIds);
	try {
		await rebaseProposedCommits(prId, blocked.oldHeadSha, blocked.newHeadSha);
		await advanceWorktree(prId, blocked.newHeadSha);
		setWorktreeBlocked(prId, null);
		await refreshProposedChanges(prId);
		toast.success('Commits rebased onto new PR head');
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to rebase commits');
	} finally {
		rebasingPrIds.delete(prId);
		rebasingPrIds = new Set(rebasingPrIds);
	}
}

/**
 * Cherry-pick a single proposed commit onto the PR's source branch and push.
 * After success, refreshes the proposed-changes list.
 */
export async function cherryPickProposedCommitAction(
	prId: string,
	sha: string,
): Promise<void> {
	if (cherryPickingCommits.has(sha)) return;
	cherryPickingCommits.add(sha);
	cherryPickingCommits = new Set(cherryPickingCommits);
	try {
		await cherryPickProposedCommit(prId, sha);
		await refreshProposedChanges(prId);
		toast.success('Commit pushed to PR branch');
	} catch (err) {
		toast.error(err instanceof Error ? err.message : 'Failed to push commit');
	} finally {
		cherryPickingCommits.delete(sha);
		cherryPickingCommits = new Set(cherryPickingCommits);
	}
}
