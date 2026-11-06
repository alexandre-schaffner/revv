// Which PR and repository the user is on. The URL is the only source: deep
// links, back/forward, Cmd+W and sign-out all move it, and selection follows.

import type { PullRequest, Repository } from "@revv/shared";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { getPrById } from "./prs.svelte";
import { getRepositories } from "./repos.svelte";

// Deriveds, so readers re-run only when the value changes, not on every
// navigation. The decoded route param, never `page.url.pathname`: PR ids are
// `<repoId>:<number>`, and a URL carrying the colon as `%3A` matches no PR.
const selectedPrId = $derived(
  page.route.id === "/review/[prId]" ? (page.params.prId ?? null) : null,
);

export function getSelectedPrId(): string | null {
  return selectedPrId;
}

const selectedPr = $derived(selectedPrId ? getPrById(selectedPrId) : null);

export function getSelectedPr(): PullRequest | null {
  return selectedPr;
}

/** The repository the page is about: a `/repo/[repoId]` page's, or the open PR's. */
const selectedRepoId = $derived(page.params.repoId ?? selectedPr?.repositoryId ?? null);

export function getSelectedRepoId(): string | null {
  return selectedRepoId;
}

const selectedRepo = $derived(
  selectedRepoId ? (getRepositories().find((r) => r.id === selectedRepoId) ?? null) : null,
);

export function getSelectedRepo(): Repository | null {
  return selectedRepo;
}

/** Whether the page shows one account's repository or PR (and must not outlive an account switch). */
export function isOnAccountPage(): boolean {
  return page.params.repoId !== undefined || selectedPrId !== null;
}

export async function selectPr(id: string): Promise<void> {
  if (selectedPrId === id) return;
  await goto(`/review/${id}`);
}
