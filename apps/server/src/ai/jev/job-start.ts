// ── Job-start judgment ──────────────────────────────────────────────────────
//
// One request, every question the diff alone can answer: risk tier, depth
// tier, reasoning effort, split recommendation, per-file attention score.
// Batched because none depends on another's answer, and the state (patches)
// dominates cost — scoring files here is near-free vs. re-sending the diff
// per file.

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
 * Ceiling for the job-start call. Sits on `startJobBody`'s critical path
 * (holds `startJobMutex`), the only place Jev latency is user-visible; failure falls through silently.
 */
export const JOB_START_TIMEOUT_MS = 8_000;

/**
 * How many files get an individual attention score. Bounded by System One's
 * 32k-token state+question budget. Files past the cap fall back to path order.
 */
export const FILE_PRIORITY_MAX_FILES = 50;

// Mirrors "Risk tiers (drive review depth)" in
// `ai/prompts/walkthrough-system-common.md` so orchestrator and agent can't drift.
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
 * Per-file attention rubric, lowest first; index = tier, order matters. Not a
 * size proxy: a 2000-line lockfile is tier 0, a 4-line permission check is tier 4.
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
 * Raw answers, before agent-specific routing. Cached on `(prId, headSha)` — a
 * judgment about the diff, independent of agent/model, so switching agents
 * re-routes without a new call.
 */
export interface JobStartAnswers {
  readonly riskLevel: RiskLevel;
  readonly riskConfidence: number;
  readonly depth: ReviewDepth;
  readonly depthConfidence: number;
  readonly depthProbabilities: Readonly<Record<string, number>>;
  readonly reasoningEffort: ReasoningEffort;
  /** Attention tier per changed path, 0-4. Absent past {@link FILE_PRIORITY_MAX_FILES}, or for pre-hook entries. */
  readonly filePriorities?: Readonly<Record<string, number>>;
  /** How strongly the PR reads as several changes wearing one hat. */
  readonly splitScore?: number;
  readonly splitCount?: "two" | "three" | "many";
}

/** Split recommendations are only handed over when near-certain; a wrong one poisons the overview. */
export const SPLIT_RECOMMENDATION_FLOOR = 0.75;

/**
 * Cache namespace; entries immutable, key pins the exact diff. Versioned
 * suffix: adding questions means old entries can't grow new fields, so a
 * schema change bumps the version (one re-ask per PR).
 */
export const JOB_START_CACHE_NS = "jev:job-start:v2";

/**
 * Fingerprint of the changed-file set (path/status/line counts, sorted);
 * excludes patch bodies, truncated inconsistently across callers.
 *
 * Combined with head SHA in the cache key: the poller updates
 * `pull_requests.head_sha` before invalidating the diff cache, so a preview
 * mid-window could write an old diff's answer under the new SHA — entries
 * are immutable, so that never self-corrects. Worst case: one wasted call,
 * never a wrong answer.
 */
export function diffFingerprint(files: JobStartStateInput["files"]): string {
  const parts = files.map((f) => `${f.filename}:${f.status}:${f.additions}:${f.deletions}`).sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export function jobStartCacheKey(prId: string, headSha: string, fingerprint: string): string {
  return `${prId}:${headSha}:${fingerprint}`;
}

/** Question key for a file's attention score. Indexed, not pathed: a path can contain characters a question key can't. */
function filePriorityKey(index: number): string {
  return `file_${index}`;
}

/** Ask every job-start question in one request. Fails only with {@link JevUnavailable}. */
export function askJobStart(
  input: JobStartStateInput,
): Effect.Effect<JobStartAnswers, JevUnavailable, JevService> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    // Scored files are addressed by index into `state.files`; slice here must match the state builder's array.
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
 * Reading order to hand the agent, or `null` when the hook is off or answers
 * predate it. Stable-sorted by tier descending; unscored files (past the cap)
 * sink to the bottom — an unjudged file isn't evidence of importance.
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
 * Turns cached answers into a launch override for a specific agent. Pure and
 * cheap, so it runs on every read rather than being cached — the configured
 * agent/model/effort can change between preview and run.
 */
export function routeFromAnswers(
  answers: JobStartAnswers,
  opts: {
    readonly agent: AcpAgentId;
    readonly configuredModel: string | null | undefined;
    readonly configuredEffort: ThinkingEffortSetting | null | undefined;
    /** Master TypeSafe auto-sizing switch. Off: answers still set risk tier but never move the launch. */
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
 * can't answer. The cache lets one judgment serve both the preview and the
 * run — whichever asks first pays, keeping Jev off `startJobBody`'s critical
 * path in the common case. Immutable: head SHA in the key means a new commit
 * is a new entry.
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
        // Failures aren't cached; getOrFetch propagates so the next caller retries. Both preview and run degrade to null.
        Effect.catchAll((e) =>
          Effect.sync(() => {
            debug("jev", `job-start unavailable for ${prId}@${headSha.slice(0, 7)}: ${String(e)}`);
            return null;
          }),
        ),
      );
  });
}
