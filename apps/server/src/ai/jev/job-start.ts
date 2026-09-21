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
import { type GenerationLaunchOverride, type ReviewDepth, routeDepth } from "./routing";
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

const WIDE_CONTEXT_CRITERIA = {
  no: "The change can be understood from the changed files and a handful of neighbours.",
  yes: "Reviewing this well requires holding an unusually large amount of code in mind at once — a very large diff, or a change whose correctness depends on many distant call sites.",
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
  readonly needsWideContext: boolean;
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
        needs_wide_ctx: {
          type: "choice",
          instructions: "Does reviewing this change require an unusually large context window?",
          criteria: WIDE_CONTEXT_CRITERIA,
        },
      },
    });

    return {
      riskLevel: answers.risk_tier.choice,
      riskConfidence: answers.risk_tier.confidence,
      depth: answers.review_depth.choice satisfies ReviewDepth,
      depthConfidence: answers.review_depth.confidence,
      depthProbabilities: answers.review_depth.probabilities,
      needsWideContext: answers.needs_wide_ctx.choice === "yes",
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
    needsWideContext: answers.needsWideContext,
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
