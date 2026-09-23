// ── Jev state builders ──────────────────────────────────────────────────────
//
// One builder per hook. Each returns a plain JSON object sized to fit under
// the System One state budget, with named fields rather than a prose blob so
// questions can reference nested paths (`pr.title`, `issues.<id>.description`).
//
// Not sharing the walkthrough prompt builder's budget loop
// (`ai/prompts/walkthrough.ts`): different limit, different consumer.

import type { JsonValue } from "@typesafe-ai/sdk";
import type { JevState } from "../../services/Jev";
import { truncatePatchToChars } from "../../services/patch-truncate";

/**
 * Character ceiling for the whole `state` blob. System One allows 32k tokens
 * for state + longest question; 96k chars ≈ 24k tokens (repo's `length / 4`
 * heuristic), leaving headroom. Chars not bytes — see `patch-truncate.ts`.
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
 * Patches are included because the questions are about the change, not the
 * description. Files are added whole-patch-first until budget runs out; the
 * rest still appear with stats, so the change size is never understated.
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

  // The stats-only tail isn't budgeted above (entries are tiny), but thousands of files could still overflow it, hence the clamp below.
  return clampState({ ...header, files: [...withPatch, ...statsOnly] });
}

interface PhaseCChapter {
  readonly title: string;
  readonly stepCount: number;
}

interface PhaseCIssue {
  readonly id: string;
  readonly severity: string;
  readonly title: string;
  readonly description: string;
  readonly filePath: string | null;
}

export interface PhaseCInput {
  readonly pr: PrLike;
  /** Stats only, no patches — see the note on `files` below. */
  readonly files: readonly Omit<FileLike, "patch">[];
  readonly summary: string;
  readonly sentiment: string;
  readonly chapters: readonly PhaseCChapter[];
  readonly issues: readonly PhaseCIssue[];
}

/**
 * State for the phase-D verdict pass. Hand-written rather than reusing
 * `exportWalkthroughSnapshot`, which asserts `status='complete'` (false here
 * by construction) and carries full block bodies that wouldn't fit.
 *
 * The changed-file stats list is cheap and load-bearing: without it,
 * `tests`/`scope`/`api_changes` could only reflect what a chapter happened to
 * mention. Jev judges the review here, not the diff; the file list narrows
 * that gap, doesn't close it.
 */
export function buildPhaseCState(input: PhaseCInput): JevState {
  const state: JevState = {
    pr: {
      number: input.pr.externalId,
      title: input.pr.title,
      body: (input.pr.body ?? "").slice(0, PR_BODY_MAX_CHARS),
      source_branch: input.pr.sourceBranch,
      target_branch: input.pr.targetBranch,
      additions: input.pr.additions,
      deletions: input.pr.deletions,
      changed_files: input.pr.changedFiles,
    },
    changed_files: input.files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
    review: {
      summary: input.summary,
      sentiment: input.sentiment,
      chapters: input.chapters.map((c) => ({ title: c.title, steps: c.stepCount })),
    },
    issues: input.issues.map((i) => ({
      id: i.id,
      severity: i.severity,
      title: i.title,
      description: i.description,
      file: i.filePath,
    })),
  };
  return clampState(state);
}

export interface IssueRelevanceInput {
  readonly pr: PrLike;
  readonly issue: {
    readonly severity: string;
    readonly title: string;
    readonly description: string;
    readonly filePath: string | null;
    readonly startLine: number | null;
    readonly endLine: number | null;
    /** The diff hunk the issue is anchored to, if it could be resolved. */
    readonly hunk: string | null;
  };
  /** Concerns already recorded for this walkthrough, for the duplicate check. */
  readonly existingIssues: ReadonlyArray<{
    readonly title: string;
    readonly description: string;
    readonly file: string | null;
  }>;
}

/**
 * State for the relevance gate on a single `flag_issue` call. One issue
 * rather than a keyed map: the gate runs mid-tool-call with exactly one
 * candidate, so questions address it as `issue.description` with no id
 * plumbing. The hunk grounds `grounded`; `existing_issues` grounds
 * `duplicate` — the agent has no other view of what it already flagged.
 */
export function buildIssueRelevanceState(input: IssueRelevanceInput): JevState {
  const { issue } = input;
  return clampState({
    pr: {
      number: input.pr.externalId,
      title: input.pr.title,
      body: (input.pr.body ?? "").slice(0, PR_BODY_MAX_CHARS),
      additions: input.pr.additions,
      deletions: input.pr.deletions,
      changed_files: input.pr.changedFiles,
    },
    issue: {
      severity: issue.severity,
      title: issue.title,
      description: issue.description,
      file: issue.filePath,
      lines:
        issue.startLine === null ? null : `${issue.startLine}-${issue.endLine ?? issue.startLine}`,
      hunk: issue.hunk === null ? null : truncatePatchToChars(issue.hunk, 4_000, "hunk").patch,
    },
    existing_issues: input.existingIssues.map((i) => ({
      title: i.title,
      description: i.description,
      file: i.file,
    })),
  });
}

export interface ContinuationInput {
  readonly autoContinuations: number;
  readonly maxAutoContinuations: number;
  readonly lastCompletedPhase: string;
  readonly phaseAtLastContinuation: string | null;
  readonly counts: { readonly [name: string]: number };
  readonly countsAtLastContinuation: { readonly [name: string]: number } | null;
  readonly terminalReason: string;
  readonly elapsedMs: number;
  readonly totalTokens: number;
}

/**
 * State for the auto-continuation adjudication. Counters only, never
 * content — feeding summaries/markdown invites answering "is this good
 * enough", which invariant 12 reserves for `complete_walkthrough`. This is a
 * scheduling decision, and counters keep the call ~500 tokens.
 */
export function buildContinuationState(input: ContinuationInput): JevState {
  return {
    budget: {
      continuations_used: input.autoContinuations,
      continuations_max: input.maxAutoContinuations,
    },
    phase: {
      current: input.lastCompletedPhase,
      at_last_continuation: input.phaseAtLastContinuation,
    },
    counts: input.counts,
    counts_at_last_continuation: input.countsAtLastContinuation,
    last_turn_ended_because: input.terminalReason,
    elapsed_seconds: Math.round(input.elapsedMs / 1000),
    tokens_used: input.totalTokens,
  };
}

/**
 * Last-resort clamp: a pathological input degrades to a truncated-but-valid
 * state rather than a 422. Halves the largest array/record field repeatedly
 * until it fits, biased toward keeping header fields over list tails.
 * Truncation is announced in-band so the model doesn't read it as complete.
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
