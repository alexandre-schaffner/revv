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

export type WsServerMessage =
  | { type: "prs:updated"; data: PullRequest[] }
  | { type: "prs:sync-started" }
  | {
      type: "prs:sync-complete";
      data: {
        count: number;
        timestamp: string;
        /** Number of GitHub REST responses served from ETag cache (304) during this cycle. */
        cached?: number;
        /** Number of GitHub REST responses fetched fresh (200) during this cycle. */
        refetched?: number;
      };
    }
  | { type: "repos:updated"; data: Repository[] }
  | { type: "repos:clone-status"; data: { repoId: string; status: CloneStatus; error?: string } }
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
  | { type: "error"; data: { code: string; message: string; retryAfter?: number } }
  | {
      type: "thread:created";
      data: { sessionId: string; thread: CommentThread; message: ThreadMessage };
    }
  | { type: "thread:updated"; data: { threadId: string; status: ThreadStatus } }
  | { type: "thread:message"; data: { threadId: string; message: ThreadMessage } }
  | { type: "threads:synced"; data: { prId: string; summary: ThreadSummary; timestamp: string } }
  | { type: "threads:sync-error"; data: { prId: string; message: string } }
  | {
      type: "threads:new-reply";
      data: { prId: string; thread: CommentThread; message: ThreadMessage };
    }
  | { type: "walkthrough:complete"; data: { prId: string; walkthroughId: string } }
  | { type: "walkthrough:error"; data: { prId: string; message: string } }
  /**
   * Chat-driven post-completion edit broadcast. Wraps the same
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
  | { type: "prs:sync-summary"; data: SyncChange[] }
  | { type: "thread:deleted"; data: { threadId: string } }
  | { type: "thread:message:edited"; data: { threadId: string; message: ThreadMessage } }
  | { type: "thread:message:deleted"; data: { threadId: string; messageId: string } }
  /**
   * Question resolved (answered or rejected) via the chat answer endpoint.
   * Broadcast so other connected clients viewing the same PR's chat see
   * the card flip to its terminal state.
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
    };

export type WsClientMessage =
  | { type: "prs:request-sync" }
  | { type: "threads:request-sync"; data: { prId: string } };
