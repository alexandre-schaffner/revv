import { buildPullRequestDeepLink } from "@revv/shared";
import { toast } from "svelte-sonner";
import { getRepositories, getSelectedPr } from "./prs.svelte";

/**
 * Copying the selected PR's `revv://` deep link is reachable from two places —
 * the top-bar button and the ⇧⌘C shortcut — so the copy itself and the
 * transient "copied" acknowledgement live here rather than in the component.
 */

const COPIED_RESET_MS = 1400;

let copied = $state(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether a copy just succeeded; drives the top-bar check-mark swap. */
export function getPrLinkCopied(): boolean {
  return copied;
}

/**
 * Copy the selected PR's deep link. No-op when no PR is selected or its
 * repository hasn't loaded yet — both shortcut and button are then inert.
 */
export async function copySelectedPrLink(): Promise<void> {
  const pr = getSelectedPr();
  if (!pr) return;
  const repository = getRepositories().find((candidate) => candidate.id === pr.repositoryId);
  if (!repository) return;

  try {
    const url = buildPullRequestDeepLink({
      githubHost: repository.githubHost,
      repositoryFullName: repository.fullName,
      number: pr.externalId,
    });
    await navigator.clipboard.writeText(url);
    copied = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      copied = false;
      resetTimer = null;
    }, COPIED_RESET_MS);
  } catch {
    copied = false;
    toast.error("Couldn’t copy the PR link.");
  }
}
