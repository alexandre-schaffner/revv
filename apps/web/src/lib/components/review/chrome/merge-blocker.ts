import {
  type CiRollupState,
  isMergeableState,
  mergeStateOf,
  type ReviewDecision,
  rollupBucket,
} from "@revv/shared";
import { REVIEW_DECISION_LABEL } from "$lib/conversation/verdict";

export type MergeGate =
  | { readonly kind: "open" }
  | { readonly kind: "bypass"; readonly rule: string }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * `BLOCKED` alone doesn't say which rule holds the PR, so the review decision
 * and CI rollup from the conversation narrow it down.
 */
export function mergeGate(input: {
  mergeStateStatus: string;
  reviewDecision: ReviewDecision | null;
  ciState: CiRollupState | null;
  canBypassProtections: boolean;
}): MergeGate {
  const state = mergeStateOf(input.mergeStateStatus);
  if (isMergeableState(state)) return { kind: "open" };
  switch (state) {
    case "DIRTY":
      return { kind: "blocked", reason: "This branch has conflicts that must be resolved" };
    case "BEHIND":
      return { kind: "blocked", reason: "This branch is out of date with the base branch" };
    case "DRAFT":
      return { kind: "blocked", reason: "Draft pull requests can't be merged" };
    case "UNKNOWN":
      return { kind: "blocked", reason: "GitHub is still checking whether this can be merged" };
  }
  const rule = protectionRule(input.reviewDecision, input.ciState);
  return state === "BLOCKED" && input.canBypassProtections
    ? { kind: "bypass", rule }
    : { kind: "blocked", reason: rule };
}

function protectionRule(
  reviewDecision: ReviewDecision | null,
  ciState: CiRollupState | null,
): string {
  if (reviewDecision === "review_required" || reviewDecision === "changes_requested") {
    return REVIEW_DECISION_LABEL[reviewDecision];
  }
  const ci = rollupBucket(ciState);
  if (ci === "fail") return "Required checks are failing";
  if (ci === "pending") return "Required checks haven't finished";
  return "Merging is blocked by branch protection";
}
