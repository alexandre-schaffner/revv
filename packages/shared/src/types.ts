export type PullRequestStatus = 'open' | 'closed' | 'merged';

export type ReviewStatus =
	| 'pending'
	| 'in_progress'
	| 'walkthrough_ready'
	| 'reviewed'
	| 'changes_proposed';

export type CloneStatus = 'pending' | 'cloning' | 'ready' | 'error';

export interface Repository {
	id: string;
	provider: string;
	owner: string;
	name: string;
	fullName: string;
	defaultBranch: string;
	avatarUrl: string | null;
	addedAt: string;
	cloneStatus: CloneStatus;
	clonePath: string | null;
	cloneError: string | null;
}

export interface PullRequest {
	id: string;
	externalId: number;
	repositoryId: string;
	title: string;
	body: string | null;
	authorLogin: string;
	authorAvatarUrl: string | null;
	requestedReviewers: string[];
	status: PullRequestStatus;
	reviewStatus: ReviewStatus;
	/** GitHub draft state — `true` while the PR is in draft. */
	isDraft: boolean;
	sourceBranch: string;
	targetBranch: string;
	url: string;
	additions: number;
	deletions: number;
	changedFiles: number;
	headSha: string | null;
	baseSha: string | null;
	createdAt: string;
	updatedAt: string;
	fetchedAt: string;
}

export type ThinkingEffort = 'ultrathink' | 'max' | 'extra-high' | 'high' | 'medium' | 'low';

export type ContextWindow = '200k' | '1m';

export type AiAgent = 'opencode' | 'claude';

/**
 * Scope of the sidebar's repo file tree on a PR review page.
 * - `'changed'`: only files modified in the PR's diff (the original behavior)
 * - `'all'`:     every file in the repo at the PR's head SHA, with diff
 *                files visually highlighted (the default since the
 *                tree-software integration)
 */
export type FileTreeScope = 'changed' | 'all';

export interface UserSettings {
	id: string;
	aiProvider: string;
	aiModel: string;
	aiThinkingEffort: ThinkingEffort;
	aiAgent: AiAgent;
	aiContextWindow: ContextWindow;
	/**
	 * Maximum number of agent turns (tool-use round trips) within a single
	 * chat turn or walkthrough generation. Higher values let complex PRs and
	 * long chat threads complete without truncation, at the cost of
	 * potentially longer runs.
	 */
	aiMaxTurns: number;
	theme: string;
	diffViewMode: string;
	autoFetchInterval: number;
	fileTreeScope: FileTreeScope;
}

// ── Review domain types ──────────────────────────────────────────────────────

export type SessionStatus = 'active' | 'completed' | 'abandoned';

export type ThreadStatus =
	| 'open'
	| 'pending_coder'
	| 'pending_reviewer'
	| 'resolved'
	| 'wont_fix';

export type AuthorRole = 'reviewer' | 'coder' | 'ai_agent';

export type MessageType = 'comment' | 'reply' | 'suggestion' | 'resolution';

export type HunkDecisionType = 'accepted' | 'rejected';

export interface ReviewSession {
	id: string;
	pullRequestId: string;
	startedAt: string;
	completedAt: string | null;
	status: SessionStatus;
}

export interface CommentThread {
	id: string;
	reviewSessionId: string;
	filePath: string;
	startLine: number;
	endLine: number;
	diffSide: 'old' | 'new';
	status: ThreadStatus;
	createdAt: string;
	resolvedAt: string | null;
	externalThreadId: string | null;
	externalCommentId: string | null;
	lastSyncedAt: string | null;
}

export interface ThreadSummary {
	total: number;
	open: number;
	pendingYou: number;
	pendingThem: number;
	resolved: number;
}

export type UserRole = 'reviewer' | 'coder' | 'unknown';

export interface UserIdentity {
	login: string | null;
	role: UserRole;
	/**
	 * The user's GitHub avatar URL. Refreshed server-side by the poll scheduler
	 * so that expired GitHub Enterprise signed URLs get rotated without
	 * requiring the user to sign out and back in.
	 */
	avatarUrl: string | null;
}

export interface Org {
	login: string;
	avatarUrl: string | null;
}

export interface ThreadMessage {
	id: string;
	threadId: string;
	authorRole: AuthorRole;
	authorName: string;
	authorAvatarUrl: string | null;
	body: string;
	messageType: MessageType;
	codeSuggestion: string | null;
	createdAt: string;
	editedAt: string | null;
	externalId: string | null;
}

export interface HunkDecision {
	id: string;
	reviewSessionId: string;
	filePath: string;
	hunkIndex: number;
	decision: HunkDecisionType;
	decidedAt: string;
}

export type SyncChangeKind = 'review_requested' | 'pr_updated' | 'pr_closed' | 'pr_authored';

export interface SyncChange {
	kind: SyncChangeKind;
	prId: string;
	prTitle: string;
	prNumber: number;
	repoFullName: string;
}
