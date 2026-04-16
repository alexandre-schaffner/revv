import type { PullRequest, Repository, CommentThread, ThreadMessage, ThreadStatus, CloneStatus } from './types';

export type WsServerMessage =
	| { type: 'prs:updated'; data: PullRequest[] }
	| { type: 'prs:sync-started' }
	| { type: 'prs:sync-complete'; data: { count: number; timestamp: string } }
	| { type: 'repos:updated'; data: Repository[] }
	| { type: 'repos:clone-status'; data: { repoId: string; status: CloneStatus; error?: string } }
	| { type: 'error'; data: { code: string; message: string; retryAfter?: number } }
	| { type: 'thread:created'; data: { sessionId: string; thread: CommentThread; message: ThreadMessage } }
	| { type: 'thread:updated'; data: { threadId: string; status: ThreadStatus } }
	| { type: 'thread:message'; data: { threadId: string; message: ThreadMessage } };

export type WsClientMessage = { type: 'prs:request-sync' };
