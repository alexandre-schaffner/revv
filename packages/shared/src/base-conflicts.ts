/**
 * How Revv brings a PR up to date with its base branch when the agent
 * resolves conflicts: `merge` merges the base into the PR branch and pushes
 * (history kept); `rebase` replays the PR onto the base and force-pushes with
 * a lease (history rewritten).
 */
export type BaseConflictStrategy = "merge" | "rebase";

export const BASE_CONFLICT_STRATEGIES: readonly BaseConflictStrategy[] = ["merge", "rebase"];

export const DEFAULT_BASE_CONFLICT_STRATEGY: BaseConflictStrategy = "merge";

/**
 * A local answer to "does this PR conflict with its base branch?", computed
 * with `git merge-tree` against freshly fetched tips. GitHub's mergeability
 * says *whether*; this says *which files*.
 */
export interface BaseConflictsCheck {
  /** `unavailable` when the clone isn't ready or the history can't be reached; see `reason`. */
  readonly status: "clean" | "conflicts" | "unavailable";
  readonly baseBranch: string;
  /** The PR head the check ran against (the fetched remote tip). */
  readonly headSha: string | null;
  readonly baseSha: string | null;
  /** Paths `git merge-tree` reports as conflicting. Empty unless `conflicts`. */
  readonly files: readonly string[];
  /** Commits on the base the PR doesn't have; null when unknown. */
  readonly behindBy: number | null;
  /**
   * The base changed `.github/workflows/` since the PR forked. Bringing those
   * changes into the PR branch is a push neither Revv credential may make.
   */
  readonly touchesWorkflows: boolean;
  /**
   * Agent commits sitting unpushed in the PR's chat worktree. A rebase would
   * strand them on the old history, so rebase mode refuses while any exist.
   */
  readonly unpushedAgentCommits: number;
  /** An agent run is resolving this PR's base conflicts right now. */
  readonly resolving: boolean;
  readonly reason?: string;
  readonly checkedAt: string;
}

/** Agent progress forwarded from a one-shot conflict-resolve run. */
export type AgentProgressFrame =
  | { readonly kind: "agent-text"; readonly data: string }
  | {
      readonly kind: "agent-activity";
      readonly activityKind: string;
      readonly toolName: string | null;
      readonly summary: string;
      readonly payload?: unknown;
    };

/** Frames streamed by `POST /api/prs/:id/base-conflicts/resolve`; ends with one `result`. */
export type BaseConflictFrame =
  | { readonly kind: "status"; readonly message: string }
  | { readonly kind: "conflict-files"; readonly files: readonly string[] }
  | AgentProgressFrame
  | {
      readonly kind: "result";
      readonly status: "pushed";
      readonly newSha: string;
      readonly branch: string;
      readonly strategy: BaseConflictStrategy;
    }
  | { readonly kind: "result"; readonly status: "remote-changed"; readonly branch: string }
  | { readonly kind: "result"; readonly status: "failed"; readonly message: string };
