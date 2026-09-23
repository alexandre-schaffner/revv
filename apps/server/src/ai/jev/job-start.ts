// ── Job-start judgment ───────────────────────────────────────────────────────
//
// One request, every question the diff alone can answer, in parallel: the
// risk tier that governs the agent's issue budget, the depth tier that picks
// the model, the reasoning effort, whether the PR should have been split, and
// a per-file attention score for every changed path.
//
// They batch because none depends on another's answer, and because the
// expensive part of this request is the *state* — the patches — not the
// questions. A per-file score asked separately would re-send the whole diff
// for the sake of a few hundred tokens of question text. Asked here it is
// close to free, which is the only reason judging forty files individually is
// affordable at all.

import { createHash } from "node:crypto";
import type { AcpAgentId, RiskLevel, ThinkingEffortSetting } from "@revv/shared";
import { Effect } from "effect";
import type { JevUnavailable } from "../../domain/errors";
import { debug } from "../../logger";
import { CacheService } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import { JevService } from "../../services/Jev";
import { scoreAnswerAt } from "./questions";
import {
  type GenerationLaunchOverride,
  type ReasoningEffort,
  type ReviewDepth,
  routeSizing,
} from "./routing";
import type { JobStartStateInput } from "./state";
import { buildJobStartState } from "./state";

/**
 * Ceiling for the job-start call.
 *
 * This sits on the critical path of `startJobBody`, which holds the per-PR
 * `startJobMutex` — a slow Jev must not wedge "user clicked Generate". It is
 * the only place Jev latency is user-visible, which is why the budget is
 * tight and the failure is a silent fall-through.
 */
export const JOB_START_TIMEOUT_MS = 8_000;

/**
 * How many files get an individual attention score.
 *
 * The cap is about question budget, not cost: System One allows 32k tokens
 * for state plus the *longest* question, and the state is already carrying
 * patches. Files past the cap fall back to path order, which is what every
 * file got before this hook existed.
 */
export const FILE_PRIORITY_MAX_FILES = 50;

// Criteria lifted from "Risk tiers (drive review depth)" in
// `ai/prompts/walkthrough-system-common.md` so the tier the orchestrator
// assigns and the depth the agent is told to work at can't drift apart.
const RISK_CRITERIA = {
  low: {
    what: "A quick tour is enough. Small diffs (under roughly 150 changed lines), documentation, renames, whitespace, test-only additions, isolated dependency bumps with no behavior change.",
    expect: "0-2 issues, 2-3 chapters, mostly passing verdicts.",
  },
  medium: {
    what: "A standard review. Moderate diffs, new business logic, API additions, configuration changes, non-trivial refactors.",
    expect: "1-5 issues, 4-6 chapters, a mix of pass and concern.",
  },
  high: {
    what: "A deep audit. Security-sensitive code, concurrency, database migrations, breaking API changes, payments, cross-service contracts.",
    not_for:
      "Sheer line count alone. A 2000-line generated lockfile or a formatter-only reflow is not high risk.",
    expect: "3-10+ issues, 7-11 chapters, multiple concerns and possibly a blocker.",
  },
} as const;

const DEPTH_CRITERIA = {
  shallow:
    "The change is mechanical or self-evident: a reader can verify it correct by reading the diff alone, without holding other parts of the codebase in mind.",
  standard:
    "The change has real logic to follow, but it is local. Understanding it means reading the changed files and their immediate callers.",
  deep: "The change is intricate: subtle invariants, concurrency, state machines, security boundaries, or behavior spread across many files that must be held in mind at once.",
} as const;

const EFFORT_CRITERIA = {
  minimal:
    "Skimming is enough. The change is self-evident and a careful reader would not pause over any of it.",
  standard: "Ordinary care. Follow the logic, check the obvious edge cases, move on.",
  thorough:
    "Worth real deliberation: invariants to hold in mind, edge cases that are not obvious, or consequences that reach beyond the changed files.",
  exhaustive:
    "Worth thinking as hard as possible. Getting this wrong is expensive — security boundaries, data integrity, concurrency, or migrations that cannot be undone.",
} as const;

/**
 * Per-file attention rubric, lowest first. The index is the tier, so the
 * ladder has to stay ordered — the agent reads it as a reading order.
 *
 * Deliberately not a proxy for size. A 2000-line lockfile is tier 0 and a
 * four-line change to a permission check is tier 4; sorting by line count,
 * which is what both GitHub and the current prompt effectively do, gets that
 * exactly backwards.
 */
const FILE_PRIORITY_LEVELS = [
  "Generated, vendored, or a lockfile. Do not read it — name the category and move on.",
  "Mechanical: a rename, an import reshuffle, a formatting pass, a version bump with no behavior change.",
  "A routine change whose blast radius stays inside this file or its immediate callers.",
  "New or altered logic worth following: a branch, a state transition, an error path, a data transformation.",
  "Security, authentication, payments, data migration, deletion, or a public contract other code depends on.",
] as const;

const SPLIT_COUNT_CRITERIA = {
  two: "Two pull requests. One clean seam — typically a refactor or a migration that could land first, and the feature that builds on it.",
  three:
    "Three. Several distinct concerns, each of which a reviewer could accept or reject on its own terms.",
  many: "Four or more. The change has absorbed so much unrelated work that naming the pieces is most of the review.",
} as const;

/**
 * The raw answers, before any agent-specific routing.
 *
 * Cached on `(prId, headSha)` because they are a judgment about the *diff* —
 * nothing here depends on which agent or model is configured. Switching
 * agents re-routes from the same answers rather than paying for a new call.
 */
export interface JobStartAnswers {
  readonly riskLevel: RiskLevel;
  readonly riskConfidence: number;
  readonly depth: ReviewDepth;
  readonly depthConfidence: number;
  readonly depthProbabilities: Readonly<Record<string, number>>;
  readonly reasoningEffort: ReasoningEffort;
  /**
   * Attention tier per changed path, 0–4. Absent for files past
   * {@link FILE_PRIORITY_MAX_FILES}; absent entirely on entries written
   * before the hook existed, which is why every reader treats it as optional.
   */
  readonly filePriorities?: Readonly<Record<string, number>>;
  /** How strongly the PR reads as several changes wearing one hat. */
  readonly splitScore?: number;
  readonly splitCount?: "two" | "three" | "many";
}

/**
 * Probability above which the split recommendation is worth handing over.
 *
 * High, on purpose. "Consider breaking this up" is the single most
 * eye-rolled sentence in code review, and an unwarranted one poisons the
 * overview it leads. It has to be nearly certain before the agent is told to
 * say it at all.
 */
export const SPLIT_RECOMMENDATION_FLOOR = 0.75;

/**
 * Cache namespace. Entries are immutable — the key pins the exact diff.
 *
 * Versioned suffix because the entries are immutable: adding questions to the
 * request means older entries can never grow the new fields, and a reader
 * that had to tolerate both shapes forever would be carrying the archaeology
 * of every past version. A bump costs one re-ask per PR, once.
 */
export const JOB_START_CACHE_NS = "jev:job-start:v2";

/**
 * Stable fingerprint of the changed-file set: path, status and line counts,
 * sorted. Deliberately excludes patch bodies, which are truncated differently
 * by different callers and would produce spurious misses.
 *
 * It is in the cache key alongside the head SHA because the two can
 * disagree. When a PR gets new commits the poller updates `pull_requests.
 * head_sha` and *then* invalidates the diff cache, so for a moment the row
 * advertises a SHA the cached diff doesn't correspond to. Keying on the SHA
 * alone would let a preview run in that window write an answer about the old
 * diff under the new SHA — and these entries are immutable, so it would
 * never correct itself. With the fingerprint, that entry is simply one the
 * real run never reads: worst case one wasted call, never a wrong answer.
 */
export function diffFingerprint(files: JobStartStateInput["files"]): string {
  const parts = files.map((f) => `${f.filename}:${f.status}:${f.additions}:${f.deletions}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export function jobStartCacheKey(prId: string, headSha: string, fingerprint: string): string {
  return `${prId}:${headSha}:${fingerprint}`;
}

/**
 * Question key for a file's attention score. Indexed rather than pathed: a
 * path can contain characters a question key can't, and the index is stable
 * against the same `files` array the state was built from.
 */
function filePriorityKey(index: number): string {
  return `file_${index}`;
}

/** Ask every job-start question in one request. Fails only with {@link JevUnavailable}. */
export function askJobStart(
  input: JobStartStateInput,
): Effect.Effect<JobStartAnswers, JevUnavailable, JevService> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    // Scored files are addressed by index into `state.files`, so the slice
    // here and the array the state builder walks must be the same one.
    const scoredFiles = input.files.slice(0, FILE_PRIORITY_MAX_FILES);
    const fileQuestions = Object.fromEntries(
      scoredFiles.map((file, index) => [
        filePriorityKey(index),
        {
          type: "score" as const,
          instructions: `How much of a reviewer's attention does \`${file.filename}\` deserve in this pull request? Judge what the change to it does, not how many lines it touches.`,
          criteria: FILE_PRIORITY_LEVELS,
        },
      ]),
    );

    const { answers } = yield* jev.ask({
      label: "job-start",
      timeoutMs: JOB_START_TIMEOUT_MS,
      state: buildJobStartState(input),
      questions: {
        risk_tier: {
          type: "choice",
          instructions:
            "How much reviewer attention does this pull request need? Judge the substantive change, not the raw line count — generated output (lockfiles, snapshots, `.d.ts`, vendored bundles, formatter-only reflows) does not raise the tier.",
          criteria: RISK_CRITERIA,
        },
        review_depth: {
          type: "choice",
          instructions:
            "How hard is this change to reason about correctly? This is about intricacy, not size or importance.",
          criteria: DEPTH_CRITERIA,
        },
        reasoning_effort: {
          type: "choice",
          instructions:
            "How much deliberation does reviewing this change deserve? This is about the cost of getting it wrong, not the size of the diff.",
          criteria: EFFORT_CRITERIA,
        },
        needs_split: {
          type: "noul",
          instructions:
            "This pull request carries several unrelated concerns that a reviewer could accept or reject independently, and would be easier to review as separate pull requests. False for a large change that is all one concern — size alone is not a reason to split.",
        },
        split_count: {
          type: "choice",
          instructions:
            "If this pull request were split along its natural seams, how many would it become?",
          criteria: SPLIT_COUNT_CRITERIA,
        },
        ...fileQuestions,
      },
    });

    const filePriorities: Record<string, number> = {};
    for (const [index, file] of scoredFiles.entries()) {
      const score = scoreAnswerAt(answers, filePriorityKey(index));
      if (score !== null) filePriorities[file.filename] = score;
    }

    return {
      riskLevel: answers.risk_tier.choice,
      riskConfidence: answers.risk_tier.confidence,
      depth: answers.review_depth.choice satisfies ReviewDepth,
      depthConfidence: answers.review_depth.confidence,
      depthProbabilities: answers.review_depth.probabilities,
      reasoningEffort: answers.reasoning_effort.choice satisfies ReasoningEffort,
      filePriorities,
      splitScore: answers.needs_split.noul,
      splitCount: answers.split_count.choice,
    };
  });
}

/**
 * The reading order to hand the agent, or `null` when the hook is off or the
 * answers predate it.
 *
 * Stable-sorted by tier descending, so files the model scored equally keep
 * the order the diff gave them. Unscored files (past the cap) sink to the
 * bottom rather than to the top — an unjudged file is not evidence of
 * importance, and putting it first would be the one failure mode that makes
 * the whole ordering untrustworthy.
 */
export function filePriorityOrder(
  answers: JobStartAnswers,
  files: readonly { readonly filename: string }[],
): ReadonlyArray<{ readonly filename: string; readonly tier: number | null }> | null {
  const priorities = answers.filePriorities;
  if (!priorities || Object.keys(priorities).length === 0) return null;
  return files
    .map((file, index) => {
      const raw = priorities[file.filename];
      return {
        filename: file.filename,
        tier: raw === undefined ? null : Math.round(raw),
        index,
      };
    })
    .sort((a, b) => (b.tier ?? -1) - (a.tier ?? -1) || a.index - b.index)
    .map(({ filename, tier }) => ({ filename, tier }));
}

/** The split recommendation, or `null` when it isn't confident enough to make. */
export function splitRecommendation(answers: JobStartAnswers): { readonly pieces: number } | null {
  if (answers.splitScore === undefined || answers.splitScore < SPLIT_RECOMMENDATION_FLOOR) {
    return null;
  }
  const pieces = answers.splitCount === "two" ? 2 : answers.splitCount === "three" ? 3 : 4;
  return { pieces };
}

/**
 * Turn cached answers into a launch override for a specific agent.
 *
 * Pure and cheap, so it runs at every read rather than being cached: the
 * configured agent, model and effort can all change between the preview and
 * the run, and the routing has to follow them.
 */
export function routeFromAnswers(
  answers: JobStartAnswers,
  opts: {
    readonly agent: AcpAgentId;
    readonly configuredModel: string | null | undefined;
    readonly configuredEffort: ThinkingEffortSetting | null | undefined;
    /**
     * The master TypeSafe auto-sizing switch. Off means the answers are still
     * used for the risk tier but never move the launch — both halves stay
     * where the user put them.
     */
    readonly autoSizing: boolean;
  },
): GenerationLaunchOverride | null {
  if (!opts.autoSizing) return null;
  return routeSizing({
    agent: opts.agent,
    depth: answers.depth,
    confidence: answers.depthConfidence,
    probabilities: answers.depthProbabilities,
    configuredModel: opts.configuredModel,
    configuredEffort: opts.configuredEffort,
    reasoningEffort: answers.reasoningEffort,
  });
}

/**
 * Cached job-start answers for a PR at a head SHA, or `null` when TypeSafe
 * can't answer.
 *
 * The cache is what lets the same judgment serve both the pre-generation
 * model preview and the run itself: whichever asks first pays, and the other
 * is free. In the common case — the user opens the PR, then clicks Generate
 * — that takes the call off `startJobBody`'s critical path entirely, which
 * is the one place its latency is user-visible (it holds `startJobMutex`).
 *
 * Immutable: the key carries the head SHA, so a new commit is a new entry.
 */
export function resolveJobStartAnswers(
  prId: string,
  headSha: string,
  state: JobStartStateInput,
): Effect.Effect<JobStartAnswers | null, never, JevService | CacheService | DbService> {
  return Effect.gen(function* () {
    const cache = yield* CacheService;
    return yield* cache
      .getOrFetch<JobStartAnswers, JevUnavailable, JevService>(
        JOB_START_CACHE_NS,
        jobStartCacheKey(prId, headSha, diffFingerprint(state.files)),
        () => askJobStart(state),
        { immutable: true },
      )
      .pipe(
        // A failure must not be cached — `getOrFetch` propagates it, and the
        // next caller retries. Both the preview and the run degrade to null.
        Effect.catchAll((e) =>
          Effect.sync(() => {
            debug("jev", `job-start unavailable for ${prId}@${headSha.slice(0, 7)}: ${String(e)}`);
            return null;
          }),
        ),
      );
  });
}
