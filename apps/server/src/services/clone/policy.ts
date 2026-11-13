// Rules for the folders a clone may live in: which destination a clone takes,
// and which managed clone may be deleted. Both read one fact: whether the
// folder is Revv's (under its base, or `repositories.revv_wrote_clone`).

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isGitRepo, originUrl, resolveRef } from "../git/ops";

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

/**
 * Why Revv must not `rm -rf` the managed clone at `clonePath`, or null when it
 * may. Never the home directory, the root, or anything holding them. Under
 * Revv's base the folder is Revv's. Elsewhere (a base the user picked), only
 * a folder Revv wrote, and only while it still looks like that clone: a
 * repository with this origin (or none yet), or nothing at all.
 */
export async function managedCloneRemovalRefusal(
  clonePath: string,
  base: string,
  repo: {
    readonly githubHost: string;
    readonly fullName: string;
    readonly revvWroteClone: boolean;
  },
): Promise<string | null> {
  const target = resolve(clonePath);
  if (
    !clonePath.trim() ||
    target === "/" ||
    target === resolve(base) ||
    pathIsUnder(homedir(), target)
  ) {
    return `Refusing to delete ${clonePath}`;
  }
  if (pathIsUnder(target, base)) return null;
  if (!existsSync(target)) return null;
  if (!repo.revvWroteClone) {
    return `Keeping ${clonePath}: Revv didn't clone ${repo.fullName} there`;
  }
  const notAClone = `Refusing to delete ${clonePath}: it isn't a clone of ${repo.fullName}`;
  if (!existsSync(join(target, ".git"))) {
    return readdirSync(target).length === 0 ? null : notAClone;
  }
  const origin = await originUrl(target);
  return origin === null || remoteUrlMatches(origin, repo.githubHost, repo.fullName)
    ? null
    : notAClone;
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
  /** A clone of the repository (or of nothing yet) with no commit checked out: a clone killed mid-fetch. */
  | "broken-git-repo"
  | "different-git-repo"
  | "non-empty-non-git";

export type CloneDestinationDecision =
  | { readonly action: "clone"; readonly removeExisting: boolean }
  | { readonly action: "adopt" }
  | { readonly action: "link" }
  | { readonly action: "fail"; readonly message: string };

/**
 * What a clone does with its destination. `revvsFolder`: the folder is under
 * Revv's base, or Revv wrote it (a clone cut off mid-way), so what is there
 * is Revv's own leftover; anywhere else it is the user's.
 */
export function decideCloneDestination(
  state: CloneDestinationState,
  revvsFolder: boolean,
): CloneDestinationDecision {
  switch (state) {
    case "missing":
    case "empty":
      return { action: "clone", removeExisting: false };
    case "matching-git-repo":
      // Revv's own clone is adopted as managed; linking it would orphan it in
      // the base forever. The user's checkout is linked (`managed: false`)
      // so it is never deleted.
      return revvsFolder ? { action: "adopt" } : { action: "link" };
    case "broken-git-repo":
      return revvsFolder
        ? { action: "clone", removeExisting: true }
        : {
            action: "fail",
            message: "The clone at that location is incomplete; delete it or choose another.",
          };
    case "different-git-repo":
      return {
        action: "fail",
        message: "A git repository already exists at that location for a different remote.",
      };
    case "non-empty-non-git":
      return revvsFolder
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
    const origin = await originUrl(dest);
    const checkedOut = (await resolveRef(dest, "HEAD")) !== null;
    // A clone killed before it wrote its config has no origin yet.
    if (origin === null && !checkedOut) return "broken-git-repo";
    if (origin === null || !remoteUrlMatches(origin, gitHost, fullName)) {
      return "different-git-repo";
    }
    return checkedOut ? "matching-git-repo" : "broken-git-repo";
  }
  return readdirSync(dest).length === 0 ? "empty" : "non-empty-non-git";
}
