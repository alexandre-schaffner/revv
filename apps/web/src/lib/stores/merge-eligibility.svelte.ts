import type { MergeEligibility } from "@revv/shared";
import { isMergeStateSettling, loginsMatch } from "@revv/shared";
import { untrack } from "svelte";
import { api } from "$lib/api/client";
import { getCurrentUserLogin } from "./auth.svelte";
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
    const { data: eligibility, error } = await api.api.prs({ id: prId })["merge-eligibility"].get();
    if (error || !eligibility || !("mergeStateStatus" in eligibility))
      return { status: "error", error: "Couldn't check whether this can be merged" };
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

/**
 * Ask GitHub whether the PR can merge, unless the same question is in flight,
 * retrying, or answered recently. Call from an effect: it follows the PR's
 * head, review decision and CI state.
 */
export function askMergeEligibility(prId: string): void {
  const version = questionVersion(prId);
  if (version !== null) untrack(() => void answers.load(prId, undefined, version));
}

/** The PR's last answer; it stays up while a newer question is asked. */
export function getMergeEligibility(prId: string): MergeEligibility | null {
  return answers.data(prId);
}

/**
 * Revv offers merging to the PR's author and to a reviewer who approved it;
 * whether GitHub lets them is `getMergeEligibility(prId).canMerge`.
 */
export function viewerMayMerge(prId: string): boolean {
  const pr = getPrById(prId);
  if (!pr) return false;
  if (loginsMatch(pr.authorLogin, getCurrentUserLogin())) return true;
  const request = getConversation(prId).request;
  if (request.status !== "ok") return false;
  const { reviewers, viewerLogin } = request.data;
  return reviewers.some(
    (r) => r.kind === "user" && loginsMatch(r.actor.login, viewerLogin) && r.verdict === "approved",
  );
}

/** The viewer may merge the PR, and GitHub says they can. The one gate for the PR and its stack. */
export function canViewerMerge(prId: string): boolean {
  return viewerMayMerge(prId) && getMergeEligibility(prId)?.canMerge === true;
}

export function onPrMergeEligibility(data: { prId: string; eligibility: MergeEligibility }): void {
  answers.put(data.prId, data.eligibility);
}

/** A `pr:merge-eligibility` sent while the stream was down reached no one: ask again. */
export function onEventsReconnected(): void {
  for (const prId of answers.waitingKeys()) void answers.refresh(prId, undefined);
}

export function reset(): void {
  answers.reset();
}
