import type { AcpAgentId } from "./acp-agents";
import type { UpdateChannel } from "./constants";

export type PullRequestStatus = "open" | "closed" | "merged";

export type ReviewStatus =
  | "pending"
  | "in_progress"
  | "walkthrough_ready"
  | "reviewed"
  | "changes_proposed";

export type CloneStatus = "pending" | "cloning" | "ready" | "error";

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
  managed: boolean;
  githubHost: string;
}

export interface PullRequest {
  id: string;
  externalId: number;
  repositoryId: string;
  title: string;
  body: string | null;
  authorLogin: string;
  /** Base64 data URL of the author's avatar (e.g. "data:image/png;base64,..."). */
  authorAvatarContent: string | null;
  /** Raw avatar URL from the provider — used internally during sync to populate remote_users. */
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
  closedAt: string | null;
}

export type ThinkingEffort = "ultrathink" | "max" | "extra-high" | "high" | "medium" | "low";

export type ContextWindow = "200k" | "1m";

/**
 * Per-feature override for which agent generates project recaps.
 * `'auto'` (default) inherits the global `aiAgent`; an explicit ACP agent id
 * pins recap generation to that agent regardless of the global choice. Lets a
 * user run Claude Code for interactive walkthroughs but keep background recaps
 * on opencode (cheaper, unattended), or vice versa.
 */
export type RecapAgentChoice = "auto" | AcpAgentId;

/**
 * Event frames emitted over SSE while the server runs the opencode install
 * script (`curl … | bash` on macOS/Linux, `irm … | iex` on Windows). The
 * stream closes after `done`; on failure the message lives in `error`.
 */
export type InstallEvent =
  | { type: "log"; line: string }
  | { type: "done"; success: boolean; error?: string };

export type ThemePreference = "system" | "light" | "dark";

export type DiffViewMode = "unified" | "split";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface MergeEligibility {
  canMerge: boolean;
  mergeable: boolean;
  mergeStateStatus: string;
}

export interface UserSettings {
  id: string;
  aiProvider: string;
  aiModel: string;
  aiThinkingEffort: ThinkingEffort;
  /**
   * Selected ACP agent id (one of `ACP_AGENTS`, e.g. `claude-code`, `opencode`,
   * `codex`, `cursor`). The single agent that drives chat, walkthrough, and
   * recap generation.
   */
  aiAgent: AcpAgentId;
  aiContextWindow: ContextWindow;
  /**
   * Low-cost model used for one-shot, no-tools PR-aware suggestion
   * generation (right-panel empty-state prompts). Follows the global
   * `aiAgent` — picked from that agent's catalog. Defaults to a cheap model
   * (e.g. Haiku for Claude Code) so generating suggestions for every PR open
   * doesn't burn the same tokens as the main review agent.
   */
  aiSuggestionsModel: string;
  /**
   * Maximum number of agent turns (tool-use round trips) within a single
   * chat turn or walkthrough generation. Higher values let complex PRs and
   * long chat threads complete without truncation, at the cost of
   * potentially longer runs.
   */
  aiMaxTurns: number;
  theme: ThemePreference;
  diffViewMode: DiffViewMode;
  autoFetchInterval: number;
  /**
   * Daily / weekly project-recap scheduler toggles. v1 keeps this minimal —
   * just on/off per cadence; no custom hour-of-day. UTC throughout (see
   * plan: cross-cutting decisions). Adding finer-grained scheduling later
   * doesn't need a wire-format change since this is a nested object.
   */
  recap: {
    enabled: boolean;
    dailyEnabled: boolean;
    weeklyEnabled: boolean;
    /**
     * Per-feature agent override. `'auto'` (default) follows the global
     * `aiAgent`; an explicit ACP agent id pins recap generation to that
     * agent regardless of the global choice.
     */
    agent: RecapAgentChoice;
  };
  /**
   * GitHub host the app authenticates against. `'github.com'` for public
   * GitHub (the default), or any GitHub Enterprise host the user enters
   * during onboarding. Consumed by the device-flow routes to build per-host
   * OAuth and API URLs.
   */
  githubHost: string;
  /**
   * GitHub OAuth/App client ID for a user-added GitHub Enterprise host.
   * Empty string for `github.com`, whose client ID comes from server config.
   * When a user points Revv at their own GHE instance they register a GitHub
   * App there and paste its public client ID here — there is no bundled
   * registration on a customer's host. An `Iv…` prefix marks a GitHub App
   * (device flow sends no scope); `Ov…` marks a classic OAuth App.
   */
  githubClientId: string;
  /**
   * Team-shared walkthrough cache settings. Backed by a single GCS
   * bucket — IAM grants are the team boundary. When `enabled` is off,
   * the entire feature short-circuits (no probe, no upload, no
   * download). The two direction toggles let a teammate participate
   * read-only or write-only.
   */
  cache: {
    enabled: boolean;
    bucket: string;
    uploadsEnabled: boolean;
    downloadsEnabled: boolean;
    /**
     * SSHSIG-based content signing. Signs blobs on push and verifies
     * on fetch using the uploader's GitHub SSH key and repo-level
     * collaborator permission as the trust anchor.
     */
    signing: {
      /** `'strict'` (default) rejects unsigned/invalid blobs; `'permissive'` warns but accepts; `'off'` skips crypto entirely. */
      mode: "off" | "permissive" | "strict";
      /** Path to the SSH private key. Empty string = auto-detect from `~/.ssh/`. */
      keyPath: string;
      /** GitHub hosts whose signers are trusted. Defaults to the user's authenticated hosts. */
      trustedSignerHosts: string[];
    };
  };
  /**
   * Release channel the in-app updater (and `revv update` CLI) reads from.
   * `'stable'` (default) tracks the latest `vX.Y.Z` tag published by
   * release-please. `'nightly'` tracks the moving `nightly` tag — built from
   * every push to `main`. Nightly users skip the 48-hour stable cooldown so
   * they're notified of new builds instantly.
   */
  updateChannel: UpdateChannel;
}

// ── Review domain types ──────────────────────────────────────────────────────

export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * Review perspective for a PR. Not a user choice — derived from identity:
 * `author` when the signed-in user is the PR's creator (self-review),
 * otherwise `reviewer`. Const-object "enum" (mirrors `PIERRE_THEME`) so the
 * values are referenced as `REVIEW_MODE.author` rather than bare strings,
 * while the persisted/wire value stays a plain string.
 */
export const REVIEW_MODE = {
  reviewer: "reviewer",
  author: "author",
} as const;

export type ReviewMode = (typeof REVIEW_MODE)[keyof typeof REVIEW_MODE];

export const REVIEW_MODES: readonly ReviewMode[] = [REVIEW_MODE.reviewer, REVIEW_MODE.author];

export type ThreadStatus = "open" | "pending_coder" | "pending_reviewer" | "resolved" | "wont_fix";

export type AuthorRole = "reviewer" | "coder" | "ai_agent";

export type MessageType = "comment" | "reply" | "suggestion" | "resolution";

export type HunkDecisionType = "accepted" | "rejected";

export interface ReviewSession {
  id: string;
  pullRequestId: string;
  mode: ReviewMode;
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
  diffSide: "old" | "new";
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

export type UserRole = "reviewer" | "coder" | "unknown";

export interface UserIdentity {
  login: string | null;
  role: UserRole;
  /**
   * Base64 data URL of the user's avatar (e.g. "data:image/png;base64,...").
   * Resolved from the remote_users table so expired GitHub Enterprise signed
   * URLs never cause 404s.
   */
  avatarContent: string | null;
  /**
   * `true` when the signed-in user's GitHub login is on the project
   * maintainer allowlist (`MAINTAINER_LOGINS`). Maintainers see new updates
   * the moment CI publishes them — the 48h stable cooldown is bypassed.
   */
  isMaintainer: boolean;
  /**
   * `true` when the active account's GitHub token is invalid and could not be
   * silently refreshed — the client gates the app behind a re-sign-in modal.
   * Authoritative reconcile source for `auth:reauth-required` SSE signals on
   * boot / SSE reconnect. `host` is the account's GitHub host, used to drive
   * the re-auth device flow against the right instance.
   */
  reauthRequired: boolean;
  host: string | null;
}

export interface Org {
  login: string;
  avatarUrl: string | null;
}

export interface Team {
  /** GitHub team slug — unique within the org, used as the stable key. */
  slug: string;
  /** Human-readable team name. */
  name: string;
  /**
   * Logins of the team's members. Currently capped at the first 100 members
   * per team (and the first 100 teams per org) — see `listTeamsForOrg`.
   */
  memberLogins: string[];
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  authorRole: AuthorRole;
  authorName: string;
  authorLogin: string | null;
  /** Base64 data URL of the author's avatar (e.g. "data:image/png;base64,..."). */
  authorAvatarContent: string | null;
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

export type SyncChangeKind = "review_requested" | "pr_updated" | "pr_closed" | "pr_authored";

export interface SyncChange {
  kind: SyncChangeKind;
  prId: string;
  prTitle: string;
  prNumber: number;
  repoFullName: string;
}
