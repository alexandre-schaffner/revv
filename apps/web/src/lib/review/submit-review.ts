// Posting "Your review" to GitHub. The server builds the review from the
// chosen issues and the pending line comments, posts it, pushes the
// reviewer's pending replies and pulls the threads back; this asks for it and
// reports the outcome.

import type { WalkthroughIssue } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { acceptWriteResult } from "$lib/stores/conversation.svelte";
import { loadSession } from "$lib/stores/review.svelte";
import { markIssuesAsSubmitted } from "$lib/walkthrough/store.svelte";
import { draftThreadIds } from "./threads";

export type ReviewAction = "approve" | "request_changes" | "comment";

function actionLabel(action: ReviewAction): string {
  if (action === "approve") return "Approved";
  if (action === "comment") return "Comments posted";
  return "Changes requested";
}

/**
 * Submit the review. Resolves true once GitHub has it; a failure has been
 * reported to the user and resolves false.
 */
export async function submitReview(
  prId: string,
  action: ReviewAction,
  issues: readonly WalkthroughIssue[],
): Promise<boolean> {
  const issueIds = issues.map((issue) => issue.id);
  // The drafts on screen, so nothing the reviewer hasn't seen goes up.
  const threadIds = draftThreadIds(prId);
  try {
    const result = await call(
      api.api.reviews({ id: prId })["github-submit"].post({ action, threadIds, issueIds }),
      "Failed to submit review",
    );
    acceptWriteResult(prId, { conversation: result.conversation });
    // Re-read past the freshness window: rows still missing their externalId
    // would be posted again by the next submit.
    await loadSession(prId, true);

    toast.success(`${actionLabel(action)} on GitHub`);
    const { failedReplies } = result;
    if (failedReplies > 0) {
      toast.warning(
        failedReplies === 1
          ? "1 reply was not sent to GitHub"
          : `${failedReplies} replies were not sent to GitHub`,
      );
    }
    // Comments on lines no longer in the diff are held back by the server
    // rather than failing the whole review; they stay local drafts.
    const skipped = result.skippedComments;
    const first = skipped[0];
    if (first) {
      toast.warning(
        skipped.length === 1
          ? `1 comment not posted — ${first.path}:${first.line}: ${first.reason}`
          : `${skipped.length} comments not posted — their lines are no longer part of the diff`,
      );
    }
    // Echo the server's stamp so "already posted" shows before the next read.
    if (result.issuesSubmittedAt !== null) {
      markIssuesAsSubmitted(prId, result.submittedIssueIds, result.issuesSubmittedAt);
    }
    return true;
  } catch (e) {
    toast.error(thrownMessage(e));
    return false;
  }
}
