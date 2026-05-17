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
  githubHost: string;
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
  closedAt: string | null;
}

export type ThinkingEffort = "ultrathink" | "max" | "extra-high" | "high" | "medium" | "low";

export type ContextWindow = "200k" | "1m";

export type AiAgent = "opencode" | "claude";

/**
 * Per-feature override for which agent generates project recaps.
 * `'auto'` (default) inherits the global `aiAgent`; explicit values pin
 * recap generation to that agent regardless of the global choice. Lets a
 * user run Claude for interactive walkthroughs but keep background recaps
 * on opencode (cheaper, unattended), or vice versa.
 */
export type RecapAgentChoice = "auto" | "opencode" | "claude";

/**
 * Which CLI agents are detected on PATH (or pinned via the LaunchAgent
 * `REVV_*_BIN` env vars). Surfaced during onboarding so we can offer to
 * install opencode when neither provider is present.
 */
export interface AgentAvailability {
  opencode: boolean;
  claude: boolean;
}

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

export interface UserSettings {
  id: string;
  aiProvider: string;
  aiModel: string;
  aiThinkingEffort: ThinkingEffort;
  aiAgent: AiAgent;
  aiContextWindow: ContextWindow;
  /**
   * Low-cost model used for one-shot, no-tools PR-aware suggestion
   * generation (right-panel empty-state prompts). Follows the global
   * `aiAgent` — pick from the opencode catalog when `aiAgent='opencode'`,
   * the Claude catalog when `aiAgent='claude'`. Defaults to a cheap model
   * (e.g. Haiku for Claude) so generating suggestions for every PR open
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
     * `aiAgent`; `'opencode'` / `'claude'` pin recap generation to that
     * agent regardless of the global choice.
     */
    agent: RecapAgentChoice;
  };
  /**
   * GitHub host the app authenticates against. `'nocturlab.ghe.com'` for
   * the bundled GHE instance (default) or `'github.com'` for public
   * GitHub. Picked during onboarding and consumed by the device-flow
   * routes to build per-host OAuth and API URLs.
   */
  githubHost: string;
}

// ── Review domain types ──────────────────────────────────────────────────────

export type SessionStatus = "active" | "completed" | "abandoned";

export type ThreadStatus = "open" | "pending_coder" | "pending_reviewer" | "resolved" | "wont_fix";

export type AuthorRole = "reviewer" | "coder" | "ai_agent";

export type MessageType = "comment" | "reply" | "suggestion" | "resolution";

export type HunkDecisionType = "accepted" | "rejected";

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

export type SyncChangeKind = "review_requested" | "pr_updated" | "pr_closed" | "pr_authored";

export interface SyncChange {
  kind: SyncChangeKind;
  prId: string;
  prTitle: string;
  prNumber: number;
  repoFullName: string;
}
