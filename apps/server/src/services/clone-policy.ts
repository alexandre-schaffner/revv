import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serverEnv } from "../config";
import { CloneError } from "../domain/errors";
import { isGitRepo, listWorktrees, originUrl } from "./git/ops";

export const CLONE_BASE_DIR = serverEnv.cloneDir;

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
    !pathIsUnder(resolvedPath, CLONE_BASE_DIR)
  ) {
    throw new CloneError({
      message: `Refusing to delete unsafe managed clone path: ${clonePath}`,
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
      // Inside Revv's base the clone is Revv's own (e.g. left by an earlier
      // delete), so adopt it as managed; linking it would orphan it in the base
      // forever. Outside the base it's the user's checkout: link it
      // (`managed: false`) so it is never deleted.
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

export async function remoteMatches(
  path: string,
  gitHost: string,
  fullName: string,
): Promise<boolean> {
  const origin = await originUrl(path);
  return origin !== null && remoteUrlMatches(origin, gitHost, fullName);
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

export async function findWorktreesOnBranch(
  clonePath: string,
  branchName: string,
): Promise<string[]> {
  const ref = `refs/heads/${branchName}`;
  return (await listWorktrees(clonePath)).filter((w) => w.branch === ref).map((w) => w.path);
}
