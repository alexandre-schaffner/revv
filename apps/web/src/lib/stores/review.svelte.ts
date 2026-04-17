import type {
	CommentThread,
	ThreadMessage,
	ThreadStatus,
	AuthorRole,
	MessageType,
	HunkDecision,
} from '@revv/shared';
import type { ReviewFile } from '$lib/types/review';
import { api } from '$lib/api/client';
import { streamExplanation } from '$lib/api/explain';
import { enterSidebarMode } from '$lib/stores/focus-mode.svelte';
import { toast } from 'svelte-sonner';

// --- Review files (shared between sidebar tree + review page) ---
let reviewFiles = $state<ReviewFile[]>([]);
let isLoadingFiles = $state(false);
let filesError = $state<string | null>(null);

export function getReviewFiles(): ReviewFile[] {
	return reviewFiles;
}

export function getIsLoadingFiles(): boolean {
	return isLoadingFiles;
}

export function getFilesError(): string | null {
	return filesError;
}

export function setReviewFiles(files: ReviewFile[]): void {
	reviewFiles = files;
}

export function setIsLoadingFiles(v: boolean): void {
	isLoadingFiles = v;
}

export function setFilesError(e: string | null): void {
	filesError = e;
}

export function clearReviewFiles(): void {
	reviewFiles = [];
	isLoadingFiles = false;
	filesError = null;
	activeFilePath = null;
	clearSession();
}

// --- Session state ---
let sessionId = $state<string | null>(null);
let sessionLoading = $state(false);

export function getSessionId(): string | null {
	return sessionId;
}

export function getSessionLoading(): boolean {
	return sessionLoading;
}

function clearSession(): void {
	sessionId = null;
	threads = [];
	threadMessages = {};
	acceptedHunks = new Map();
	rejectedHunks = new Map();
	threadsVersion++;
}

let loadSessionSeq = 0;

/** Load (or create) the active review session for a PR, hydrating all state. */
export async function loadSession(prId: string): Promise<void> {
	const seq = ++loadSessionSeq;
	sessionLoading = true;
	try {
		const { data, error } = await api.api.reviews.active({ prId }).get();

		// Discard if a newer call has started
		if (seq !== loadSessionSeq) return;

		if (error || !data) {
			console.error('[review] Failed to load session:', error);
			toast.error('Failed to load review session');
			return;
		}

		// Type-narrow: the response is the full hydration payload
		const payload = data as {
			session: { id: string };
			threads: CommentThread[];
			messages: Record<string, ThreadMessage[]>;
			hunkDecisions: HunkDecision[];
		};

		sessionId = payload.session.id;
		threads = payload.threads;

		// Populate thread messages
		const msgs: Record<string, ThreadMessage[]> = {};
		for (const [tid, msgList] of Object.entries(payload.messages)) {
			msgs[tid] = msgList;
		}
		threadMessages = msgs;

		// Rebuild hunk decision Maps
		const accepted = new Map<string, Set<number>>();
		const rejected = new Map<string, Set<number>>();
		for (const hd of payload.hunkDecisions) {
			const map = hd.decision === 'accepted' ? accepted : rejected;
			const set = map.get(hd.filePath) ?? new Set<number>();
			set.add(hd.hunkIndex);
			map.set(hd.filePath, set);
		}
		acceptedHunks = accepted;
		rejectedHunks = rejected;
		threadsVersion++;
	} finally {
		// Only clear loading if this is still the active request
		if (seq === loadSessionSeq) {
			sessionLoading = false;
		}
	}
}

// --- Tab state ---
type ActiveTab = 'walkthrough' | 'diff' | 'request-changes';
let activeTab = $state<ActiveTab>('diff');

export function getActiveTab(): ActiveTab {
	return activeTab;
}

export function setActiveTab(tab: ActiveTab): void {
	if (tab === activeTab) return;
	// When leaving diff, reset focus-mode to sidebar to prevent stale state
	// when ReviewLayout is destroyed and later recreated
	if (activeTab === 'diff') {
		enterSidebarMode();
	}
	// Abort any in-flight explanation stream
	currentExplainController?.abort();
	currentExplainController = null;
	activeTab = tab;
}

// --- Context panel explanation state ---
export interface ExplanationEntry {
	filePath: string;
	lineRange: [number, number];
	codeSnippet: string;
	content: string;
	isStreaming: boolean;
}

let explanations = $state<ExplanationEntry[]>([]);
let activeExplanationIdx = $state<number>(-1);

export function getExplanations(): ExplanationEntry[] {
	return explanations;
}

export function getActiveExplanation(): ExplanationEntry | null {
	return explanations[activeExplanationIdx] ?? null;
}

export function startExplanation(entry: Omit<ExplanationEntry, 'content' | 'isStreaming'>): void {
	const newEntry: ExplanationEntry = { ...entry, content: '', isStreaming: true };
	explanations = [...explanations, newEntry];
	activeExplanationIdx = explanations.length - 1;
	requestPanelOpen();
}

export function appendExplanationChunk(chunk: string): void {
	if (activeExplanationIdx < 0) return;
	explanations = explanations.map((e, i) =>
		i === activeExplanationIdx ? { ...e, content: e.content + chunk } : e
	);
}

export function finishExplanation(): void {
	if (activeExplanationIdx < 0) return;
	explanations = explanations.map((e, i) =>
		i === activeExplanationIdx ? { ...e, isStreaming: false } : e
	);
}

export function setActiveExplanationIdx(idx: number): void {
	activeExplanationIdx = idx;
}

export function clearExplanations(): void {
	explanations = [];
	activeExplanationIdx = -1;
	explanationError = null;
	currentExplainController?.abort();
	currentExplainController = null;
}

// --- Explanation error state ---
let explanationError = $state<{ code: string; message: string } | null>(null);
let currentExplainController: AbortController | null = null;

export function getExplanationError(): { code: string; message: string } | null {
	return explanationError;
}

/**
 * Request an AI explanation by opening an SSE stream to the server.
 * Aborts any in-flight explanation before starting a new one.
 */
export function requestExplanation(params: {
	prId: string;
	filePath: string;
	lineRange: [number, number];
	codeSnippet: string;
}): void {
	// Abort any in-flight explanation
	currentExplainController?.abort();
	currentExplainController = null;
	explanationError = null;

	// Create the entry and open the panel
	startExplanation({
		filePath: params.filePath,
		lineRange: params.lineRange,
		codeSnippet: params.codeSnippet,
	});

	// Open SSE stream
	currentExplainController = streamExplanation(
		{
			prId: params.prId,
			filePath: params.filePath,
			startLine: params.lineRange[0],
			endLine: params.lineRange[1],
			codeSnippet: params.codeSnippet,
		},
		{
			onChunk: appendExplanationChunk,
			onDone: () => {
				finishExplanation();
				currentExplainController = null;
			},
		onError: (err: { code: string; message: string }) => {
			explanationError = err;
			toast.error(err.message || 'AI explanation failed');
			finishExplanation();
			currentExplainController = null;
		},
		}
	);
}

// --- Comment threads ---
let threads = $state<CommentThread[]>([]);
let threadMessages = $state<Record<string, ThreadMessage[]>>({});
let threadSyncErrors = $state<Set<string>>(new Set());
// Monotonic counter bumped on every thread mutation. Consumed inside reactive
// derivations that need to force-recompute (e.g. DiffViewer's annotations),
// because @pierre/diffs caches annotations by metadata reference.
let threadsVersion = $state(0);

export function getThreadsVersion(): number {
	return threadsVersion;
}

export function getThreadSyncError(threadId: string): boolean {
	return threadSyncErrors.has(threadId);
}

export function clearThreadSyncError(threadId: string): void {
	const next = new Set(threadSyncErrors);
	next.delete(threadId);
	threadSyncErrors = next;
}

export function getThreads(): CommentThread[] {
	return threads;
}

export function getThreadMessages(threadId: string): ThreadMessage[] {
	return threadMessages[threadId] ?? [];
}

export interface AddThreadParams {
	filePath: string;
	startLine: number;
	endLine: number;
	diffSide: 'old' | 'new';
	message: {
		authorRole: AuthorRole;
		authorName: string;
		body: string;
		messageType: MessageType;
		codeSuggestion?: string;
	};
}

/**
 * Create a new comment thread with an initial message.
 * Pessimistic: waits for server to create and return IDs.
 * Returns the created thread and message, or null on error.
 */
export async function addThread(
	params: AddThreadParams,
): Promise<{ thread: CommentThread; message: ThreadMessage } | null> {
	if (!sessionId) {
		console.error('[review] No active session — cannot create thread');
		return null;
	}

	const { data, error } = await api.api.reviews({ id: sessionId }).threads.post({
		filePath: params.filePath,
		startLine: params.startLine,
		endLine: params.endLine,
		diffSide: params.diffSide,
		message: params.message,
	});

	if (error || !data) {
		console.error('[review] Failed to create thread:', error);
		return null;
	}

	const result = data as { thread: CommentThread; message: ThreadMessage };

	// Update local state — guard against WS broadcast arriving first
	if (!threads.some((t) => t.id === result.thread.id)) {
		threads = [...threads, result.thread];
		threadMessages = {
			...threadMessages,
			[result.thread.id]: [result.message],
		};
		threadsVersion++;
	}

	// Fire-and-forget: push thread to GitHub
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	void (api.api.threads({ id: result.thread.id, threadId: result.thread.id } as any) as any).push.post().catch(() => {
		const next = new Set(threadSyncErrors);
		next.add(result.thread.id);
		threadSyncErrors = next;
	});

	return result;
}

/**
 * Add a message to an existing thread.
 * Pessimistic: waits for server response.
 */
export async function addThreadMessage(
	threadId: string,
	params: {
		authorRole: AuthorRole;
		authorName: string;
		body: string;
		messageType: MessageType;
		codeSuggestion?: string;
	},
): Promise<ThreadMessage | null> {
	const { data, error } = await api.api.threads({ id: threadId }).messages.post(params);

	if (error || !data) {
		console.error('[review] Failed to add message:', error);
		return null;
	}

	const message = data as ThreadMessage;

	// Guard against WS broadcast arriving first
	const existing = threadMessages[threadId] ?? [];
	if (!existing.some((m) => m.id === message.id)) {
		threadMessages = {
			...threadMessages,
			[threadId]: [...existing, message],
		};
	}

	// Fire-and-forget: push reply to GitHub
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	void (api.api.threads({ id: threadId, threadId } as any) as any).messages({ messageId: message.id }).push.post().catch(() => {
		threadSyncErrors = new Set([...threadSyncErrors, threadId]);
	});

	return message;
}

/**
 * Resolve a thread. Optimistic: updates UI immediately, reverts on API failure.
 */
export async function resolveThread(threadId: string): Promise<void> {
	// Optimistic update
	const prevThreads = threads;
	threads = threads.map((t) =>
		t.id === threadId
			? { ...t, status: 'resolved' as const, resolvedAt: new Date().toISOString() }
			: t
	);
	threadsVersion++;

	const { error } = await api.api.threads({ id: threadId }).patch({ status: 'resolved' });

	if (error) {
		console.error('[review] Failed to resolve thread, reverting:', error);
		threads = prevThreads;
		threadsVersion++;
		toast.error('Failed to resolve thread');
	}
}

/**
 * Reopen a resolved thread. Optimistic: updates UI immediately, reverts on API failure.
 */
export async function reopenThread(threadId: string): Promise<void> {
	// Optimistic update
	const prevThreads = threads;
	threads = threads.map((t) =>
		t.id === threadId
			? { ...t, status: 'open' as const, resolvedAt: null }
			: t
	);
	threadsVersion++;

	const { error } = await api.api.threads({ id: threadId }).patch({ status: 'open' });

	if (error) {
		console.error('[review] Failed to reopen thread, reverting:', error);
		threads = prevThreads;
		threadsVersion++;
	}
}

/**
 * Update a thread's status from a WebSocket message (no API call needed).
 */
export function updateThreadStatusFromWs(threadId: string, status: ThreadStatus): void {
	const isResolved = status === 'resolved' || status === 'wont_fix';
	threads = threads.map((t) =>
		t.id === threadId
			? {
					...t,
					status,
					resolvedAt: isResolved ? new Date().toISOString() : null,
				}
			: t
	);
	threadsVersion++;
}

/**
 * Push a thread and message from a WebSocket broadcast (no API call needed).
 */
export function addThreadFromWs(thread: CommentThread, message: ThreadMessage): void {
	if (!threads.some((t) => t.id === thread.id)) {
		threads = [...threads, thread];
		threadsVersion++;
	}
	// Always add the message if not already present
	const existing = threadMessages[thread.id] ?? [];
	if (!existing.some((m) => m.id === message.id)) {
		threadMessages = {
			...threadMessages,
			[thread.id]: [...existing, message],
		};
	}
}

/**
 * Push a message from a WebSocket broadcast (no API call needed).
 */
export function addMessageFromWs(threadId: string, message: ThreadMessage): void {
	// Avoid duplicates
	const existing = threadMessages[threadId] ?? [];
	if (existing.some((m) => m.id === message.id)) return;
	threadMessages = {
		...threadMessages,
		[threadId]: [...existing, message],
	};
}

export function getThreadsForFile(filePath: string): CommentThread[] {
	return threads.filter((t) => t.filePath === filePath);
}

// --- Diff view mode ---
type DiffMode = 'unified' | 'split';
let diffMode = $state<DiffMode>('unified');

export function getDiffMode(): DiffMode {
	return diffMode;
}

export function setDiffMode(mode: DiffMode): void {
	diffMode = mode;
}

// --- Panel open request (cross-component signal) ---
let panelOpenRequested = $state(false);

export function requestPanelOpen(): void {
	panelOpenRequested = true;
}

export function getPanelOpenRequested(): boolean {
	return panelOpenRequested;
}

export function consumePanelOpenRequest(): void {
	panelOpenRequested = false;
}

// --- Hunk accept/reject ---
// Tracks reviewer's accept/reject decisions per file.
// Accepted hunks are approved; rejected hunks are flagged for the coder.
let acceptedHunks = $state<Map<string, Set<number>>>(new Map());
let rejectedHunks = $state<Map<string, Set<number>>>(new Map());

export function getAcceptedHunks(filePath: string): Set<number> {
	return acceptedHunks.get(filePath) ?? new Set();
}

export function getRejectedHunks(filePath: string): Set<number> {
	return rejectedHunks.get(filePath) ?? new Set();
}

async function setHunkDecision(
	filePath: string,
	hunkIndex: number,
	decision: 'accepted' | 'rejected',
): Promise<void> {
	// Optimistic update
	const prevAccepted = new Map(acceptedHunks);
	const prevRejected = new Map(rejectedHunks);

	const opposite = decision === 'accepted' ? rejectedHunks : acceptedHunks;
	const own = decision === 'accepted' ? acceptedHunks : rejectedHunks;

	// Remove from the opposite map if present
	const oppSet = new Set(opposite.get(filePath) ?? []);
	if (oppSet.delete(hunkIndex)) {
		const next = new Map(opposite);
		next.set(filePath, oppSet);
		if (decision === 'accepted') rejectedHunks = next;
		else acceptedHunks = next;
	}

	// Add to own map
	const ownNext = new Map(own);
	const ownSet = new Set(ownNext.get(filePath) ?? []);
	ownSet.add(hunkIndex);
	ownNext.set(filePath, ownSet);
	if (decision === 'accepted') acceptedHunks = ownNext;
	else rejectedHunks = ownNext;

	// Persist
	if (sessionId) {
		const { error } = await api.api.reviews({ id: sessionId }).hunks.put({
			filePath,
			hunkIndex,
			decision,
		});
		if (error) {
			console.error(`[review] Failed to persist hunk ${decision}, reverting:`, error);
			acceptedHunks = prevAccepted;
			rejectedHunks = prevRejected;
			toast.error('Failed to save hunk decision');
		}
	}
}

export async function acceptHunk(filePath: string, hunkIndex: number): Promise<void> {
	return setHunkDecision(filePath, hunkIndex, 'accepted');
}

export async function rejectHunk(filePath: string, hunkIndex: number): Promise<void> {
	return setHunkDecision(filePath, hunkIndex, 'rejected');
}

export async function undoHunkAction(filePath: string, hunkIndex: number): Promise<void> {
	// Optimistic update
	const prevAccepted = new Map(acceptedHunks);
	const prevRejected = new Map(rejectedHunks);

	const nextA = new Map(acceptedHunks);
	const nextR = new Map(rejectedHunks);
	const aSet = new Set(nextA.get(filePath) ?? []);
	const rSet = new Set(nextR.get(filePath) ?? []);
	aSet.delete(hunkIndex);
	rSet.delete(hunkIndex);
	nextA.set(filePath, aSet);
	nextR.set(filePath, rSet);
	acceptedHunks = nextA;
	rejectedHunks = nextR;

	// Persist
	if (sessionId) {
		const { error } = await api.api
			.reviews({ id: sessionId })
			.hunks({ filePath: encodeURIComponent(filePath) })({ hunkIndex: String(hunkIndex) })
			.delete();
		if (error) {
			console.error('[review] Failed to persist hunk undo, reverting:', error);
			acceptedHunks = prevAccepted;
			rejectedHunks = prevRejected;
		}
	}
}

// --- Active file in diff ---
let activeFilePath = $state<string | null>(null);

export function getActiveFilePath(): string | null {
	return activeFilePath;
}

export function setActiveFilePath(path: string | null): void {
	activeFilePath = path;
}

// --- Apply suggestion ---
// Replaces the content of a thread's first message with the suggested code.
export async function applyCommentSuggestion(
	threadId: string,
	suggestion: string,
): Promise<void> {
	const messages = threadMessages[threadId];
	if (!messages || messages.length === 0) return;

	const updated = messages.map((msg, i) =>
		i === 0 ? { ...msg, codeSuggestion: suggestion } : msg
	);
	threadMessages = { ...threadMessages, [threadId]: updated };

	// Resolve the thread
	await resolveThread(threadId);
}
