import { classifyLayerMergeState, type StackMergeRunLayer } from "@revv/shared";
import { logError } from "../../logger";
import type { GitHubStack, GitHubStackLayer } from "./map";
import type { StepDecision } from "./merge-plan";

/**
 * Native-stack behaviour Revv acts on without having watched GitHub do it
 * (stacks can't be created through the API). Each is a predicate here; every
 * decision that leans on one calls it, so the importers of this module are the
 * places a GitHub surprise would land.
 */
export type UnverifiedStackBehaviour =
  /** An upper layer's BLOCKED means "the layers below haven't merged", not a rule of its own. */
  | "upper-blocked-means-layers-below"
  /** A layer whose base moves (GitHub's retarget or Revv's PATCH) stays in its stack. */
  | "base-change-keeps-membership";

/** GitHub disagreed with an {@link UnverifiedStackBehaviour}; `runId` is set when a merge run saw it. */
export interface Contradiction {
  readonly behaviour: UnverifiedStackBehaviour;
  readonly number: number;
  readonly runId?: string;
}

export function logContradiction(scope: string, c: Contradiction): void {
  const run = c.runId === undefined ? "" : ` (run ${c.runId})`;
  logError(scope, `GitHub contradicted ${c.behaviour} at #${c.number}${run}`);
}

/** Leans on `upper-blocked-means-layers-below`: BLOCKED off the stack base is read as ready. */
export function blockedOnlyByLayersBelow(layer: GitHubStackLayer, stack: GitHubStack): boolean {
  return classifyLayerMergeState(layer) === "blocked" && layer.baseRef !== stack.baseRefName;
}

/** The run moved this layer's base (or waited on GitHub to), so `base-change-keeps-membership` applies. */
export function baseWasMoved(target: StackMergeRunLayer): boolean {
  return target.state === "retargeting";
}

/** Leans on `base-change-keeps-membership`: Revv just moved `number`'s base, and `reread` is its stack read after. */
export function membershipAfterRetarget(
  stack: GitHubStack,
  number: number,
  reread: GitHubStack | null,
): Contradiction | null {
  const kept = reread?.number === stack.number && reread.layers.some((l) => l.number === number);
  return kept ? null : { behaviour: "base-change-keeps-membership", number };
}

export function contradiction(
  behaviour: UnverifiedStackBehaviour,
  number: number,
  message: string,
): Extract<StepDecision, { kind: "fail" }> {
  return { kind: "fail", number, message, contradicts: behaviour };
}
