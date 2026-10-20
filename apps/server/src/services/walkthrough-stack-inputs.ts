// ── Walkthrough stack inputs ────────────────────────────────────────────────
//
// The stack and the layer's own-changes fingerprint are orchestrator inputs
// captured once at job start, like the commits. A resume reads its row's
// snapshot back rather than refetching, so it prompts with the stack its
// first run saw. The same inputs decide whether a restack can carry the last
// finished review over instead of running the agent.

import type {
  WalkthroughGenerationMode,
  WalkthroughMode,
  WalkthroughStackSnapshot,
} from "@revv/shared";
import { Effect } from "effect";
import type { DbService } from "./Db";
import {
  changedFiles,
  type DiffFingerprint,
  fingerprintFiles,
  isComparable,
} from "./stacks/fingerprint";
import { type RestackSource, WalkthroughService } from "./Walkthrough";

/** A finished review the job imports instead of running the agent. */
export interface RestackCarry {
  readonly fromWalkthroughId: string;
  /** The row holds the carried review, so it takes that review's mode. */
  readonly generationMode: WalkthroughGenerationMode;
}

/**
 * Whether a restack left this layer's own changes byte-identical (hunk
 * headers included, so every anchor still holds) to `source`'s, and `source`
 * answers the request. A full review of identical changes answers any
 * request; an incremental one only stands in for another incremental.
 */
export function planRestackCarry(
  source: RestackSource | null,
  requestedMode: WalkthroughGenerationMode,
  fingerprint: DiffFingerprint,
): RestackCarry | null {
  if (source === null || !isComparable(fingerprint)) return null;
  if (source.generationMode !== "full" && source.generationMode !== requestedMode) return null;
  if (changedFiles(source.diffFingerprint, fingerprint).length > 0) return null;
  return { fromWalkthroughId: source.id, generationMode: source.generationMode };
}

export interface StackInputs {
  readonly stack: WalkthroughStackSnapshot | null;
  readonly diffFingerprint: DiffFingerprint;
  /**
   * The parent review's fingerprint of the layer's own changes, for a
   * stacked layer's incremental run: it reads the layer's current patches
   * for the files that moved, judged against what the parent review saw.
   */
  readonly parentFingerprint: DiffFingerprint | null;
  readonly restack: RestackCarry | null;
}

export function resolveStackInputs(input: {
  readonly prId: string;
  readonly headSha: string;
  readonly mode: WalkthroughMode;
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly status: string;
    readonly patch: string | null;
  }>;
  /** The row this run resumes, if any. */
  readonly partialId: string | null;
  readonly isResume: boolean;
  readonly requestedGenerationMode: WalkthroughGenerationMode;
  /** The mode the row takes when nothing is carried. */
  readonly resolvedGenerationMode: WalkthroughGenerationMode;
  readonly parentWalkthroughId: string | null;
  /** The stack as GitHub has it now; read only for a fresh row. */
  readonly snapshotStack: Effect.Effect<WalkthroughStackSnapshot | null>;
}): Effect.Effect<StackInputs, never, WalkthroughService | DbService> {
  return Effect.gen(function* () {
    const walkthroughService = yield* WalkthroughService;
    const storedInputs = (walkthroughId: string) =>
      walkthroughService.getStackInputs(walkthroughId).pipe(Effect.orElseSucceed(() => null));

    const diffFingerprint = fingerprintFiles(input.files);
    const stack =
      input.partialId !== null
        ? ((yield* storedInputs(input.partialId))?.stackContext ?? null)
        : yield* input.snapshotStack;

    // Never on a resume: that row is already the agent's.
    const restack =
      stack !== null && input.partialId === null && !input.isResume
        ? planRestackCarry(
            yield* walkthroughService
              .findRestackSource(input.prId, input.headSha, input.mode)
              .pipe(Effect.orElseSucceed(() => null)),
            input.requestedGenerationMode,
            diffFingerprint,
          )
        : null;

    const generationMode = restack?.generationMode ?? input.resolvedGenerationMode;
    const parentFingerprint =
      stack !== null && generationMode === "incremental" && input.parentWalkthroughId !== null
        ? ((yield* storedInputs(input.parentWalkthroughId))?.diffFingerprint ?? null)
        : null;

    return { stack, diffFingerprint, parentFingerprint, restack };
  });
}
