/**
 * Clone-path policy, remote-identity parsing, and read-only git inspection
 * for {@link RepoCloneService}.
 *
 * Everything here is dependency-free of the Effect service closure — pure
 * functions plus best-effort git probes — so it can be unit-tested in
 * isolation and reasoned about without the clone/worktree orchestration that
 * lives in `RepoClone.ts`. Three concerns live here:
 *
 *   - **Remote parsing** — turning a git remote URL into an `owner/name`
 *     identity and comparing it against a saved repo (`parseRemoteFullName`,
 *     `remoteUrlMatches`).
 *   - **Path safety / ownership** — deciding which paths Revv may delete,
 *     expand, or treat as its own (`pathIsUnder`, `assertSafeManagedClonePath`,
 *     `worktreeHolderPath`, …).
 *   - **Destination policy** — classifying a target directory and deciding
 *     whether to clone, link, or refuse (`readCloneDestinationState`,
 *     `decideCloneDestination`).
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serverEnv } from "../config";
import { CloneError } from "../domain/errors";
import { runGitBestEffort, runGitCapture } from "./git-runner";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CLONE_BASE_DIR = serverEnv.cloneDir;

// ── Path safety / ownership ─────────────────────────────────────────────────

export function pathIsUnder(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}/`);
}

export function existingPathIsUnder(child: string, parent: string): boolean {
  try {
    const realChild = realpathSync(child);
    const realParent = realpathSync(parent);
    return realChild === realParent || realChild.startsWith(`${realParent}/`);
  } catch {
    return pathIsUnder(child, parent);
  }
}

export function assertSafeManagedClonePath(clonePath: string): void {
  const resolvedPath = resolve(clonePath);
  const home = resolve(homedir());
  if (
    !clonePath.trim() ||
    resolvedPath === "/" ||
    resolvedPath === home ||
    (!pathIsUnder(resolvedPath, CLONE_BASE_DIR) && !pathIsUnder(resolvedPath, home))
  ) {
    throw new CloneError({
      message: `Refusing to delete unsafe managed clone path: ${clonePath}`,
    });
  }
}

export function assertSafeCloneBasePath(basePath: string): void {
  const resolvedPath = resolve(expandUserPath(basePath));
  const home = resolve(homedir());
  if (!pathIsUnder(resolvedPath, CLONE_BASE_DIR) && !pathIsUnder(resolvedPath, home)) {
    throw new CloneError({
      message: `Refusing to clone into unsafe base path: ${basePath}`,
    });
  }
}

export function worktreeHolderPath(owner: string, name: string): string {
  return join(CLONE_BASE_DIR, owner, name, "worktrees");
}

export function expandUserPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// ── Remote-identity parsing ─────────────────────────────────────────────────

function normalizeGitPath(pathname: string): string | null {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function parseRemoteFullName(remoteUrl: string, gitHost: string): string | null {
  const trimmed = remoteUrl.trim();
  const scpLike = trimmed.includes("://") ? null : /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpLike) {
    const [, host, path] = scpLike;
    if (host?.toLowerCase() !== gitHost.toLowerCase() || !path) return null;
    return normalizeGitPath(path);
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== gitHost.toLowerCase()) return null;
    return normalizeGitPath(url.pathname);
  } catch {
    return null;
  }
}

export function remoteUrlMatches(remoteUrl: string, gitHost: string, fullName: string): boolean {
  return parseRemoteFullName(remoteUrl, gitHost)?.toLowerCase() === fullName.toLowerCase();
}

// ── Destination policy ────────────────────────────────────────────────────────

export type CloneDestinationState =
  | "missing"
  | "empty"
  | "matching-git-repo"
  | "different-git-repo"
  | "non-empty-non-git";

export type CloneDestinationDecision =
  | { readonly action: "clone"; readonly removeExisting: boolean }
  | { readonly action: "adopt" }
  | { readonly action: "link" }
  | { readonly action: "fail"; readonly message: string };

export function decideCloneDestination(
  state: CloneDestinationState,
  underDefaultBase: boolean,
): CloneDestinationDecision {
  switch (state) {
    case "missing":
    case "empty":
      return { action: "clone", removeExisting: false };
    case "matching-git-repo":
      // A valid clone of the right remote already sits here. Inside Revv's
      // managed base, adopt it as a managed clone — Revv created it (e.g. a
      // re-add over a directory a prior delete left behind) and may reclaim
      // it on delete. Outside the base it's the user's own checkout, so link
      // it read-only (`managed: false`) and never delete it. Flipping a
      // base-internal clone to linked would orphan it permanently in `~/.revv`.
      return underDefaultBase ? { action: "adopt" } : { action: "link" };
    case "different-git-repo":
      return {
        action: "fail",
        message: "A git repository already exists at that location for a different remote.",
      };
    case "non-empty-non-git":
      return underDefaultBase
        ? { action: "clone", removeExisting: true }
        : {
            action: "fail",
            message: "A non-empty directory already exists at that location.",
          };
  }
}

// ── Read-only git inspection ────────────────────────────────────────────────

export async function isGitRepo(path: string): Promise<boolean> {
  return runGitBestEffort(["rev-parse", "--git-dir"], path, 10_000);
}

export async function remoteMatches(
  path: string,
  gitHost: string,
  fullName: string,
): Promise<boolean> {
  try {
    const origin = (await runGitCapture(["remote", "get-url", "origin"], path, 10_000)).trim();
    return remoteUrlMatches(origin, gitHost, fullName);
  } catch {
    return false;
  }
}

export async function readCloneDestinationState(
  dest: string,
  gitHost: string,
  fullName: string,
): Promise<CloneDestinationState> {
  if (!existsSync(dest)) return "missing";
  if (await isGitRepo(dest)) {
    return (await remoteMatches(dest, gitHost, fullName))
      ? "matching-git-repo"
      : "different-git-repo";
  }
  return readdirSync(dest).length === 0 ? "empty" : "non-empty-non-git";
}

/**
 * Return every worktree path currently checked out on `refs/heads/<branch>`,
 * parsed from `git worktree list --porcelain`. Used to reclaim `pr-N` when
 * an orphan worktree (e.g. a pre-refactor `chat-{prId}-{sha12}` dir) is
 * squatting on it — leaving such a checkout in place would make any
 * external worktree creation for `refs/heads/revv/pr-N` fail. Returns
 * an empty array on parse / spawn failure (best-effort).
 */
export async function findWorktreesOnBranch(
  clonePath: string,
  branchName: string,
): Promise<string[]> {
  let out: string;
  try {
    out = await runGitCapture(["worktree", "list", "--porcelain"], clonePath, 15_000);
  } catch {
    return [];
  }
  const ref = `refs/heads/${branchName}`;
  const paths: string[] = [];
  // Porcelain output is record-per-blank-line. Each record has lines like:
  //   worktree <path>
  //   HEAD <sha>
  //   branch <ref>     (absent for detached HEADs)
  // We only need (worktree, branch) pairs; everything else we ignore.
  for (const block of out.split("\n\n")) {
    let wtPath: string | null = null;
    let wtBranch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        wtBranch = line.slice("branch ".length).trim();
      }
    }
    if (wtPath && wtBranch === ref) {
      paths.push(wtPath);
    }
  }
  return paths;
}
