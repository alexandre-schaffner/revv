// ── Job-start judgment ───────────────────────────────────────────────────────
//
// One request, three independent questions, answered in parallel: the risk
// tier that governs the agent's issue budget, the depth tier that picks the
// model, and whether the change needs a wide context window.
//
// They batch because none depends on another's answer — a second round trip
// would only cost latency on the one path where latency is user-visible.

import type { AcpAgentId, RiskLevel } from "@revv/shared";
import { Effect } from "effect";
import type { JevUnavailable } from "../../domain/errors";
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

export interface JobStartJudgment {
  readonly riskLevel: RiskLevel;
  readonly riskConfidence: number;
  /** `null` when the depth answer didn't clear the gates, or the agent has no ladder. */
  readonly launchOverride: GenerationLaunchOverride | null;
}

export interface JobStartJudgmentInput extends JobStartStateInput {
  readonly agent: AcpAgentId;
  /** The model the user configured — the floor the override never routes below. */
  readonly configuredModel: string | null | undefined;
  /** Honour the depth answer. Off means "record the tier, don't move the model". */
  readonly autoModel: boolean;
}

/**
 * Ask the job-start questions.
 *
 * Fails only with {@link JevUnavailable}; the caller collapses that to `null`
 * and falls back to the agent's own risk judgment and the configured model.
 * The depth answer is recorded even when `autoModel` is off, so the
 * confidence thresholds stay tunable from real runs.
 */
export function judgeJobStart(
  input: JobStartJudgmentInput,
): Effect.Effect<JobStartJudgment, JevUnavailable, JevService> {
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

    const riskLevel = answers.risk_tier.choice;
    const depth = answers.review_depth.choice;

    return {
      riskLevel,
      riskConfidence: answers.risk_tier.confidence,
      launchOverride: input.autoModel
        ? routeDepth({
            agent: input.agent,
            depth: depth satisfies ReviewDepth,
            confidence: answers.review_depth.confidence,
            probabilities: answers.review_depth.probabilities,
            configuredModel: input.configuredModel,
            needsWideContext: answers.needs_wide_ctx.choice === "yes",
          })
        : null,
    };
  });
}
