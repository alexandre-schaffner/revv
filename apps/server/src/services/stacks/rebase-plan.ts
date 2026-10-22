import { isOpenLayer } from "@revv/shared";
import type { GitHubStack } from "./map";

export interface RebaseStep {
  readonly number: number;
  readonly headRef: string;
  readonly tip: string;
  readonly onto: { readonly kind: "base" } | { readonly kind: "layer"; readonly number: number };
  readonly upstreams: readonly string[];
}

export interface RebasePlan {
  readonly steps: readonly RebaseStep[];
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
    const above = layers.slice(i + 1).some(isOpenLayer);
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
      if (below?.status === "merged" && layer.baseRef !== stack.baseRefName) {
        retarget = layer.number;
      }
    }
  }

  if (steps.length === 0) return { ok: false, message: "Nothing in this stack is open" };
  return { ok: true, plan: { steps, retarget } };
}
