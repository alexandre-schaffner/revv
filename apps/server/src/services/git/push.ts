// Pushing to a GitHub remote, and reading what a refused push means.

import { isValidSha } from "./ops";
import { type GitAttempt, gitAttempt, runGit } from "./runner";

const PUSH_TIMEOUT_MS = 3 * 60_000;

/** The SHA of `refs/heads/<branch>` on the remote, or null when there is no such branch. Throws when the remote can't be read. */
export async function lsRemoteHead(
  cwd: string,
  url: string,
  branch: string,
): Promise<string | null> {
  const out = await runGit(cwd, ["ls-remote", url, `refs/heads/${branch}`], 30_000);
  const line = out.trim().split("\n")[0];
  const sha = line?.split("\t")[0]?.trim() ?? "";
  return isValidSha(sha) ? sha : null;
}

export interface BranchUpdate {
  readonly branch: string;
  /** The remote tip Revv read; the push is refused if the branch has moved since. Null pushes a fast-forward only. */
  readonly from: string | null;
  readonly to: string;
}

/**
 * Push every update or none (`--atomic`), each leased on the tip Revv read.
 * A lease turns "someone pushed meanwhile" into a refusal instead of a lost
 * commit.
 */
export async function pushLeased(
  cwd: string,
  url: string,
  updates: readonly BranchUpdate[],
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    [
      "push",
      ...(updates.length > 1 ? ["--atomic"] : []),
      ...updates.flatMap((u) =>
        u.from === null ? [] : [`--force-with-lease=refs/heads/${u.branch}:${u.from}`],
      ),
      url,
      ...updates.map((u) => `${u.to}:refs/heads/${u.branch}`),
    ],
    PUSH_TIMEOUT_MS,
  );
}

/** Create `refs/heads/<branch>` on the remote, overwriting it when `force`. */
export async function pushNewBranch(
  cwd: string,
  url: string,
  localRef: string,
  branch: string,
  force: boolean,
): Promise<GitAttempt> {
  return gitAttempt(
    cwd,
    ["push", ...(force ? ["--force"] : []), url, `${localRef}:refs/heads/${branch}`],
    PUSH_TIMEOUT_MS,
  );
}

/**
 * What a failed push means:
 *   - `auth`: the transport refused the credential (expired token, missing
 *     scope, suppressed prompt).
 *   - `remote-moved`: git itself declined, because the update isn't a
 *     fast-forward or a lease found the tip elsewhere. Re-syncing fixes it.
 *   - `rejected`: the server said no (pre-receive hook, protected branch, push
 *     rule). Only the server's own message helps.
 *
 * Git prints both of the last two with "rejected": ` ! [rejected]` is git's
 * local refusal, ` ! [remote rejected]` the server's.
 */
export type PushFailureKind = "auth" | "remote-moved" | "rejected";

export function classifyPushFailure(stderr: string): PushFailureKind {
  const lower = stderr.toLowerCase();
  if (lower.includes("[remote rejected]")) return "rejected";
  // Matched on their phrasing, not on bare "403"/"401", which hook output and
  // commit subjects also contain.
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("terminal prompts disabled") ||
    lower.includes("write access to repository not granted") ||
    lower.includes("returned error: 403") ||
    lower.includes("returned error: 401") ||
    lower.includes("403 forbidden") ||
    lower.includes("401 unauthorized")
  ) {
    return "auth";
  }
  if (
    lower.includes("stale info") ||
    lower.includes("non-fast-forward") ||
    lower.includes("fetch first") ||
    lower.includes("[rejected]")
  ) {
    return "remote-moved";
  }
  return "rejected";
}

/**
 * GitHub's refusal to let a credential without workflow-write authority
 * create or update a file under `.github/workflows/`. Revv's GitHub App has no
 * `Workflows: write` and its OAuth flow asks for no `workflow` scope, so it
 * can never push CI. Returns the workflow path GitHub named, or null for any
 * other rejection.
 */
export function workflowPermissionRejection(
  stderr: string,
): { readonly path: string | null } | null {
  const lower = stderr.toLowerCase();
  if (!lower.includes("refusing to allow")) return null;
  if (
    !lower.includes("without `workflows` permission") &&
    !lower.includes("without `workflow` scope")
  ) {
    return null;
  }
  const named = /workflow `([^`]+)`/i.exec(stderr);
  return { path: named?.[1] ?? null };
}

/**
 * The message a server-side rejection shows the user. The remote's own text,
 * except for the workflow-permission refusal: its wording describes GitHub
 * internals and reads as transient, so users retry what can never work.
 */
export function describePushRejection(stderr: string): string {
  const workflow = workflowPermissionRejection(stderr);
  if (!workflow) return stderr || "git push failed";
  const what = workflow.path ?? "files under .github/workflows/";
  return (
    `GitHub won't let Revv's credential change ${what} — pushing CI needs a permission ` +
    "Revv doesn't hold. Push these commits over SSH from your own checkout, or push only " +
    "the commits that leave workflow files alone."
  );
}

export type PushOutcome =
  | { readonly kind: "pushed" }
  | { readonly kind: "moved" }
  | { readonly kind: "auth" | "rejected"; readonly message: string };

export function pushOutcome(attempt: GitAttempt): PushOutcome {
  if (attempt.ok) return { kind: "pushed" };
  switch (classifyPushFailure(attempt.stderr)) {
    case "remote-moved":
      return { kind: "moved" };
    case "auth":
      return { kind: "auth", message: "GitHub refused Revv's credential for this push" };
    case "rejected":
      return { kind: "rejected", message: describePushRejection(attempt.stderr) };
  }
}
