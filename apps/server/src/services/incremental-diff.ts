// ── Incremental diff helpers ────────────────────────────────────────────────
// Pure functions used by WalkthroughJobs to turn a `base..head` git range into
// the per-file prompt input for an incremental walkthrough. Extracted so the
// parsing and size-capping logic can be unit-tested without spinning up a job.
//
// Design note (why capping matters): a change to a generated/minified/lockfile
// can produce a multi-MB patch, amplified by `git diff --unified=80`. Holding
// that string and scanning it synchronously on the Bun event loop stalls the
// whole server — and the model can't use a diff that large anyway. So we cap
// each patch, and source add/delete counts from `git diff --numstat` (which
// git computes) instead of scanning every patch body.

import { truncatePatchToChars } from "./patch-truncate";

/**
 * Upper bound on the size of a single file's incremental diff patch we keep
 * and hand to the agent. Anything larger is truncated with a marker so the
 * agent knows the diff was clipped. Measured in UTF-16 code units (see
 * `patch-truncate.ts`).
 */
export const MAX_INCREMENTAL_PATCH_CHARS = 128 * 1024;

/** Map a `git diff --name-status` status letter to the prompt file status. */
export function normalizeGitStatus(raw: string): string {
  const prefix = raw[0] ?? "M";
  switch (prefix) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "changed";
    default:
      return "modified";
  }
}

export interface NameStatusEntry {
  readonly status: string;
  readonly filename: string;
  readonly previousFilename: string | null;
}

/**
 * Parse `git diff --name-status -z` output. The `-z` form is NUL-separated and
 * emits the pre-image path before the post-image path for renames/copies.
 */
export function parseNameStatusZ(raw: string): ReadonlyArray<NameStatusEntry> {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const files: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousFilename = tokens[i++];
      const filename = tokens[i++];
      if (previousFilename && filename) {
        files.push({ status, filename, previousFilename });
      }
      continue;
    }
    const filename = tokens[i++];
    if (filename) {
      files.push({ status, filename, previousFilename: null });
    }
  }
  return files;
}

export interface LineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/**
 * Fallback line-counter, used only for the handful of files `--numstat` can't
 * key directly (renames, whose numstat path uses `a => b` notation). Callers
 * always pass an already-capped patch, so the scan is bounded.
 */
export function countPatchLines(patch: string): LineCounts {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Parse `git diff --numstat` into per-path counts. Keyed by the raw numstat
 * path: for non-renamed files that equals the name-status filename (an exact
 * hit, no patch-body scan needed); renamed files use `a => b` notation and
 * simply miss, falling back to `countPatchLines`. Binary files report `-` for
 * both columns → treated as 0/0.
 */
export function parseNumstat(raw: string): ReadonlyMap<string, LineCounts> {
  const counts = new Map<string, LineCounts>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) continue;
    const secondTab = line.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const addRaw = line.slice(0, firstTab);
    const delRaw = line.slice(firstTab + 1, secondTab);
    const path = line.slice(secondTab + 1);
    const additions = addRaw === "-" ? 0 : Number.parseInt(addRaw, 10);
    const deletions = delRaw === "-" ? 0 : Number.parseInt(delRaw, 10);
    if (Number.isNaN(additions) || Number.isNaN(deletions)) continue;
    counts.set(path, { additions, deletions });
  }
  return counts;
}

/**
 * Clip an oversized patch so no synchronous scan (or the model's context
 * window) ever sees a multi-MB blob. Returns `null` for an empty/whitespace
 * patch; otherwise delegates to the shared truncation primitive.
 */
export function capPatch(raw: string): string | null {
  if (raw.trim().length === 0) return null;
  return truncatePatchToChars(raw, MAX_INCREMENTAL_PATCH_CHARS, "diff").patch;
}

/**
 * Resolve a file's line counts: prefer the exact numbers git reported via
 * `--numstat` (keyed by path), and fall back to scanning the already-capped
 * patch only for the files numstat can't key directly — renames (arrow
 * notation). A file with no patch and no numstat entry counts as zero.
 */
export function resolveCounts(
  numstat: ReadonlyMap<string, LineCounts>,
  filename: string,
  patch: string | null,
): LineCounts {
  const hit = numstat.get(filename);
  if (hit) return hit;
  return patch ? countPatchLines(patch) : { additions: 0, deletions: 0 };
}
