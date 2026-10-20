// ── Stack rebase: the pure half ─────────────────────────────────────────────
//
// What a cascading rebase replays, decided from one read of GitHub. The same
// cascade GitHub's "Rebase stack" button and `gh stack rebase` run: bottom-up,
// every open layer goes onto the (rebased) open layer below it, the lowest
// onto the stack base's tip. A layer's own commits start where the layer
// below's head was before the rebase, which is also what keeps a squash-merged
// layer's commits out of the layer above (`git rebase --onto`, not a plain
// rebase that would replay them).

import type { GitHubStack } from "./map";
import { RETARGET_BY_PATCH } from "./merge-plan";

export interface RebaseStep {
  readonly number: number;
  /** The branch the rebased head is pushed to. */
  readonly headRef: string;
  /** The head before the rebase, which the push leases against. */
  readonly tip: string;
  /** The stack base's tip, or the rebased head of the open layer below. */
  readonly onto: { readonly kind: "base" } | { readonly kind: "layer"; readonly number: number };
  /**
   * Where the layer's own commits begin, best guess first: the head the layer
   * below had. Only a candidate that is an ancestor of `tip` is used; with
   * none, the merge base with the onto side is.
   */
  readonly upstreams: readonly string[];
}

export interface RebasePlan {
  readonly steps: readonly RebaseStep[];
  /** The lowest open layer, when it still targets a merged layer's branch. */
  readonly retarget: number | null;
}

export type RebasePlanResult =
  | { readonly ok: true; readonly plan: RebasePlan }
  | { readonly ok: false; readonly message: string };

export function planStackRebase(stack: GitHubStack): RebasePlanResult {
  const layers = stack.layers.toSorted((a, b) => a.position - b.position);
  const steps: RebaseStep[] = [];
  let lowestOpen: number | null = null;
  let retarget: number | null = null;

  for (const [i, layer] of layers.entries()) {
    if (layer.status === "merged") continue;
    const above = layers.slice(i + 1).some((l) => l.status !== "merged" && l.status !== "closed");
    if (layer.status === "closed") {
      if (above) {
        return {
          ok: false,
          message: `#${layer.number} was closed — unstack it on GitHub before rebasing what sits on it`,
        };
      }
      continue;
    }
    if (!layer.headSha) {
      return { ok: false, message: `GitHub didn't report #${layer.number}'s head` };
    }
    if (layer.isInMergeQueue) {
      return { ok: false, message: `#${layer.number} is in the merge queue` };
    }

    const below = layers[i - 1];
    const prevOpen = steps.at(-1);
    steps.push({
      number: layer.number,
      headRef: layer.headRef,
      tip: layer.headSha,
      onto: prevOpen ? { kind: "layer", number: prevOpen.number } : { kind: "base" },
      upstreams: below?.headSha ? [below.headSha] : [],
    });

    if (lowestOpen === null) {
      lowestOpen = layer.number;
      if (RETARGET_BY_PATCH && below?.status === "merged" && layer.baseRef !== stack.baseRefName) {
        retarget = layer.number;
      }
    }
  }

  if (steps.length === 0) return { ok: false, message: "Nothing in this stack is open" };
  return { ok: true, plan: { steps, retarget } };
}

/** An open layer whose base has commits it lacks, or that needs rebasing past a merge. */
export function stackNeedsRebase(stack: GitHubStack): boolean {
  return stack.layers.some(
    (l) =>
      l.status !== "merged" &&
      l.status !== "closed" &&
      ((l.behindBy ?? 0) > 0 || l.mergeStateStatus === "BEHIND" || l.mergeStateStatus === "DIRTY"),
  );
}
