import type { PrStackPlace, PullRequest } from "@revv/shared";

/**
 * A PR as one GitHub read saw it, before it meets the stored row.
 *
 * `stack` is absent when the read couldn't see stacks: REST, the detail batch,
 * and an open list asked without them (or whose host refused them). Only an
 * open list that asked and got them sets it, and there `null` is GitHub saying
 * "not stacked". `PullRequest`, where `stack` is always what we know, is the
 * stored view.
 */
export type ObservedPr = Omit<PullRequest, "stack"> & { readonly stack?: PrStackPlace | null };

/** `observed` as it stands once written over `stored`: a stack it didn't see stays as stored. */
export function withStoredStack(
  observed: ObservedPr,
  stored: Pick<PullRequest, "stack"> | undefined,
): PullRequest {
  return {
    ...observed,
    stack: observed.stack === undefined ? (stored?.stack ?? null) : observed.stack,
  };
}
