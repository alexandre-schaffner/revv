import { buildPullRequestDeepLink } from "@revv/shared";
import { toast } from "svelte-sonner";
import { getRepoById } from "./repos.svelte";
import { getSelectedPr } from "./route.svelte";

const COPIED_RESET_MS = 1400;

let copied = $state(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

export function getPrLinkCopied(): boolean {
  return copied;
}

export async function copySelectedPrLink(): Promise<void> {
  const pr = getSelectedPr();
  if (!pr) return;
  const repository = getRepoById(pr.repositoryId);
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
