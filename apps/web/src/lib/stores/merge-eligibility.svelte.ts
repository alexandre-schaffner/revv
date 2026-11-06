import type { CiRollupState, MergeEligibility, PrConversation, ReviewDecision } from "@revv/shared";
import { isMergeStateSettling } from "$lib/utils/merge-blocker";
import { getMergeEligibility } from "./prs.svelte";
import { createResource } from "./resource";

/** Everything a mergeability answer depends on that Revv observes. Equal questions share one answer. */
export interface MergeQuestion {
  readonly prId: string;
  readonly headSha: string | null;
  readonly reviewDecision: ReviewDecision | null;
  readonly ciState: CiRollupState | null;
}

/**
 * Per PR, versioned by the question: a different question supersedes the
 * running ask, while the PR's last answer stays up. An answer GitHub is still
 * settling (it computes mergeability lazily after a push) is asked again.
 */
const answers = createResource<void, MergeEligibility>({
  freshForMs: 15_000,
  retryDelaysMs: [3_000, 3_000, 3_000, 3_000],
  fetch: async (prId) => {
    const eligibility = await getMergeEligibility(prId);
    if (!eligibility)
      return { status: "error", error: "Couldn't check whether this can be merged" };
    return isMergeStateSettling(eligibility.mergeStateStatus)
      ? { status: "pending", data: eligibility }
      : { status: "ok", data: eligibility };
  },
});

/**
 * The question for a PR as Revv currently sees it. Everyone who asks about
 * the same PR builds it here, so equal views share one GitHub call.
 */
export function mergeQuestionFor(
  prId: string,
  headSha: string | null,
  conversation: PrConversation | null,
): MergeQuestion {
  return {
    prId,
    headSha,
    reviewDecision: conversation?.reviewDecision ?? null,
    ciState: conversation?.ci?.state ?? null,
  };
}

function questionVersion(q: MergeQuestion): string {
  return `${q.headSha}|${q.reviewDecision}|${q.ciState}`;
}

/** The PR's latest answer; null without a question. */
export function getMergeAnswer(question: MergeQuestion | null): MergeEligibility | null {
  return question ? answers.data(question.prId) : null;
}

/** Asks GitHub unless an equal question is in flight, retrying, or answered recently. */
export function askMergeEligibility(question: MergeQuestion): void {
  void answers.load(question.prId, undefined, questionVersion(question));
}

export function reset(): void {
  answers.reset();
}
