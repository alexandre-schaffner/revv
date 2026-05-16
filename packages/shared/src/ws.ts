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

/** Server → client WebSocket envelope union. Each member carries a JSDoc
 * label: `signal` (notification only), `full-state` (replace client state),
 * or `delta` (patch existing state). Per conventions §3. */
export type WsServerMessage =
  /** full-state — Complete list of pull requests; replaces `pullRequests` array. */
  | { type: "prs:updated"; data: PullRequest[] }
  /**
   * delta — Single PR transitioned out of `'open'`. Patch `archivedPrs` and
   * `pullRequests` in place. Missed envelopes reconcile from DB on next
   * `prs:updated` or list-fetch.
   */
  | {
      type: "pr:archived";
      data: {
        prId: string;
        repoId: string;
        status: "closed" | "merged";
        closedAt: string;
      };
    }
  /** signal — Poll cycle started; flip UI spinner. */
  | { type: "prs:sync-started" }
  /**
   * signal — Poll cycle finished. `count` = PRs examined. `cached` / `refetched`
   * are diagnostics for the ETag cache hit ratio.
   */
  | {
      type: "prs:sync-complete";
      data: {
        count: number;
        timestamp: string;
        /** Number of GitHub REST responses served from ETag cache (304). */
        cached?: number;
        /** Number of GitHub REST responses fetched fresh (200). */
        refetched?: number;
      };
    }
  /** full-state — Complete list of repositories; replaces `repositories` array. */
  | { type: "repos:updated"; data: Repository[] }
  /** delta — Single repo clone status changed (e.g. cloning → ready). Patch in place. */
  | { type: "repos:clone-status"; data: { repoId: string; status: CloneStatus; error?: string } }
  /** full-state — Complete user object; replace `user` store. */
  | {
      type: "user:updated";
      data: {
        id: string;
        name: string;
        email: string;
        image: string | null;
        githubLogin: string | null;
      };
    }
  /** signal — Fatal server error (e.g. rate-limited). Show toast; `retryAfter` optional. */
  | { type: "error"; data: { code: string; message: string; retryAfter?: number } }
  /** delta — New comment thread created. Append to thread list. */
  | {
      type: "thread:created";
      data: { sessionId: string; thread: CommentThread; message: ThreadMessage };
    }
  /** delta — Thread status changed (open → resolved). Patch `thread.status`. */
  | { type: "thread:updated"; data: { threadId: string; status: ThreadStatus } }
  /** delta — New message appended to a thread. */
  | { type: "thread:message"; data: { threadId: string; message: ThreadMessage } }
  /** full-state — Complete thread summary for a PR after sync. Replace thread state. */
  | { type: "threads:synced"; data: { prId: string; summary: ThreadSummary; timestamp: string } }
  /** signal — Thread sync failed for a PR. Show toast; user reconciles on retry. */
  | { type: "threads:sync-error"; data: { prId: string; message: string } }
  /** delta — New reply posted to an existing thread. Append to thread.messages. */
  | {
      type: "threads:new-reply";
      data: { prId: string; thread: CommentThread; message: ThreadMessage };
    }
  /** signal — Walkthrough generation finished. Triggers `hydrateFromCache`. */
  | { type: "walkthrough:complete"; data: { prId: string; walkthroughId: string } }
  /** signal — Walkthrough generation failed terminally. Show error UI. */
  | { type: "walkthrough:error"; data: { prId: string; message: string } }
  /**
   * delta — Chat-driven post-completion edit broadcast. Wraps the same
   * `WalkthroughStreamEvent` shape the SSE generation path uses so the
   * frontend reducer can apply edits with the same code paths. The
   * generation SSE stream dies on `done`; this envelope rides the
   * long-lived WS channel so completed walkthroughs stay live-updatable.
   * See CLAUDE.md invariant #7 (chat-edit carve-out).
   */
  | {
      type: "walkthrough:edited";
      data: {
        prId: string;
        walkthroughId: string;
        event: WalkthroughStreamEvent;
      };
    }
  /** delta — Highlights of PR changes since last sync. Patch in place. */
  | { type: "prs:sync-summary"; data: SyncChange[] }
  /** delta — Thread deleted. Remove from list. */
  | { type: "thread:deleted"; data: { threadId: string } }
  /** delta — Message edited in a thread. Replace `message.body`. */
  | { type: "thread:message:edited"; data: { threadId: string; message: ThreadMessage } }
  /** delta — Message deleted from a thread. Remove from `messages`. */
  | { type: "thread:message:deleted"; data: { threadId: string; messageId: string } }
  /**
   * delta — Question resolved (answered or rejected) via the chat answer
   * endpoint. Broadcast so other clients see the card flip.
   */
  | {
      type: "chat:question-resolved";
      data: {
        prId: string;
        questionId: string;
        status: "answered" | "rejected";
        answers?: Record<string, ReadonlyArray<string>>;
        customAnswers?: Record<string, string>;
        /** If a pending plan was auto-superseded, its id. */
        supersededPlanId?: string;
      };
    }
  /**
   * signal — Project recap lifecycle transition. UI flips list-item state
   * without polling. Missed envelopes reconcile from DB on next list-fetch.
   */
  | {
      type: "recap:status-changed";
      data: {
        recapId: string;
        repoId: string;
        period: RecapPeriod;
        status: ProjectRecapStatus;
        completedAt?: string;
      };
    }
  /** full-state — New recap row (insert or regenerate). Replace/add in list. */
  | { type: "recap:added"; data: { recap: ProjectRecap } };

export type WsClientMessage =
  | { type: "prs:request-sync" }
  | { type: "threads:request-sync"; data: { prId: string } };
