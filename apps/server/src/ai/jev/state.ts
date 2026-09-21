// ── Jev state builders ───────────────────────────────────────────────────────
//
// One builder per hook. Each returns a plain JSON object sized to fit under
// the System One state budget, with named fields rather than a prose blob so
// questions can reference nested paths (`pr.title`, `issues.<id>.description`).
//
// Deliberately NOT sharing the walkthrough prompt builder's budget loop
// (`ai/prompts/walkthrough.ts`): different limit, different consumer. Coupling
// them means a change made for Jev silently shrinks the agent's prompt.

import type { JsonValue } from "@typesafe-ai/sdk";
import type { JevState } from "../../services/Jev";
import { truncatePatchToChars } from "../../services/patch-truncate";

/**
 * Character ceiling for the whole `state` blob.
 *
 * System One allows 32k tokens for state plus the longest question. Against
 * the repo's own `length / 4` token heuristic, 96k chars ≈ 24k tokens, which
 * leaves comfortable headroom for the questions themselves. Chars, not bytes
 * — see `patch-truncate.ts` on why that's the right proxy here.
 */
export const JEV_STATE_MAX_CHARS = 96_000;

/** Per-file patch ceiling, so one enormous file can't crowd out the rest. */
const PER_PATCH_MAX_CHARS = 12_000;

/** Rough token-equivalent size of a state blob, for budget decisions. */
export function stateChars(state: JevState): number {
  return JSON.stringify(state).length;
}

export interface PrLike {
  readonly externalId: number;
  readonly title: string;
  readonly body: string | null;
  readonly authorLogin: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
}

export interface FileLike {
  readonly filename: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string | null;
}

export interface CommitLike {
  readonly message: string;
}

const PR_BODY_MAX_CHARS = 4_000;
const COMMIT_SUBJECT_MAX = 40;

/** First line of a commit message — the subject is all a sizing judgment needs. */
function commitSubject(message: string): string {
  return (message.split("\n", 1)[0] ?? "").slice(0, 200);
}

/**
 * State for the job-start call (risk tier + review depth + wide-context).
 *
 * Patches are included because the questions are about the *change*, not the
 * description — a PR titled "small fix" that rewrites an auth middleware has
 * to read as high risk. Files are added whole-patch-first until the budget
 * runs out; the ones that don't fit still appear with their stats, so the
 * total size of the change is never understated by truncation.
 */
export interface JobStartStateInput {
  readonly pr: PrLike;
  readonly files: readonly FileLike[];
  readonly commits: readonly CommitLike[];
}

export function buildJobStartState({ pr, files, commits }: JobStartStateInput): JevState {
  const header = {
    pr: {
      number: pr.externalId,
      title: pr.title,
      body: (pr.body ?? "").slice(0, PR_BODY_MAX_CHARS),
      author: pr.authorLogin,
      source_branch: pr.sourceBranch,
      target_branch: pr.targetBranch,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles,
    },
    commits: commits.slice(0, COMMIT_SUBJECT_MAX).map((c) => commitSubject(c.message)),
    commit_count: commits.length,
  };

  let used = stateChars(header);
  const withPatch: JsonValue[] = [];
  const statsOnly: JsonValue[] = [];

  for (const file of files) {
    const stats = {
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    };
    if (file.patch === null) {
      statsOnly.push({ ...stats, patch_omitted: "binary or too large" });
      continue;
    }
    const clipped = truncatePatchToChars(file.patch, PER_PATCH_MAX_CHARS, "patch");
    if (used + clipped.patch.length > JEV_STATE_MAX_CHARS) {
      statsOnly.push({ ...stats, patch_omitted: "state budget reached" });
      continue;
    }
    used += clipped.patch.length;
    withPatch.push({ ...stats, patch: clipped.patch });
  }

  // The stats-only tail isn't budgeted in the loop above (each entry is
  // tiny), but a PR touching thousands of files would still overflow on the
  // tail alone — hence the clamp.
  return clampState({ ...header, files: [...withPatch, ...statsOnly] });
}

/**
 * Last-resort clamp. The per-field slicing above is the real budget control;
 * this exists so a pathological input (hundreds of issues, each with a long
 * description) degrades to a truncated-but-valid state rather than a 422 from
 * the API.
 *
 * Shrinks the largest array/record field by halving it until the whole thing
 * fits — biased toward keeping the header fields (PR metadata, summary) that
 * every question needs over the long tail of a list. The truncation is
 * announced in-band so the model isn't reading a silently-cut fragment as
 * complete.
 */
function clampState(state: JevState): JevState {
  if (stateChars(state) <= JEV_STATE_MAX_CHARS) return state;
  const working: JevState = {
    ...state,
    _truncated: `State exceeded ${JEV_STATE_MAX_CHARS} characters; later entries were dropped.`,
  };
  for (let guard = 0; guard < 12 && stateChars(working) > JEV_STATE_MAX_CHARS; guard++) {
    let largestKey: string | null = null;
    let largestSize = 0;
    for (const [key, value] of Object.entries(working)) {
      if (!Array.isArray(value) && (value === null || typeof value !== "object")) continue;
      const size = JSON.stringify(value).length;
      if (size > largestSize) {
        largestSize = size;
        largestKey = key;
      }
    }
    if (largestKey === null) break;
    const value = working[largestKey];
    if (Array.isArray(value)) {
      working[largestKey] = value.slice(0, Math.floor(value.length / 2));
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      working[largestKey] = Object.fromEntries(entries.slice(0, Math.floor(entries.length / 2)));
    } else {
      break;
    }
  }
  return working;
}
