// A scratch worktree: a detached checkout Revv works in for one run, then
// throws away. It never names a local branch (the clone's branches belong to
// its other worktrees, the user's included), so a run's only lasting effects
// are the refs it fetched and whatever it pushes. A run that dies leaves the
// directory behind; the next run with the same path clears it first.

import { existsSync, rmSync } from "node:fs";
import {
  abortMerge,
  abortRebase,
  addDetachedWorktree,
  fetch,
  isMergeInProgress,
  isRebaseInProgress,
  removeWorktree,
} from "./ops";

export const SCRATCH_FETCH_TIMEOUT_MS = 3 * 60_000;
export const SCRATCH_OPERATION_TIMEOUT_MS = 5 * 60_000;
/** Revv's clones are shallow; a missing merge base earns one fetch this much deeper. */
const DEEPEN_BY = 1_000;

export type Failed = { readonly kind: "failed"; readonly message: string };

/** The first line of git's stderr worth showing a user. */
export const firstLine = (stderr: string) =>
  stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("hint:")) ?? "git failed";

export async function clearScratch(clonePath: string, scratchPath: string): Promise<void> {
  if (existsSync(scratchPath)) {
    if (await isMergeInProgress(scratchPath)) await abortMerge(scratchPath);
    if (await isRebaseInProgress(scratchPath)) await abortRebase(scratchPath);
  }
  await removeWorktree(clonePath, scratchPath);
  if (existsSync(scratchPath)) {
    rmSync(scratchPath, { recursive: true, force: true });
    await removeWorktree(clonePath, scratchPath);
  }
}

/** A fresh scratch worktree detached at `sha`, clearing whatever a dead run left. */
export async function prepareScratch(
  clonePath: string,
  scratchPath: string,
  sha: string,
): Promise<{ readonly kind: "ok" } | Failed> {
  await clearScratch(clonePath, scratchPath);
  const added = await addDetachedWorktree(
    clonePath,
    scratchPath,
    sha,
    SCRATCH_OPERATION_TIMEOUT_MS,
  );
  return added.ok
    ? { kind: "ok" }
    : { kind: "failed", message: `Couldn't prepare a worktree: ${firstLine(added.stderr)}` };
}

/** Fetch `refspecs`, `deepen`ing the shallow history when asked. Null on success, else git's reason. */
export async function fetchForScratch(
  clonePath: string,
  url: string,
  refspecs: readonly string[],
  deepen: boolean,
): Promise<string | null> {
  const r = await fetch(clonePath, url, refspecs, {
    ...(deepen ? { deepen: DEEPEN_BY } : {}),
    timeoutMs: SCRATCH_FETCH_TIMEOUT_MS,
  });
  return r.ok ? null : firstLine(r.stderr);
}
