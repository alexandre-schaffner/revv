import { type CiRollupState, MERGEABLE_STATES, type ReviewDecision } from "@revv/shared";

/** GitHub computes mergeability lazily; the first read is often this. */
export function isMergeStateSettling(mergeStateStatus: string): boolean {
  return mergeStateStatus.toUpperCase() === "UNKNOWN";
}

/**
 * Why GitHub would refuse to merge this PR right now, or null when it would
 * take it. `BLOCKED` alone doesn't say which rule holds it, so the review
 * decision and CI rollup from the conversation narrow it down.
 */
export function mergeBlocker(input: {
  mergeStateStatus: string;
  reviewDecision: ReviewDecision | null;
  ciState: CiRollupState | null;
}): string | null {
  const state = input.mergeStateStatus.toUpperCase();
  if (MERGEABLE_STATES.has(state)) return null;
  switch (state) {
    case "DIRTY":
      return "This branch has conflicts that must be resolved";
    case "BEHIND":
      return "This branch is out of date with the base branch";
    case "DRAFT":
      return "Draft pull requests can't be merged";
    case "UNKNOWN":
      return "GitHub is still checking whether this can be merged";
  }
  if (input.reviewDecision === "review_required") return "An approving review is required";
  if (input.reviewDecision === "changes_requested") return "Changes were requested";
  if (input.ciState === "failure" || input.ciState === "error") {
    return "Required checks are failing";
  }
  if (input.ciState === "pending" || input.ciState === "expected") {
    return "Required checks haven't finished";
  }
  return "Merging is blocked by branch protection";
}
