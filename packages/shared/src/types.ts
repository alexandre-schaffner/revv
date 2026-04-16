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
	status: PullRequestStatus;
	reviewStatus: ReviewStatus;
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

export type ThinkingEffort = 'low' | 'medium' | 'high';

export type AiAgent = 'opencode' | 'claude';

export interface UserSettings {
	id: string;
	aiProvider: string;
	aiModel: string;
	aiThinkingEffort: ThinkingEffort;
	aiAgent: AiAgent;
	theme: string;
	diffViewMode: string;
	autoFetchInterval: number;
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
}

export interface ThreadMessage {
	id: string;
	threadId: string;
	authorRole: AuthorRole;
	authorName: string;
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
