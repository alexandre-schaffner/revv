// ── PR conversation ─────────────────────────────────────────────────────────
//
// What the Conversation tab shows: the GitHub "Conversation" page of a pull
// request (description, reviewers, assignees, labels, timeline) plus the CI
// rollup of its head commit. Fetched on demand from GitHub and cached as a
// snapshot; GitHub stays the source of truth, so nothing here is journaled.

import type { CodeownersFile } from "./codeowners";

/** A GitHub account as the conversation renders it. */
export interface ConversationActor {
  readonly login: string;
  readonly name: string | null;
  /**
   * Cached avatar as a data URL. Null on the wire: images travel once, in
   * `PrConversation.avatars`, and {@link hydrateConversationAvatars} fills
   * this in on the client. GitHub Enterprise avatar URLs are signed and
   * expire, so the raw URL never reaches the client.
   */
  readonly avatarContent: string | null;
  readonly kind: "user" | "bot" | "mannequin" | "ghost";
}

export interface PrLabel {
  readonly name: string;
  /** Six hex digits, no leading `#`, as GitHub stores it. */
  readonly color: string;
  readonly description: string | null;
}

/** A reviewer's latest verdict, as GitHub's sidebar reads it. */
export type ReviewVerdict = "approved" | "changes_requested" | "commented" | "dismissed";

export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type ReviewerEntry =
  | {
      readonly kind: "user";
      readonly actor: ConversationActor;
      /** A review is requested from them right now. */
      readonly requested: boolean;
      /** GitHub requested them because CODEOWNERS names them. */
      readonly asCodeOwner: boolean;
      readonly verdict: ReviewVerdict | null;
      readonly verdictAt: string | null;
    }
  | {
      readonly kind: "team";
      /** `org/slug`, the identity GitHub's REST API takes. */
      readonly combinedSlug: string;
      readonly slug: string;
      readonly name: string;
      readonly requested: true;
      readonly asCodeOwner: boolean;
    };

export interface LinkedIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed";
}

export interface PrMilestone {
  readonly title: string;
  readonly url: string;
  readonly dueOn: string | null;
  readonly state: "open" | "closed";
}

// ── Timeline ────────────────────────────────────────────────────────────────

interface TimelineBase {
  /** GitHub node id; stable across fetches. */
  readonly id: string;
  readonly createdAt: string;
}

export interface TimelineComment extends TimelineBase {
  readonly kind: "comment";
  readonly databaseId: number;
  readonly author: ConversationActor;
  readonly body: string;
  readonly edited: boolean;
  readonly url: string;
  readonly viewerCanUpdate: boolean;
  readonly viewerCanDelete: boolean;
}

export interface TimelineReview extends TimelineBase {
  readonly kind: "review";
  readonly author: ConversationActor;
  readonly verdict: ReviewVerdict;
  readonly body: string;
  readonly url: string;
  /** Line comments this review carried; they live on the Diff tab. */
  readonly inlineCommentCount: number;
}

export interface TimelineCommit extends TimelineBase {
  readonly kind: "commit";
  readonly sha: string;
  readonly headline: string;
  readonly messageBody: string;
  readonly author: ConversationActor;
  readonly url: string;
  /** null when the commit carries no signature. */
  readonly verified: boolean | null;
  readonly ci: CiRollupState | null;
}

/** One-line timeline entries: someone changed something about the PR. */
export type TimelineEvent = TimelineBase & { readonly actor: ConversationActor } & (
    | { readonly kind: "labeled" | "unlabeled"; readonly label: PrLabel }
    | { readonly kind: "assigned" | "unassigned"; readonly assignee: string }
    | {
        readonly kind: "review_requested" | "review_request_removed";
        /** A login, or `org/slug` for a team. */
        readonly reviewer: string;
        readonly reviewerIsTeam: boolean;
      }
    | {
        readonly kind: "review_dismissed";
        readonly reviewer: string | null;
        readonly message: string | null;
      }
    | {
        readonly kind: "force_pushed";
        readonly beforeSha: string | null;
        readonly afterSha: string | null;
      }
    | { readonly kind: "ready_for_review" | "converted_to_draft" | "closed" | "reopened" }
    | { readonly kind: "merged"; readonly commitSha: string | null; readonly baseRef: string }
    | { readonly kind: "renamed"; readonly from: string; readonly to: string }
    | { readonly kind: "added_to_stack" | "removed_from_stack"; readonly stackNumber: number }
    | {
        readonly kind: "cross_referenced";
        readonly source: {
          readonly type: "issue" | "pull_request";
          readonly number: number;
          readonly title: string;
          readonly url: string;
          readonly repo: string;
          readonly state: "open" | "closed" | "merged";
        };
      }
  );

export type TimelineItem = TimelineComment | TimelineReview | TimelineCommit | TimelineEvent;

// ── CI ──────────────────────────────────────────────────────────────────────

/** GitHub's combined state for a commit's checks and statuses. */
export type CiRollupState = "success" | "failure" | "pending" | "error" | "expected";

/** Where a check lands in the list: what the reviewer needs to act on first. */
export type CiCheckBucket = "fail" | "pending" | "pass" | "skip";

export interface CiCheck {
  /** Stable key: `run:<databaseId>` or `status:<context>`. */
  readonly key: string;
  readonly source: "check_run" | "status";
  readonly name: string;
  /** The Actions workflow that ran the job, when it is one. */
  readonly workflowName: string | null;
  /** The app that reported it ("GitHub Actions", "Vercel", …). */
  readonly appName: string | null;
  readonly bucket: CiCheckBucket;
  /** GitHub's raw conclusion or state, lower-cased ("timed_out", "cancelled", …). */
  readonly outcome: string;
  readonly description: string | null;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Branch protection requires it; null when the host can't say. */
  readonly required: boolean | null;
  /** Check-run id. For GitHub Actions it is also the job id. */
  readonly checkRunId: number | null;
  /** Actions workflow run, when the check is an Actions job. */
  readonly workflowRunId: number | null;
}

/**
 * Whether the token may read the head commit's checks. A GitHub App install
 * without `checks: read` / `statuses: read` sees the PR but not its CI, and
 * that must read as "can't see the checks", not "no checks".
 */
export type CiAccess = "granted" | "denied";

export interface CiRollup {
  readonly headSha: string;
  /** null when the head has no checks at all. */
  readonly state: CiRollupState | null;
  readonly checks: readonly CiCheck[];
}

export interface CheckAnnotation {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly level: "failure" | "warning" | "notice";
  readonly title: string | null;
  readonly message: string;
}

export interface CheckLogLine {
  readonly text: string;
  readonly kind: "error" | "warning" | "group" | "plain";
}

export interface CheckDetails {
  readonly checkRunId: number;
  /** Only completed checks have immutable output, regardless of log availability. */
  readonly completed: boolean;
  readonly title: string | null;
  /** The check's markdown summary, as the reporting app wrote it. */
  readonly summary: string | null;
  readonly annotations: readonly CheckAnnotation[];
  /** The failing step's log tail; null when there is no log to show. */
  readonly log: {
    readonly stepName: string | null;
    readonly lines: readonly CheckLogLine[];
    /** Lines were dropped from the top of the step. */
    readonly truncated: boolean;
  } | null;
  /** Why `log` is null, when it was asked for. */
  readonly logUnavailable: "not_actions" | "permission" | "expired" | "running" | null;
}

// ── Stack ───────────────────────────────────────────────────────────────────

/**
 * Where a stacked PR stands, as GitHub's stack list labels it: merged and
 * closed are final; an open PR is a draft, ready (mergeable once the PRs
 * under it land), or not ready (blocked by reviews, checks, or conflicts).
 */
export type StackEntryStatus = "merged" | "closed" | "draft" | "ready" | "not_ready";

export interface PrStackEntry {
  /** 1 sits on the base branch; each higher position stacks on the one below. */
  readonly position: number;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headRef: string;
  readonly status: StackEntryStatus;
}

// ── The whole page ──────────────────────────────────────────────────────────

export interface PrConversation {
  readonly prId: string;
  readonly number: number;
  readonly url: string;
  readonly body: string;
  readonly author: ConversationActor;
  readonly createdAt: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly reviewDecision: ReviewDecision | null;
  readonly viewerLogin: string;
  /** May edit the PR (title, body, reviewers, labels, assignees). */
  readonly viewerCanUpdate: boolean;
  /** Has write access to the repo: may re-run workflows. */
  readonly viewerCanPush: boolean;
  readonly labels: readonly PrLabel[];
  readonly assignees: readonly ConversationActor[];
  readonly reviewers: readonly ReviewerEntry[];
  readonly milestone: PrMilestone | null;
  readonly linkedIssues: readonly LinkedIssue[];
  /**
   * The base branch's CODEOWNERS, parsed. The client matches it against the
   * PR's changed files (it holds the file list). Null when the repo has none
   * or the token can't read contents.
   */
  readonly codeowners: CodeownersFile | null;
  readonly participants: readonly ConversationActor[];
  /** Oldest first. */
  readonly timeline: readonly TimelineItem[];
  /** The timeline hit the page cap; older-than-shown items exist on GitHub. */
  readonly timelineTruncated: boolean;
  readonly ci: CiRollup | null;
  readonly ciAccess: CiAccess;
  /**
   * Cached avatar data URLs by login, sent once rather than on every actor
   * (a busy timeline names the same people hundreds of times). Logins whose
   * avatar isn't cached yet are absent; the UI draws initials.
   */
  readonly avatars: Readonly<Record<string, string>>;
  readonly fetchedAt: string;
}

/** Fill each actor's `avatarContent` from the conversation's `avatars` map. */
export function hydrateConversationAvatars(conversation: PrConversation): PrConversation {
  const { avatars } = conversation;
  const actor = (a: ConversationActor): ConversationActor =>
    a.kind === "ghost" ? a : { ...a, avatarContent: avatars[a.login] ?? a.avatarContent };
  return {
    ...conversation,
    author: actor(conversation.author),
    assignees: conversation.assignees.map(actor),
    participants: conversation.participants.map(actor),
    reviewers: conversation.reviewers.map((r) =>
      r.kind === "user" ? { ...r, actor: actor(r.actor) } : r,
    ),
    timeline: conversation.timeline.map((t): TimelineItem => {
      switch (t.kind) {
        case "comment":
        case "review":
        case "commit":
          return { ...t, author: actor(t.author) };
        default:
          return { ...t, actor: actor(t.actor) };
      }
    }),
  };
}

/** `GET /api/prs/:id/conversation`. */
export interface PrConversationResponse {
  readonly conversation: PrConversation;
  /** Served from the snapshot cache because GitHub couldn't be reached. */
  readonly stale: boolean;
}

/**
 * A write the Conversation tab asks for: `POST /api/prs/:id/conversation/writes`.
 * The route validates the same union (and checks at compile time that its
 * schema still matches this type).
 */
export type ConversationWrite =
  | { kind: "request_reviewers"; users: string[]; teams: string[] }
  | { kind: "remove_reviewers"; users: string[]; teams: string[] }
  | { kind: "add_assignees"; logins: string[] }
  | { kind: "remove_assignees"; logins: string[] }
  | { kind: "add_labels"; names: string[] }
  | { kind: "remove_labels"; names: string[] }
  | { kind: "post_comment"; body: string }
  | { kind: "edit_comment"; commentId: number; body: string }
  | { kind: "delete_comment"; commentId: number }
  | { kind: "edit_body"; body: string }
  | { kind: "rerun_failed"; runIds: number[] }
  | { kind: "rerun_job"; jobId: number };

/**
 * The answer to a write that GitHub accepted. `conversation` is the re-read
 * after it, or null when that re-read failed: the write still landed, so
 * the client keeps its optimistic copy and reconciles later.
 */
export interface ConversationWriteResult {
  readonly conversation: PrConversation | null;
}

/** Picker rows for the sidebar's reviewer / assignee / label editors. */
export interface ActorOption {
  readonly login: string;
  readonly name: string | null;
  readonly avatarContent: string | null;
}

export interface TeamOption {
  readonly combinedSlug: string;
  readonly slug: string;
  readonly name: string;
}

export interface ReviewerOptions {
  readonly users: readonly ActorOption[];
  readonly teams: readonly TeamOption[];
}
