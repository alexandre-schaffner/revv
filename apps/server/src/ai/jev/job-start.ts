// ── Job-start judgment ───────────────────────────────────────────────────────
//
// One request, three independent questions, answered in parallel: the risk
// tier that governs the agent's issue budget, the depth tier that picks the
// model, and whether the change needs a wide context window.
//
// They batch because none depends on another's answer — a second round trip
// would only cost latency on the one path where latency is user-visible.

import { createHash } from "node:crypto";
import type { AcpAgentId, RiskLevel } from "@revv/shared";
import { Effect } from "effect";
import type { JevUnavailable } from "../../domain/errors";
import { debug } from "../../logger";
import { CacheService } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import { JevService } from "../../services/Jev";
import {
  type GenerationLaunchOverride,
  type ReasoningEffort,
  type ReviewDepth,
  routeDepth,
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
}

/** Cache namespace. Entries are immutable — the key pins the exact diff. */
export const JOB_START_CACHE_NS = "jev:job-start";

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

/** Ask the three job-start questions. Fails only with {@link JevUnavailable}. */
export function askJobStart(
  input: JobStartStateInput,
): Effect.Effect<JobStartAnswers, JevUnavailable, JevService> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
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
      },
    });

    return {
      riskLevel: answers.risk_tier.choice,
      riskConfidence: answers.risk_tier.confidence,
      depth: answers.review_depth.choice satisfies ReviewDepth,
      depthConfidence: answers.review_depth.confidence,
      depthProbabilities: answers.review_depth.probabilities,
      reasoningEffort: answers.reasoning_effort.choice satisfies ReasoningEffort,
    };
  });
}

/**
 * Turn cached answers into a launch override for a specific agent.
 *
 * Pure and cheap, so it runs at every read rather than being cached: the
 * configured agent and model can change between the preview and the run,
 * and the routing has to follow them.
 */
export function routeFromAnswers(
  answers: JobStartAnswers,
  opts: {
    readonly agent: AcpAgentId;
    readonly configuredModel: string | null | undefined;
    readonly autoModel: boolean;
  },
): GenerationLaunchOverride | null {
  if (!opts.autoModel) return null;
  return routeDepth({
    agent: opts.agent,
    depth: answers.depth,
    confidence: answers.depthConfidence,
    probabilities: answers.depthProbabilities,
    configuredModel: opts.configuredModel,
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
