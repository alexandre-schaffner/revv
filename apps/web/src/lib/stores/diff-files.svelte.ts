// The changed files of each open PR, as the review page, the sidebar tree and
// the chat's file references see them.

import { SvelteMap } from "svelte/reactivity";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { getActiveFilePath, setActiveFilePath } from "$lib/stores/pr-view-state.svelte";
import { getPrById } from "$lib/stores/prs.svelte";
import { RequestState } from "./_types";
import { createResource } from "./resource";

/** A file in the review, with the git patch for @pierre/diffs to render. */
export interface ReviewFile {
  path: string;
  oldPath?: string;
  /** Unified diff (patch) string from the GitHub API, or null for binary files. */
  patch: string | null;
  additions: number;
  deletions: number;
  isNew?: boolean;
  isDeleted?: boolean;
  /**
   * Server-rendered HTML (`@pierre/diffs/ssr`) of the unified diff, sent only
   * for the first visible file and never for oversized patches. Hydrated for
   * an instant first paint in unified, unwrapped mode; otherwise the client
   * renders from `patch`.
   */
  prerenderedHtml?: string;
}

interface LoadedFiles {
  readonly files: readonly ReviewFile[];
  /** `pr.headSha` once the files landed; null when the PR row isn't known yet. */
  readonly headSha: string | null;
}

const NO_FILES: readonly ReviewFile[] = [];

/** An answer lands only once `alongside` (the review threads) has settled too. */
const loads = createResource<Promise<unknown> | undefined, LoadedFiles>({
  freshForMs: 60_000,
  keepDataOnError: true,
  fetch: async (prId, alongside) => {
    const [files] = await Promise.all([fetchFiles(prId), alongside]);
    // Read after the fetch: a `prs:updated` that landed meanwhile has already
    // re-cached the server's diff at that head, so the two agree. Open and
    // archived rows both count — a PR that merged while open moved lists.
    return { status: "ok", data: { files, headSha: getPrById(prId)?.headSha ?? null } };
  },
});

// The head each PR's files were last loaded against, kept while a pull
// reloads them. When `prs:updated` brings a newer `pr.headSha`, the diff on
// screen is behind it and the tab offers Pull.
const loadedHeadShas = new SvelteMap<string, string>();

/** The files of `prId`: loading until its first load lands, then the last good answer. */
export function getReviewFiles(prId: string): RequestState<readonly ReviewFile[]> {
  const request = loads.entry(prId).request;
  return request.status === "ok" ? RequestState.ok(request.data.files) : request;
}

/** The files of `prId` once loaded; empty until then. */
export function getLoadedFiles(prId: string): readonly ReviewFile[] {
  return loads.data(prId)?.files ?? NO_FILES;
}

/** The paths `prId` changes, once its files are loaded; empty until then. */
export function getChangedPaths(prId: string): readonly string[] {
  return getLoadedFiles(prId).map((f) => f.path);
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

function install(prId: string, request: RequestState<LoadedFiles>): boolean {
  if (request.status !== "ok") return false;
  const { files, headSha } = request.data;
  if (headSha) loadedHeadShas.set(prId, headSha);
  const active = getActiveFilePath();
  const first = files[0];
  if (first && !files.some((f) => f.path === active)) setActiveFilePath(first.path);
  return true;
}

/**
 * Load the files of `prId`, unless they loaded within the last minute. A PR
 * already loaded refreshes in place: its files stay up until the new ones
 * land, and a failed refresh keeps them.
 */
export async function loadReviewFiles(prId: string, alongside?: Promise<unknown>): Promise<void> {
  install(prId, await loads.load(prId, alongside));
}

/**
 * Re-read the files of `prId` at the PR's current head, with the page loader
 * up meanwhile. Resolves whether the new files are installed.
 */
export async function reloadReviewFiles(prId: string): Promise<boolean> {
  loads.invalidate(prId);
  return install(prId, await loads.load(prId, undefined));
}

/** Forget the files of `prId`; a load still in flight can't write them back. */
export function releaseReviewFiles(prId: string): void {
  loads.invalidate(prId);
}

export function reset(): void {
  loads.reset();
  loadedHeadShas.clear();
}
