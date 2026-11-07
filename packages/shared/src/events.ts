// Envelopes on the `GET /api/events` SSE stream: one per client tab, the only
// server → client realtime channel. Inbound commands use REST endpoints.

import type { HunkScanRow, HunkScanStatus } from "./hunk-scan";
import type {
  CloneStatus,
  MergeEligibility,
  PullRequest,
  Repository,
  SyncChange,
} from "./pull-requests";
import type { ProjectRecap, ProjectRecapStatus, RecapPeriod } from "./recap";
import type { CommentThread, ThreadMessage, ThreadStatus } from "./review";
import type { StackBriefStatus, StackMergeRun } from "./stacks";
import type { WalkthroughDurableEvent, WalkthroughLiveEvent } from "./walkthrough";

/**
 * A walkthrough's content or lifecycle event (see `WalkthroughDurableEvent`).
 *
 *   prId           — the PR this walkthrough belongs to; the client keys its
 *                    entries on it.
 *   walkthroughId  — the row; scopes the client's `lastSeenSeq` cursor so it
 *                    resets across regenerate/supersede.
 *   seq            — `walkthroughs.next_seq`, bumped in the DB for every
 *                    durable event. The client drops `seq <= lastSeenSeq`
 *                    (the reconnect race) and re-reads the row to catch up.
 */
export interface WalkthroughEventEnvelope {
  type: "walkthrough:event";
  data: {
    prId: string;
    walkthroughId: string;
    seq: number;
    event: WalkthroughDurableEvent;
  };
}

/** A live-only walkthrough event (see `WalkthroughLiveEvent`): no seq, never replayed. */
export interface WalkthroughLiveEnvelope {
  type: "walkthrough:live";
  data: {
    prId: string;
    walkthroughId: string;
    event: WalkthroughLiveEvent;
  };
}

// First pass, per PR head and independent of any walkthrough. Rows are
// committed to `hunk_scan_rows` before each event, so a client that misses one
// reconciles from `POST /api/reviews/:id/hunk-scan`. Every arm is keyed on
// `(prId, headSha)`: a pull starts a new scan rather than mutating the old one.

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

/**
 * Signal: the PR's diff files for `headSha` landed in the server's diff cache.
 * Previews that answered `pending` because the diff wasn't cached yet (sizing,
 * the first pass) ask again for that head.
 */
export interface DiffCachedEnvelope {
  type: "diff:cached";
  data: { prId: string; headSha: string };
}

/**
 * Full state: whether the viewer can merge the PR, once GitHub finished
 * computing mergeability (or the server stopped waiting; the answer may then
 * still be settling). Follows a `GET /api/prs/:id/merge-eligibility` that
 * answered while GitHub was still computing.
 */
export interface PrMergeEligibilityEnvelope {
  type: "pr:merge-eligibility";
  data: { prId: string; eligibility: MergeEligibility };
}

/**
 * Signal: the server stopped waiting on GitHub's repo statistics after a
 * `GET /api/repos/:id/activity` answered `computing`. `ready` is whether
 * they're in; when they are, re-read the activity. When not, GitHub is still
 * computing and the client stops waiting.
 */
export interface RepoActivitySettledEnvelope {
  type: "repo-activity:settled";
  data: { repoId: string; ready: boolean };
}

/**
 * Signal: this account changed the PR's GitHub conversation (a comment,
 * reviewers, assignees, labels, the description, a CI re-run).
 *
 * `fetchedAt` stamps the snapshot the server re-read and cached after the
 * write. A view already holding a conversation at least that fresh (the one
 * that made the write) ignores the signal; any other reads the cached
 * snapshot via `GET /api/prs/:id/conversation/cached`, which costs GitHub
 * nothing. Null when the re-read failed: re-read from GitHub.
 */
export interface PrConversationUpdatedEnvelope {
  type: "pr:conversation-updated";
  data: { prId: string; fetchedAt: string | null };
}

/**
 * Signal: something a stack's detail shows moved — a member's place, head or
 * base (seen by the poll), a member's walkthrough lifecycle, or a merge. The
 * server dropped its cached GitHub read; a view showing this stack re-reads
 * `GET /api/prs/:id/stack`. `repositoryId` + `stackNumber` are routing keys.
 */
export interface StackUpdatedEnvelope {
  type: "stack:updated";
  data: { repositoryId: string; stackNumber: number };
}

/** Full state: a stack merge run after every step it takes. */
export interface StackMergeProgressEnvelope {
  type: "stack-merge:progress";
  data: StackMergeRun;
}

/**
 * Signal: a stack brief changed lifecycle. The brief itself rides on the
 * stack detail; a view showing this stack re-reads it.
 */
export interface StackBriefStatusChangedEnvelope {
  type: "stack-brief:status-changed";
  data: { repositoryId: string; stackNumber: number; briefId: string; status: StackBriefStatus };
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

/**
 * Full state of the signed-in user's GitHub identity, after GitHub reported a
 * new login or avatar. `avatarContent` is the cached data URL, as on
 * `UserIdentity`: GitHub Enterprise avatar URLs are signed and expire.
 */
export interface UserUpdatedEnvelope {
  type: "user:updated";
  data: {
    id: string;
    name: string;
    email: string;
    avatarContent: string | null;
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

/** Delta: a thread and its first message, on `prId`'s review. */
export interface ThreadCreatedEnvelope {
  type: "thread:created";
  data: { prId: string; thread: CommentThread; message: ThreadMessage };
}

export interface ThreadUpdatedEnvelope {
  type: "thread:updated";
  /** Full state of the thread's status: `resolvedAt` is null unless the status resolves it. */
  data: { threadId: string; status: ThreadStatus; resolvedAt: string | null };
}

/** Delta: a new message on a thread. An edit to an existing one is `thread:message:edited`. */
export interface ThreadMessageEnvelope {
  type: "thread:message";
  data: { threadId: string; message: ThreadMessage };
}

export interface ThreadsSyncedEnvelope {
  type: "threads:synced";
  data: { prId: string; timestamp: string };
}

export interface PrsSyncSummaryEnvelope {
  type: "prs:sync-summary";
  data: SyncChange[];
}

export interface ThreadDeletedEnvelope {
  type: "thread:deleted";
  data: { threadId: string };
}

/** Full state of one message whose body changed, in Revv or on GitHub. */
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

export type ThreadEventMessage =
  | ThreadCreatedEnvelope
  | ThreadUpdatedEnvelope
  | ThreadMessageEnvelope
  | ThreadsSyncedEnvelope
  | ThreadDeletedEnvelope
  | ThreadMessageEditedEnvelope
  | ThreadMessageDeletedEnvelope
  | ThreadsSyncErrorEnvelope;

export type ServerEventMessage =
  | WalkthroughEventEnvelope
  | WalkthroughLiveEnvelope
  | HunkScanEventMessage
  | PrsUpdatedEnvelope
  | PrArchivedEnvelope
  | PrConversationUpdatedEnvelope
  | DiffCachedEnvelope
  | PrMergeEligibilityEnvelope
  | RepoActivitySettledEnvelope
  | StackUpdatedEnvelope
  | StackMergeProgressEnvelope
  | StackBriefStatusChangedEnvelope
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
  | RecapStatusChangedEnvelope
  | RecapAddedEnvelope;
