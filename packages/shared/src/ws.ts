import type { PullRequest, Repository, CommentThread, ThreadMessage, ThreadStatus, ThreadSummary, CloneStatus, SyncChange } from './types';

export type WsServerMessage =
	| { type: 'prs:updated'; data: PullRequest[] }
	| { type: 'prs:sync-started' }
	| {
			type: 'prs:sync-complete';
			data: {
				count: number;
				timestamp: string;
				/** Number of GitHub REST responses served from ETag cache (304) during this cycle. */
				cached?: number;
				/** Number of GitHub REST responses fetched fresh (200) during this cycle. */
				refetched?: number;
			};
	  }
	| { type: 'repos:updated'; data: Repository[] }
	| { type: 'repos:clone-status'; data: { repoId: string; status: CloneStatus; error?: string } }
	| { type: 'error'; data: { code: string; message: string; retryAfter?: number } }
	| { type: 'thread:created'; data: { sessionId: string; thread: CommentThread; message: ThreadMessage } }
	| { type: 'thread:updated'; data: { threadId: string; status: ThreadStatus } }
	| { type: 'thread:message'; data: { threadId: string; message: ThreadMessage } }
	| { type: 'threads:synced'; data: { prId: string; summary: ThreadSummary; timestamp: string } }
	| { type: 'threads:sync-error'; data: { prId: string; message: string } }
	| { type: 'threads:new-reply'; data: { prId: string; thread: CommentThread; message: ThreadMessage } }
	| { type: 'walkthrough:complete'; data: { prId: string; walkthroughId: string } }
	| { type: 'walkthrough:error'; data: { prId: string; message: string } }
	| { type: 'prs:sync-summary'; data: SyncChange[] }
	| { type: 'thread:deleted'; data: { threadId: string } }
	| { type: 'thread:message:edited'; data: { threadId: string; message: ThreadMessage } }
	| { type: 'thread:message:deleted'; data: { threadId: string; messageId: string } }
	| { type: 'cache:invalidated'; data: { scope: 'pr'; prId: string; reasons: string[] } };

export type WsClientMessage =
	| { type: 'prs:request-sync' }
	| { type: 'threads:request-sync'; data: { prId: string } };
