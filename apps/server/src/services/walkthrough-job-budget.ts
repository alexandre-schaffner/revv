import type {
  WalkthroughStatus,
  WalkthroughStreamEvent,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { Effect } from "effect";
import { classifyFailure } from "../ai/jev/continuation";
import { debug } from "../logger";
import type { JevService } from "./Jev";

interface ContinuationSnapshot {
  readonly lastCompletedPhase: string | null;
  readonly blocks: ReadonlyArray<unknown>;
  readonly semanticSteps: ReadonlyArray<unknown>;
  readonly ratings: ReadonlyArray<unknown>;
  readonly issues: ReadonlyArray<unknown>;
}

export interface ContinuationLoopMetrics {
  readonly accumulatedTokenUsage: WalkthroughTokenUsage;
  readonly autoContinuations: number;
  readonly startedAt: number;
  readonly phaseAtLastContinuation: string | null;
  readonly countsAtLastContinuation: Record<string, number> | null;
  readonly terminalReason: string;
}

export function continuationCounts(
  partial: ContinuationSnapshot | null,
  missingInlineCommentCount: number,
): Record<string, number> {
  return {
    diff_steps: partial?.blocks.length ?? 0,
    semantic_steps: partial?.semanticSteps.length ?? 0,
    rated_axes: partial?.ratings.length ?? 0,
    issues: partial?.issues.length ?? 0,
    issues_needing_inline_comment: missingInlineCommentCount,
  };
}

export function buildContinuationAdjudicationState(input: {
  readonly state: ContinuationLoopMetrics;
  readonly partial: ContinuationSnapshot | null;
  readonly maxAutoContinuations: number;
  readonly missingInlineCommentCount: number;
}) {
  return {
    autoContinuations: input.state.autoContinuations,
    maxAutoContinuations: input.maxAutoContinuations,
    lastCompletedPhase: input.partial?.lastCompletedPhase ?? "none",
    phaseAtLastContinuation: input.state.phaseAtLastContinuation,
    counts: continuationCounts(input.partial, input.missingInlineCommentCount),
    countsAtLastContinuation: input.state.countsAtLastContinuation,
    terminalReason: input.state.terminalReason,
    elapsedMs: Date.now() - input.state.startedAt,
    totalTokens:
      input.state.accumulatedTokenUsage.inputTokens +
      input.state.accumulatedTokenUsage.outputTokens,
  };
}

/** Validate and close a run whose automatic-continuation budget has ended. */
export function finishWalkthroughAtBudgetEnd(input: {
  readonly state: ContinuationLoopMetrics;
  readonly stoppedEarlyBecause: string | null;
  readonly adjudicationEnabled: boolean;
  readonly maxAutoContinuations: number;
  readonly walkthroughId: string;
  readonly awaitPendingJudgments: Effect.Effect<void>;
  readonly loadFinalState: Effect.Effect<ContinuationSnapshot | null>;
  readonly countMissingInlineComments: () => number;
  readonly setStatus: (
    status: WalkthroughStatus,
    options?: { tokenUsage?: WalkthroughTokenUsage; errorMessage?: string },
  ) => Effect.Effect<void>;
  readonly emitEvent: (event: WalkthroughStreamEvent) => Effect.Effect<unknown>;
}): Effect.Effect<void, never, JevService> {
  return Effect.gen(function* () {
    yield* input.awaitPendingJudgments;
    const finalState = yield* input.loadFinalState;
    const phaseD = finalState?.lastCompletedPhase === "D";
    const missingInlineCommentCount = phaseD ? input.countMissingInlineComments() : 0;
    if (phaseD && missingInlineCommentCount > 0) {
      debug(
        "walkthrough-jobs",
        `exhausted auto-continuations with ${missingInlineCommentCount} line-anchored concern(s) still missing inline comment(s) — marking error`,
      );
    }

    const tokenUsage = input.state.accumulatedTokenUsage;
    if (!phaseD || missingInlineCommentCount > 0) {
      const base = phaseD
        ? "Generation finished but line-anchored concerns lack inline comments."
        : input.stoppedEarlyBecause !== null
          ? `Generation stopped early: ${input.stoppedEarlyBecause}.`
          : "Generation exhausted auto-continuation budget before reaching phase D.";
      const hint = yield* classifyFailure({
        enabled: input.adjudicationEnabled,
        state: buildContinuationAdjudicationState({
          state: input.state,
          partial: finalState,
          maxAutoContinuations: input.maxAutoContinuations,
          missingInlineCommentCount,
        }),
      });
      const message = hint === null ? base : `${base} ${hint}`;
      yield* input.setStatus("error", { errorMessage: message });
      yield* input
        .emitEvent({
          type: "lifecycle:error",
          data: { code: "AutoContinuationExhausted", message },
        })
        .pipe(Effect.catchAll(() => Effect.void));
    } else {
      yield* input.setStatus("complete", { tokenUsage });
      yield* input
        .emitEvent({
          type: "lifecycle:complete",
          data: { walkthroughId: input.walkthroughId, tokenUsage },
        })
        .pipe(Effect.catchAll(() => Effect.void));
    }
    yield* input
      .emitEvent({
        type: "done",
        data: { walkthroughId: input.walkthroughId, tokenUsage },
      })
      .pipe(Effect.catchAll(() => Effect.void));
  });
}
