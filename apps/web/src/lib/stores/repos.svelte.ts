// The repositories the account tracks: the list, its clone status, and
// adding, removing and re-cloning one.

import type { CloneStatus, Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { requestSync } from "$lib/stores/sync.svelte";
import { clearOwnerHueCache, preloadOwnerHues } from "$lib/utils/avatarPalette";
import { fetchPrs, removeRepoPrsLocally } from "./prs.svelte";

let repositories = $state<Repository[]>([]);
// Lets the `/` feed tell "no repos synced yet" (show the onboarding hero) from
// "repos haven't landed yet" (show nothing), which are the same empty array.
let reposFetchAttempted = $state(false);

export function getRepositories(): Repository[] {
  return repositories;
}

/** Whether {@link getRepositories} is answering from real data yet. */
export function getReposFetchAttempted(): boolean {
  return reposFetchAttempted;
}

export function getRepoById(repoId: string): Repository | null {
  return repositories.find((r) => r.id === repoId) ?? null;
}

export function getRepoOwner(repoId: string): string | null {
  return getRepoById(repoId)?.owner ?? null;
}

let repositoryLoadSeq = 0;

async function setRepositories(repos: Repository[]): Promise<void> {
  const seq = ++repositoryLoadSeq;
  await preloadOwnerHues(repos);
  if (seq === repositoryLoadSeq) repositories = repos;
}

export async function fetchRepos(): Promise<void> {
  try {
    const { data } = await api.api.repos.get();
    if (Array.isArray(data)) await setRepositories(data);
  } catch {
    // The next reconnect or focus reads the list again.
  } finally {
    reposFetchAttempted = true;
  }
}

export function onReposUpdated(repos: Repository[]): void {
  void setRepositories(repos);
}

export function onReposCloneStatus(data: {
  repoId: string;
  status: CloneStatus;
  error?: string;
}): void {
  repositories = repositories.map((r) =>
    r.id === data.repoId
      ? { ...r, cloneStatus: data.status, cloneError: data.error ?? r.cloneError }
      : r,
  );
}

// The read is DB-only and cheap; the debounce only keeps a reconnect and a
// focus, or a rapid alt-tab, from reading twice.
const REREAD_DEBOUNCE_MS = 4_000;
let lastRereadAt = 0;

function rereadRepos(): void {
  const now = Date.now();
  if (now - lastRereadAt < REREAD_DEBOUNCE_MS) return;
  lastRereadAt = now;
  void fetchRepos();
}

/** Updates broadcast while the stream was down reached no one. */
export function onEventsReconnected(): void {
  rereadRepos();
}

export function onWindowForeground(): void {
  rereadRepos();
}

export type AddRepoBody =
  | { readonly fullName: string; readonly mode?: "clone"; readonly basePath?: string }
  | { readonly fullName: string; readonly mode: "link"; readonly clonePath: string };

/** A bare `owner/name` string is sugar for `{ fullName, mode: "clone" }`. */
export type AddRepoInput = string | AddRepoBody;

/**
 * A rejected add, carrying the server's diagnosis: why GitHub couldn't see
 * the repo and, when known, the page that grants access.
 */
export class AddRepoError extends Error {
  constructor(
    message: string,
    readonly detail: string | null,
    readonly action: { readonly label: string; readonly url: string } | null,
  ) {
    super(message);
    this.name = "AddRepoError";
  }
}

export async function addRepo(input: AddRepoInput): Promise<void> {
  const body = typeof input === "string" ? { fullName: input } : input;
  const { error } = await api.api.repos.post(body);
  if (error) {
    const value = error.value as
      | {
          error?: string;
          message?: string;
          detail?: string;
          action?: { label: string; url: string };
        }
      | undefined;
    const msg = value?.error ?? value?.message ?? `Failed to add repository (HTTP ${error.status})`;
    throw new AddRepoError(msg, value?.detail ?? null, value?.action ?? null);
  }
  await fetchRepos();
  // The new repo's PRs arrive over `prs:updated` once the sync has run.
  await requestSync();
  await fetchPrs();
}

/**
 * Optimistic: the repository and its PRs leave the lists at once. On failure
 * exactly what was removed comes back, so lists updated meanwhile survive.
 */
export async function deleteRepo(id: string): Promise<void> {
  const index = repositories.findIndex((r) => r.id === id);
  const repo = repositories[index];
  const toastOptions = repo ? { description: repo.fullName } : undefined;
  const toastId = toast.loading("Removing repository...", toastOptions);

  repositories = repositories.filter((r) => r.id !== id);
  const restorePrs = removeRepoPrsLocally(id);

  try {
    const { error } = await api.api.repos({ id }).delete();
    if (error) throw new Error(apiErrorMessage(error, "Failed to remove repository"));
  } catch (e) {
    toast.dismiss(toastId);
    if (repo && !repositories.some((r) => r.id === id)) {
      repositories = [...repositories.slice(0, index), repo, ...repositories.slice(index)];
    }
    restorePrs();
    toast.error(e instanceof Error ? e.message : "Failed to remove repository");
    throw e;
  }

  toast.dismiss(toastId);
  toast.success("Repository removed", toastOptions);
  void Promise.all([fetchRepos(), fetchPrs()]);
}

export async function retryClone(id: string): Promise<void> {
  // The spinner shows at once; the server's background clone then broadcasts
  // `repos:clone-status`. A failed POST leaves the indicator actionable.
  onReposCloneStatus({ repoId: id, status: "pending", error: "" });
  try {
    await api.api.repos({ id })["retry-clone"].post();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to retry clone";
    onReposCloneStatus({ repoId: id, status: "error", error: msg });
    toast.error(msg);
    throw e;
  }
}

export function reset(): void {
  repositoryLoadSeq++;
  clearOwnerHueCache();
  repositories = [];
  reposFetchAttempted = false;
  lastRereadAt = 0;
}
