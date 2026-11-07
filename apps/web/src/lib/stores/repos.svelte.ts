// The repositories the account tracks: the list, its clone status, and
// adding, removing and re-cloning one.

import type { ApiErrorCode, CloneStatus, Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { ApiError, call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { clearOwnerHueCache, preloadOwnerHues } from "$lib/repos/avatar-palette";
import { requestSync } from "$lib/stores/sync.svelte";
import { fetchPrs, removeRepoPrsLocally } from "./prs.svelte";

let repositories = $state<Repository[]>([]);
// Lets the `/` feed tell "no repos synced yet" (show the onboarding hero) from
// "repos haven't landed yet" (show nothing), which are the same empty array.
let reposFetchAttempted = $state(false);

export function getRepositories(): Repository[] {
  return repositories;
}

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
    await setRepositories(await call(api.api.repos.get(), "Failed to load repositories"));
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

/** Re-read the list (DB-only, cheap) after a reconnect or a return to the window. */
export function rereadRepos(): void {
  void fetchRepos();
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
    readonly code: ApiErrorCode | null,
    readonly detail: string | null,
    readonly action: { readonly label: string; readonly url: string } | null,
  ) {
    super(message);
    this.name = "AddRepoError";
  }
}

function accessAction(value: unknown): AddRepoError["action"] {
  if (typeof value !== "object" || value === null) return null;
  const { label, url } = value as Record<string, unknown>;
  return typeof label === "string" && typeof url === "string" ? { label, url } : null;
}

export async function addRepo(input: AddRepoInput): Promise<void> {
  const body = typeof input === "string" ? { fullName: input } : input;
  try {
    await call(api.api.repos.post(body), "Failed to add repository");
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    throw new AddRepoError(
      e.message,
      e.code,
      typeof e.body?.detail === "string" ? e.body.detail : null,
      accessAction(e.body?.action),
    );
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
    await call(api.api.repos({ id }).delete(), "Failed to remove repository");
  } catch (e) {
    toast.dismiss(toastId);
    if (repo && !repositories.some((r) => r.id === id)) {
      repositories = [...repositories.slice(0, index), repo, ...repositories.slice(index)];
    }
    restorePrs();
    toast.error(thrownMessage(e));
    throw e;
  }

  toast.dismiss(toastId);
  toast.success("Repository removed", toastOptions);
  void Promise.all([fetchRepos(), fetchPrs()]);
}

export async function retryClone(id: string): Promise<void> {
  // The spinner shows at once; the server's background clone then broadcasts
  // `repos:clone-status`. A refused POST gets none, so it leaves the indicator actionable.
  onReposCloneStatus({ repoId: id, status: "pending", error: "" });
  try {
    await call(api.api.repos({ id })["retry-clone"].post(), "Failed to retry clone");
  } catch (e) {
    const msg = thrownMessage(e);
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
}
