import type { PrStackPlace, PullRequest } from "@revv/shared";

/** What one GitHub read said about a PR's native stack. */
export type StackSighting =
  /** The read didn't ask: REST, the detail batch, or a host that refused the fields. */
  | { readonly kind: "unseen" }
  /** The read asked. `null` is GitHub saying "not stacked". */
  | { readonly kind: "seen"; readonly place: PrStackPlace | null };

export const STACK_UNSEEN: StackSighting = { kind: "unseen" };

export function stackSeen(place: PrStackPlace | null): StackSighting {
  return { kind: "seen", place };
}

/** A PR as one GitHub read saw it. `stack` is required: every producer states what it saw. */
export type ObservedPr = Omit<PullRequest, "stack"> & { readonly stack: StackSighting };

/** The row `upsertPrs([observed])` leaves behind over `prior`. */
export function asStored(
  observed: ObservedPr,
  prior: Pick<PullRequest, "stack"> | undefined,
): PullRequest {
  return {
    ...observed,
    stack: observed.stack.kind === "seen" ? observed.stack.place : (prior?.stack ?? null),
  };
}
