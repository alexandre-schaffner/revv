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

export interface RestackCarry {
  readonly fromWalkthroughId: string;
  readonly generationMode: WalkthroughGenerationMode;
}

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
  readonly partialId: string | null;
  readonly isResume: boolean;
  readonly requestedGenerationMode: WalkthroughGenerationMode;
  readonly resolvedGenerationMode: WalkthroughGenerationMode;
  readonly parentWalkthroughId: string | null;
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
