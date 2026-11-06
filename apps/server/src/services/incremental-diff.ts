// Turns a `base..head` git range into the per-file prompt input for an
// incremental walkthrough (`walkthrough-prompt-files.ts`).
//
// A generated, minified or lock file can produce a multi-MB patch, amplified by
// `git diff --unified=80`. Scanning that synchronously stalls Bun's event loop
// for the whole server, and the model can't use it anyway. So each patch is
// capped, and add/delete counts come from `git diff --numstat` rather than
// from scanning patch bodies.

import type { LineCounts } from "./git/parse";
import { truncatePatchToChars } from "./patch-truncate";

/** Per-file patch cap, in UTF-16 code units (see `patch-truncate.ts`). */
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

/**
 * For files `--numstat` can't key by path (renames, which it writes as
 * `a => b`). Pass an already-capped patch so the scan is bounded.
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

export function capPatch(raw: string): string | null {
  if (raw.trim().length === 0) return null;
  return truncatePatchToChars(raw, MAX_INCREMENTAL_PATCH_CHARS, "diff").patch;
}

export function resolveCounts(
  numstat: ReadonlyMap<string, LineCounts>,
  filename: string,
  patch: string | null,
): LineCounts {
  const hit = numstat.get(filename);
  if (hit) return hit;
  return patch ? countPatchLines(patch) : { additions: 0, deletions: 0 };
}
