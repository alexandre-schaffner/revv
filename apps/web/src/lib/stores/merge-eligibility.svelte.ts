import type { MergeEligibility } from "@revv/shared";
import { isMergeStateSettling, loginsMatch } from "@revv/shared";
import { untrack } from "svelte";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { viewerIsAuthor, viewerLoginOnPr } from "$lib/prs/viewer";
import { getConversation } from "./conversation.svelte";
import { getPrById } from "./prs.svelte";
import { createResource } from "./resource";

/**
 * Per PR, versioned by the question: a different question supersedes the
 * running ask, while the PR's last answer stays up. GitHub computes
 * mergeability lazily after a push; the server keeps asking and pushes the
 * settled answer (`pr:merge-eligibility`).
 */
const answers = createResource<void, MergeEligibility>({
  freshForMs: 15_000,
  waitForSignalMs: 30_000,
  fetch: async (prId) => {
    const eligibility = await call(
      api.api.prs({ id: prId })["merge-eligibility"].get(),
      "Couldn't check whether this can be merged",
    );
    return isMergeStateSettling(eligibility.mergeStateStatus)
      ? { status: "pending", data: eligibility }
      : { status: "ok", data: eligibility };
  },
});

/**
 * Everything a mergeability answer depends on that Revv observes, as a
 * version: equal views of a PR share one GitHub call, and a new head, review
 * decision or CI state asks again. Null until the PR's conversation has
 * loaded (or failed to), so the first ask already carries it.
 */
function questionVersion(prId: string): string | null {
  const pr = getPrById(prId);
  const request = getConversation(prId).request;
  if (!pr || (request.status !== "ok" && request.status !== "error")) return null;
  const conversation = request.status === "ok" ? request.data : null;
  return `${pr.headSha}|${conversation?.reviewDecision ?? null}|${conversation?.ci?.state ?? null}`;
}

export interface MergeEligibilityView {
  /** The PR's last answer; it stays up while a newer question is asked. */
  readonly current: MergeEligibility | null;
  /** The viewer may merge the PR, and GitHub says they can. The one gate for the PR and its stack. */
  readonly viewerCanMerge: boolean;
}

/**
 * The PR's mergeability, asked of GitHub while `shouldAsk` holds and again
 * whenever the PR's head, review decision or CI state moves (unless the same
 * question is in flight, retrying, or answered recently). Call during
 * component init.
 */
export function useMergeEligibility(
  getPrId: () => string,
  shouldAsk: () => boolean,
): MergeEligibilityView {
  $effect(() => {
    const prId = getPrId();
    if (!shouldAsk()) return;
    const version = questionVersion(prId);
    if (version !== null) untrack(() => void answers.load(prId, undefined, version));
  });
  return {
    get current() {
      return answers.data(getPrId());
    },
    get viewerCanMerge() {
      const prId = getPrId();
      return viewerMayMerge(prId) && answers.data(prId)?.canMerge === true;
    },
  };
}

/** The viewer approved the PR in a GitHub review. */
export function viewerApproved(prId: string): boolean {
  const request = getConversation(prId).request;
  if (request.status !== "ok") return false;
  const viewer = viewerLoginOnPr(prId);
  return request.data.reviewers.some(
    (r) => r.kind === "user" && loginsMatch(r.actor.login, viewer) && r.verdict === "approved",
  );
}

/**
 * Revv offers merging to the PR's author and to a reviewer who approved it;
 * whether GitHub lets them is the mergeability answer's `canMerge`.
 */
export function viewerMayMerge(prId: string): boolean {
  return viewerIsAuthor(prId) || viewerApproved(prId);
}

export function onPrMergeEligibility(data: { prId: string; eligibility: MergeEligibility }): void {
  answers.put(data.prId, data.eligibility);
}

export function reset(): void {
  answers.reset();
}
