// ── Auto-continuation adjudication ───────────────────────────────────────────
// Two small hooks on the budget-exhaustion path: decline to spend an auto-
// continuation when the next turn clearly won't finish, and name the probable
// failure cause for the user-facing message. Neither can change a terminal
// state — enforced in the type.

import { Effect } from "effect";
import { debug } from "../../logger";
import { JevService } from "../../services/Jev";
import { optionalJev } from "./optional";
import { buildContinuationState, type ContinuationInput } from "./state";

/**
 * The only two things adjudication may say. No `"complete"` or `"extend"` arm:
 * invariant 12 reserves completion for `complete_walkthrough`, invariant 9 fixes
 * the retry budget, and both are type-level here so widening either is a
 * compile error.
 */
export type ContinuationVerdict =
  | { readonly kind: "proceed" }
  | { readonly kind: "stop-doomed"; readonly reason: string };

const PROCEED: ContinuationVerdict = { kind: "proceed" };

/** Budget for the call. Counters only, so the request is tiny. */
export const CONTINUATION_TIMEOUT_MS = 6_000;

/** Confidence floor for a stop; both answers must clear it. "Stop" costs the user a walkthrough; "proceed" only costs one turn the budget already bounds. */
export const STOP_CONFIDENCE_FLOOR = 0.7;

const PROGRESS_CRITERIA = {
  substantial:
    "The counts moved meaningfully since the previous continuation — new chapters, new steps, new axes rated, or a phase advanced.",
  marginal: "Something moved, but only a little relative to what is still missing.",
  none: "Nothing moved. The counts and the phase are where they were at the previous continuation.",
} as const;

const FINISH_CRITERIA = {
  likely:
    "Given what is already persisted and what remains, one more turn plausibly gets this to a completed 9-axis scorecard.",
  unlikely:
    "The run looks stuck rather than slow: another turn would repeat what the last one did.",
} as const;

export interface AdjudicateInput extends ContinuationInput {
  /** Kill switch. Off returns `proceed` without a call. */
  readonly enabled: boolean;
}

/** Decides whether to spend the next auto-continuation. Asymmetric: stops only on "no progress AND unlikely to finish", both above the confidence floor; every other answer or failure mode is `proceed`. */
export function adjudicateContinuation(
  input: AdjudicateInput,
): Effect.Effect<ContinuationVerdict, never, JevService> {
  if (!input.enabled) return Effect.succeed(PROCEED);
  return Effect.gen(function* () {
    const jev = yield* JevService;
    const result = yield* optionalJev(
      "continuation adjudication",
      jev.ask({
        label: "continuation",
        timeoutMs: CONTINUATION_TIMEOUT_MS,
        state: buildContinuationState(input),
        questions: {
          progress_since_last: {
            type: "choice",
            instructions:
              "How much did this generation run accomplish since the previous continuation? Compare `counts` against `counts_at_last_continuation` and `phase.current` against `phase.at_last_continuation`.",
            criteria: PROGRESS_CRITERIA,
          },
          will_next_turn_finish: {
            type: "choice",
            instructions:
              "If the run is given one more turn, is it likely to reach a complete walkthrough — all nine axes rated?",
            criteria: FINISH_CRITERIA,
          },
        },
      }),
    );

    if (result === null) return PROCEED;

    const progress = result.answers.progress_since_last;
    const finish = result.answers.will_next_turn_finish;
    const doomed =
      progress.choice === "none" &&
      finish.choice === "unlikely" &&
      progress.confidence >= STOP_CONFIDENCE_FLOOR &&
      finish.confidence >= STOP_CONFIDENCE_FLOOR;

    if (!doomed) return PROCEED;
    debug(
      "jev",
      `continuation adjudged doomed (progress=none ${progress.confidence.toFixed(2)}, finish=unlikely ${finish.confidence.toFixed(2)})`,
    );
    return {
      kind: "stop-doomed",
      reason: "no measurable progress since the previous continuation",
    } as const;
  });
}

const FAILURE_CRITERIA = {
  "prompt-too-large":
    "The run failed because the input exceeded what the model could take — a very large diff or an over-long context.",
  "agent-timeout": "The agent stopped producing output and the turn timed out.",
  "repeated-tool-error":
    "The agent kept calling a tool that kept rejecting it, and never recovered.",
  "model-refused": "The model declined to continue.",
  unknown: "None of the above fits, or there is not enough signal to tell.",
} as const;

/** Budget for the enrichment. Strictly cosmetic, so it gets very little. */
export const FAILURE_CLASSIFY_TIMEOUT_MS = 5_000;

/** Guesses why a run failed, for the user-facing message. Strictly cosmetic: changes a string, never a status. Returns `null` when it can't help. */
export function classifyFailure(input: {
  readonly enabled: boolean;
  readonly state: ContinuationInput;
}): Effect.Effect<string | null, never, JevService> {
  if (!input.enabled) return Effect.succeed(null);
  return Effect.gen(function* () {
    const jev = yield* JevService;
    const result = yield* optionalJev(
      "failure classification",
      jev.ask({
        label: "continuation",
        timeoutMs: FAILURE_CLASSIFY_TIMEOUT_MS,
        state: buildContinuationState(input.state),
        questions: {
          cause: {
            type: "choice",
            instructions:
              "A walkthrough generation run exhausted its retry budget without finishing. What most likely went wrong? `last_turn_ended_because` is the terminal reason the runtime recorded.",
            criteria: FAILURE_CRITERIA,
          },
        },
      }),
    );
    if (result === null) return null;
    const cause = result.answers.cause;
    return cause.choice === "unknown" ? null : FAILURE_HINT[cause.choice];
  });
}

/** One clause, appended to the existing error message. */
const FAILURE_HINT: Record<Exclude<keyof typeof FAILURE_CRITERIA, "unknown">, string> = {
  "prompt-too-large": "The diff was likely too large for the model's context.",
  "agent-timeout": "The agent appears to have stalled rather than failed.",
  "repeated-tool-error": "The agent got stuck repeating a rejected tool call.",
  "model-refused": "The model declined to continue.",
};
