// ── New-PR session types ──────────────────────────────────────────────────
//
// Wire-level and persistence contract for the New-PR chat session. A
// session is a long-running, user-driven conversation with the agent that
// produces an entirely new pull request — the user describes what they
// want, the agent edits files in a per-session worktree, optionally
// committing as it goes; an explicit "Open Pull Request" action pushes
// the branch and opens the PR on GitHub.
//
// The shape parallels the existing PR-scoped chat session types but is
// repo-scoped: there is no existing PR to anchor against until the
// session terminates with an Open-PR action. See
// `apps/server/src/db/schema/new-pr-sessions.ts` for the persistence
// layer comment on why this isn't a doctrine-bound jobs table.

/**
 * Lifecycle state for a new-PR session. Orchestrator-only writes (CLAUDE
 * .md invariant #11) — agents never set this directly.
 *
 *   - 'chatting'       — normal interactive state; user sends messages.
 *   - 'agent-running'  — transient: a single agent turn is in flight.
 *                        Rolled back to 'chatting' on server restart.
 *   - 'opening'        — durable: user clicked Open PR; orchestrator is
 *                        pushing the branch + calling GitHub. Bounded
 *                        retries via `resumeAttempts`.
 *   - 'complete'       — PR opened; `prId` and `prExternalId` set.
 *   - 'error'          — terminal failure; `errorMessage` populated.
 *   - 'cancelled'      — user aborted; worktree cleaned.
 */
export type NewPrSessionStatus =
  | "chatting"
  | "agent-running"
  | "opening"
  | "complete"
  | "error"
  | "cancelled";

/** Persistence + wire shape for one new-PR session row. */
export interface NewPrSession {
  readonly id: string;
  readonly repositoryId: string;
  readonly userId: string;
  /** 'claude' | 'opencode' — snapshot at session start. */
  readonly agent: string;
  /** Agent-side session UUID (Claude SDK projects dir / opencode daemon
   * session). Null until the first turn patches it in. */
  readonly sessionId: string | null;
  /** origin/main HEAD captured at session start. */
  readonly baseSha: string;
  readonly worktreePath: string;
  /** Ephemeral local branch: `revv-newpr/{sessionId}`. */
  readonly branchName: string;
  /** Mutated by the agent via `set_pr_metadata`. */
  readonly title: string | null;
  readonly body: string | null;
  /** Set after Open-PR succeeds. */
  readonly prExternalId: number | null;
  readonly prId: string | null;
  readonly status: NewPrSessionStatus;
  readonly nextSequence: number;
  readonly resumeAttempts: number;
  readonly errorMessage: string | null;
  /** 'default' | 'plan' — session-level toggle. */
  readonly interactionMode: "default" | "plan";
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly completedAt: string | null;
}

/** One row in the new-PR chat transcript. Same shape as `chat_messages`. */
export interface NewPrMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly isStreaming: boolean;
  readonly sequence: number;
  readonly turnId: string;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

/**
 * One commit made during the session, journaled by the `commit_changes`
 * MCP tool. The git worktree is authoritative for the actual ref tree;
 * this is a denormalised projection for the UI commit list + idempotency
 * checks on resume.
 */
export interface NewPrCommit {
  readonly id: string;
  readonly sessionId: string;
  readonly commitSha: string;
  readonly message: string;
  /** File paths touched in this commit. Null when the tool couldn't enumerate. */
  readonly filesChanged: ReadonlyArray<string> | null;
  readonly createdAt: string;
}

/**
 * Snapshot of the new-PR session for a `new-pr-session:created`
 * full-state envelope. Carries the row plus the initial empty
 * transcript so the client can hydrate without an extra round-trip.
 */
export interface NewPrSessionSnapshot {
  readonly session: NewPrSession;
  readonly messages: ReadonlyArray<NewPrMessage>;
  readonly commits: ReadonlyArray<NewPrCommit>;
}
