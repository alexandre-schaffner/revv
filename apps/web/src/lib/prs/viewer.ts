// Who "me" is on a pull request: the login of the user's account that owns
// its repository, the account the server acts as on it (authorship, what a
// submit posts, which drafts are theirs), whichever host is active.

import { loginsMatch, type ReviewMode, reviewModeFor } from "@revv/shared";
import { loginOnHost } from "$lib/stores/auth.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { getRepoById } from "$lib/stores/repos.svelte";

/** A PR whose repository isn't listed is the active host's: the lists are. */
export function viewerLoginOnPr(prId: string): string | null {
  const pr = getPrById(prId);
  return loginOnHost(pr ? (getRepoById(pr.repositoryId)?.githubHost ?? null) : null);
}

/** The viewer opened the PR. */
export function viewerIsAuthor(prId: string): boolean {
  const pr = getPrById(prId);
  return pr !== null && loginsMatch(pr.authorLogin, viewerLoginOnPr(prId));
}

/**
 * The review lens for a PR, derived purely from identity: `"author"` when the
 * viewer is the PR author, otherwise `"reviewer"`. It is the default
 * walkthrough perspective, which the user can change per generation
 * (`getSelectedMode` in the walkthrough store).
 */
export function reviewModeForPr(prId: string): ReviewMode {
  return reviewModeFor(getPrById(prId)?.authorLogin, viewerLoginOnPr(prId));
}
