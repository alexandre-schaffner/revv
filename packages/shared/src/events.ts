// ── Global event stream (SSE) envelopes ─────────────────────────────────────
//
// Server → client messages delivered over the long-lived `GET /api/events`
// SSE connection. One stream per client tab, lifetime = session.
//
// This is the single server -> client realtime channel. Inbound commands use
// REST endpoints instead of this stream.

import type { HunkScanRow, HunkScanStatus } from "./hunk-scan";
import type {
  NewPrCommit,
  NewPrMessage,
  NewPrSession,
  NewPrSessionSnapshot,
  NewPrSessionStatus,
} from "./new-pr-session";
import type { ProjectRecap, ProjectRecapStatus, RecapPeriod } from "./recap";
import type {
  CloneStatus,
  CommentThread,
  PullRequest,
  Repository,
  SyncChange,
  ThreadMessage,
  ThreadStatus,
  ThreadSummary,
} from "./types";
import type { WalkthroughStreamEvent } from "./walkthrough";

/**
 * Per-event envelope for walkthrough content + lifecycle. Replaces the
 * legacy per-PR walkthrough SSE stream and the four standalone WS
 * lifecycle envelopes (`walkthrough:complete`, `walkthrough:error`,
 * `walkthrough:cache-hit`, `walkthrough:edited`).
 *
 *   prId           — the PR this walkthrough belongs to (route key on the
 *                    client; entries are stored by prId for sidebar +
 *                    detail-view consumption regardless of active page).
 *   walkthroughId  — DB row id; used to scope `lastSeenSeq` cursors so the
 *                    cursor naturally resets across regenerate/supersede
 *                    boundaries.
 *   seq            — monotonic per-walkthrough counter sourced from
 *                    `walkthroughs.next_seq` (atomic with content writes).
 *                    Client drops envelopes with `seq <= lastSeenSeq` for
 *                    the in-flight reconnect race. See SSE-rewrite plan §4.2.
 *   event          — the actual payload (content event, lifecycle event,
 *                    or chat-edit deletion). Same union the legacy SSE used,
 *                    extended with `lifecycle:*` variants.
 */
export interface WalkthroughEventEnvelope {
  type: "walkthrough:event";
  data: {
    prId: string;
    walkthroughId: string;
    seq: number;
    event: WalkthroughStreamEvent;
  };
}

// ── First pass (per PR head, independent of any walkthrough) ───────────────
//
// Rows are committed to `hunk_scan_rows` before each event, so a client that
// misses one reconciles from `POST /api/reviews/:id/hunk-scan`. Every arm is
// keyed on `(prId, headSha)`: a pull starts a new scan rather than mutating
// the old one.

/**
 * Full-state: every hunk the scan will consider, skipped ones included, with
 * `signals: null` for the rows still to be asked. Re-sent when a scan cut off
 * mid-run (a restart) picks up again; replaces what the client holds.
 */
export interface HunkScanStartedEnvelope {
  type: "hunk-scan:started";
  data: { prId: string; headSha: string; rows: HunkScanRow[] };
}

/** Delta: one row after Jev answered it. Keyed on `(filePath, hunkIndex)`. */
export interface HunkScanHunkEnvelope {
  type: "hunk-scan:hunk";
  data: { prId: string; headSha: string; row: HunkScanRow };
}

/**
 * Signal: the scan is over, with its persisted outcome. On `partial` the
 * unanswered rows are now `unscanned`; on `failed` the rows are deleted and
 * the client drops them.
 */
export interface HunkScanCompleteEnvelope {
  type: "hunk-scan:complete";
  data: {
    prId: string;
    headSha: string;
    status: Exclude<HunkScanStatus, "running">;
    scanned: number;
    flagged: number;
    durationMs: number;
  };
}

export type HunkScanEventMessage =
  | HunkScanStartedEnvelope
  | HunkScanHunkEnvelope
  | HunkScanCompleteEnvelope;

export interface PrsUpdatedEnvelope {
  type: "prs:updated";
  data: PullRequest[];
}

export interface PrArchivedEnvelope {
  type: "pr:archived";
  data: {
    prId: string;
    repoId: string;
    status: "closed" | "merged";
    closedAt: string;
  };
}

export interface PrsSyncStartedEnvelope {
  type: "prs:sync-started";
}

export interface PrsSyncCompleteEnvelope {
  type: "prs:sync-complete";
  data: {
    count: number;
    timestamp: string;
    cached?: number;
    refetched?: number;
  };
}

export interface ReposUpdatedEnvelope {
  type: "repos:updated";
  data: Repository[];
}

export interface ReposCloneStatusEnvelope {
  type: "repos:clone-status";
  data: { repoId: string; status: CloneStatus; error?: string };
}

export interface UserUpdatedEnvelope {
  type: "user:updated";
  data: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    githubLogin: string | null;
  };
}

export interface ErrorEnvelope {
  type: "error";
  data: { code: string; message: string; retryAfter?: number };
}

export interface AuthReauthRequiredEnvelope {
  type: "auth:reauth-required";
  data: { host: string; githubLogin: string | null };
}

export interface AuthReauthClearedEnvelope {
  type: "auth:reauth-cleared";
  data: { host: string };
}

export interface ThreadCreatedEnvelope {
  type: "thread:created";
  data: { sessionId: string; thread: CommentThread; message: ThreadMessage };
}

export interface ThreadUpdatedEnvelope {
  type: "thread:updated";
  data: { threadId: string; status: ThreadStatus };
}

export interface ThreadMessageEnvelope {
  type: "thread:message";
  data: { threadId: string; message: ThreadMessage };
}

export interface ThreadsSyncedEnvelope {
  type: "threads:synced";
  data: { prId: string; summary: ThreadSummary; timestamp: string };
}

export interface ThreadsNewReplyEnvelope {
  type: "threads:new-reply";
  data: { prId: string; thread: CommentThread; message: ThreadMessage };
}

export interface PrsSyncSummaryEnvelope {
  type: "prs:sync-summary";
  data: SyncChange[];
}

export interface ThreadDeletedEnvelope {
  type: "thread:deleted";
  data: { threadId: string };
}

export interface ThreadMessageEditedEnvelope {
  type: "thread:message:edited";
  data: { threadId: string; message: ThreadMessage };
}

export interface ThreadMessageDeletedEnvelope {
  type: "thread:message:deleted";
  data: { threadId: string; messageId: string };
}

export interface ThreadsSyncErrorEnvelope {
  type: "threads:sync-error";
  data: { prId: string; message: string };
}

export interface ChatQuestionResolvedEnvelope {
  type: "chat:question-resolved";
  data: {
    prId: string;
    questionId: string;
    status: "answered" | "rejected";
    answers?: Record<string, ReadonlyArray<string>>;
    customAnswers?: Record<string, string>;
    supersededPlanId?: string;
  };
}

export interface RecapStatusChangedEnvelope {
  type: "recap:status-changed";
  data: {
    recapId: string;
    repoId: string;
    period: RecapPeriod;
    status: ProjectRecapStatus;
    completedAt?: string | null;
    errorMessage?: string | null;
  };
}

export interface RecapAddedEnvelope {
  type: "recap:added";
  data: { recap: ProjectRecap };
}

export interface NewPrSessionCreatedEnvelope {
  type: "new-pr-session:created";
  data: { snapshot: NewPrSessionSnapshot };
}

export interface NewPrSessionMessageAppendedEnvelope {
  type: "new-pr-session:message-appended";
  data: { sessionId: string; message: NewPrMessage };
}

export interface NewPrSessionAgentTurnStartedEnvelope {
  type: "new-pr-session:agent-turn-started";
  data: { sessionId: string; turnId: string };
}

export interface NewPrSessionAgentTurnEndedEnvelope {
  type: "new-pr-session:agent-turn-ended";
  data: {
    sessionId: string;
    turnId: string;
    status: "completed" | "interrupted" | "error";
    errorMessage?: string;
  };
}

export interface NewPrSessionCommitRecordedEnvelope {
  type: "new-pr-session:commit-recorded";
  data: { sessionId: string; commit: NewPrCommit };
}

export interface NewPrSessionMetadataUpdatedEnvelope {
  type: "new-pr-session:metadata-updated";
  data: {
    sessionId: string;
    title?: string | null;
    body?: string | null;
  };
}

export interface NewPrSessionWorktreeChangedEnvelope {
  type: "new-pr-session:worktree-changed";
  data: { sessionId: string; changedPaths: ReadonlyArray<string> };
}

export interface NewPrSessionSyncedEnvelope {
  type: "new-pr-session:synced";
  data: { sessionId: string; newBaseSha: string };
}

export interface NewPrSessionSyncConflictedEnvelope {
  type: "new-pr-session:sync-conflicted";
  data: { sessionId: string; conflictedPaths: ReadonlyArray<string> };
}

export interface NewPrSessionStatusChangedEnvelope {
  type: "new-pr-session:status-changed";
  data: {
    sessionId: string;
    status: NewPrSessionStatus;
    errorMessage?: string;
  };
}

export interface NewPrSessionPrOpenedEnvelope {
  type: "new-pr-session:pr-opened";
  data: {
    sessionId: string;
    prId: string;
    externalId: number;
    url: string;
  };
}

export interface NewPrSessionUpdatedEnvelope {
  type: "new-pr-session:updated";
  data: { session: NewPrSession };
}

export type ThreadEventMessage =
  | ThreadCreatedEnvelope
  | ThreadUpdatedEnvelope
  | ThreadMessageEnvelope
  | ThreadsSyncedEnvelope
  | ThreadsNewReplyEnvelope
  | ThreadDeletedEnvelope
  | ThreadMessageEditedEnvelope
  | ThreadMessageDeletedEnvelope
  | ThreadsSyncErrorEnvelope;

export type ServerEventMessage =
  | WalkthroughEventEnvelope
  | HunkScanEventMessage
  | PrsUpdatedEnvelope
  | PrArchivedEnvelope
  | PrsSyncStartedEnvelope
  | PrsSyncCompleteEnvelope
  | ReposUpdatedEnvelope
  | ReposCloneStatusEnvelope
  | UserUpdatedEnvelope
  | ErrorEnvelope
  | AuthReauthRequiredEnvelope
  | AuthReauthClearedEnvelope
  | ThreadEventMessage
  | PrsSyncSummaryEnvelope
  | ChatQuestionResolvedEnvelope
  | RecapStatusChangedEnvelope
  | RecapAddedEnvelope
  | NewPrSessionCreatedEnvelope
  | NewPrSessionMessageAppendedEnvelope
  | NewPrSessionAgentTurnStartedEnvelope
  | NewPrSessionAgentTurnEndedEnvelope
  | NewPrSessionCommitRecordedEnvelope
  | NewPrSessionMetadataUpdatedEnvelope
  | NewPrSessionWorktreeChangedEnvelope
  | NewPrSessionSyncedEnvelope
  | NewPrSessionSyncConflictedEnvelope
  | NewPrSessionStatusChangedEnvelope
  | NewPrSessionPrOpenedEnvelope
  | NewPrSessionUpdatedEnvelope;
