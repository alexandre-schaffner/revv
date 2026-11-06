// The changed files of the PR on screen, as the review page, the sidebar tree
// and the chat's file references see them. One PR at a time; a different PR
// starts from empty.

import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { getActiveFilePath, setActiveFilePath } from "$lib/stores/pr-view-state.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import type { ReviewFile } from "$lib/types/review";
import { RequestState } from "./_types";

/** Re-entering the same PR within this window keeps the files already loaded. */
const REFETCH_WINDOW_MS = 60_000;

let files = $state<ReviewFile[]>([]);
/** The load the review page waits on. A refresh of the view on screen doesn't show here. */
let load = $state<RequestState<void>>(RequestState.idle());
/** The PR `files` belong to, and when they arrived. */
let loaded = $state<{ prId: string; at: number } | null>(null);
/** Only the latest load may write; anything older lost the race. */
let requestSeq = 0;

// The head each PR's files were loaded against. When `prs:updated` brings a
// newer `pr.headSha`, the diff on screen is behind it and the tab offers Pull.
let loadedHeadShas = $state(new Map<string, string>());

export function getReviewFiles(): ReviewFile[] {
  return files;
}

/** The paths `prId` changes, once its files are the ones loaded; empty until then. */
export function getChangedPaths(prId: string): readonly string[] {
  return loaded?.prId === prId ? files.map((f) => f.path) : [];
}

export function getIsLoadingFiles(): boolean {
  return load.status === "loading";
}

export function getFilesError(): string | null {
  return load.status === "error" ? load.error : null;
}

export function getLoadedHeadSha(prId: string): string | null {
  return loadedHeadShas.get(prId) ?? null;
}

async function fetchFiles(prId: string): Promise<ReviewFile[]> {
  const active = getActiveFilePath();
  const { data, error } = await api.api.prs({ id: prId }).files.get({
    query: active === null ? {} : { active },
  });
  if (error) throw new Error(apiErrorMessage(error, "Failed to fetch PR files"));
  return data.map((f) => ({
    path: f.path,
    patch: f.patch ?? null,
    additions: f.additions,
    deletions: f.deletions,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    ...(f.isNew ? { isNew: true as const } : {}),
    ...(f.isDeleted ? { isDeleted: true as const } : {}),
    ...(f.prerenderedHtml ? { prerenderedHtml: f.prerenderedHtml } : {}),
  }));
}

function install(prId: string, next: ReviewFile[]): void {
  files = next;
  load = RequestState.ok(undefined);
  loaded = { prId, at: Date.now() };
  // The open file stays open when it is still part of the diff.
  const active = getActiveFilePath();
  const first = next[0];
  if (first && !next.some((f) => f.path === active)) setActiveFilePath(first.path);
  // Read the head after the fetch: a `prs:updated` that landed meanwhile has
  // already re-cached the server's diff at that head, so the two agree. Open
  // and archived rows both count — a PR that merged while open moved lists.
  const headSha = getPrById(prId)?.headSha;
  if (headSha) {
    loadedHeadShas.set(prId, headSha);
    loadedHeadShas = new Map(loadedHeadShas);
  }
}

/**
 * Load the files of `prId`. The same PR loaded within the last minute is kept
 * as is. Otherwise a different PR starts from empty (the page shows its
 * loader), while the PR already on screen refreshes in place: its files stay
 * up until the new ones land, and a failed refresh keeps them.
 * The files are installed only once `alongside` has settled too, so the diff
 * first paints with what loads with it (its comment threads).
 */
export async function loadReviewFiles(prId: string, alongside?: Promise<unknown>): Promise<void> {
  const requestId = ++requestSeq;
  const samePr = loaded?.prId === prId && files.length > 0;
  if (samePr && loaded && Date.now() - loaded.at < REFETCH_WINDOW_MS) {
    load = RequestState.ok(undefined);
    return;
  }
  if (!samePr) {
    files = [];
    loaded = null;
    load = RequestState.loading();
  }
  try {
    const [next] = await Promise.all([fetchFiles(prId), alongside]);
    if (requestId === requestSeq) install(prId, next);
  } catch (e) {
    if (requestId !== requestSeq) return;
    if (samePr) {
      console.error("[review] Background diff refresh failed:", e);
      load = RequestState.ok(undefined);
      return;
    }
    load = RequestState.error(e instanceof Error ? e.message : "Failed to load diff");
  }
}

/**
 * Re-read the files of the view on screen at the PR's current head, with the
 * page loader up meanwhile. Resolves whether the new files are installed.
 */
export async function reloadReviewFiles(prId: string): Promise<boolean> {
  const requestId = ++requestSeq;
  load = RequestState.loading();
  try {
    const next = await fetchFiles(prId);
    if (requestId !== requestSeq) return false;
    install(prId, next);
    return true;
  } catch (e) {
    if (requestId === requestSeq) {
      load = RequestState.error(e instanceof Error ? e.message : "Failed to pull latest commit");
    }
    return false;
  }
}

/** Drop the files on screen; a load still in flight can't write them back. */
export function clearReviewFiles(): void {
  requestSeq++;
  files = [];
  load = RequestState.idle();
  loaded = null;
}

export function reset(): void {
  clearReviewFiles();
  loadedHeadShas = new Map();
}
