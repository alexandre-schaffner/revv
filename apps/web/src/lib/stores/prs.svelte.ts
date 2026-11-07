// The account's pull requests: the open list, the closed/merged archive,
// pins, and the owner-only PR mutations.

import type { MergeMethod, PullRequest } from "@revv/shared";
import { type ReviewMode, reviewModeFor } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { reasonFor } from "$lib/prs/tagged-prs";
import { getCurrentUserLogin, isIdentityLoaded } from "$lib/stores/auth.svelte";

let pullRequests = $state<PullRequest[]>([]);
// Set once `fetchPrs` has settled (success or failure). Lets callers tell
// "this PR isn't in the list yet" from "this PR isn't in the list at all"
// without waiting forever on a row that will never arrive.
let prsFetchAttempted = $state(false);
let archivedPrs = $state<PullRequest[]>([]);
// PRs resolved one at a time by a `revv://` link, kept apart from the list
// reads so a list replacement can't drop them. A stale `fetchPrs()` (the window
// focus the link itself triggers fires one alongside `resolve-link`) or a
// first-page-only archived read would otherwise remove the row the review page
// is showing, leaving it on "Loading…" for good. The lists stay authoritative:
// a row there always wins over the copy held here.
let linkedPrs = $state<Map<string, PullRequest>>(new Map());
// Cursor for the next page of archived PRs. Null = exhausted or never fetched.
let archivedNextCursor = $state<string | null>(null);
let archivedLoadingMore = $state(false);
/** The authors the archive is filtered to server-side; empty = everyone. */
let archiveAuthors: ReadonlySet<string> = new Set();
let pinnedPrIds = $state<Set<string>>(new Set());

const archivedByRepo = $derived(Map.groupBy(archivedPrs, (pr) => pr.repositoryId));

export function getOpenPrCountByRepo(repoId: string): number {
  return pullRequests.filter((pr) => pr.repositoryId === repoId).length;
}

export function getArchivedPrs(): PullRequest[] {
  return archivedPrs;
}

export function getArchivedByRepo(): Map<string, PullRequest[]> {
  return archivedByRepo;
}

/**
 * Searches the open list, the archive and deep-linked PRs. A PR moves to the
 * archive the moment it merges, so a lookup in the open list alone silently
 * stops finding it.
 */
export function getPrById(prId: string): PullRequest | null {
  return (
    pullRequests.find((p) => p.id === prId) ??
    archivedPrs.find((p) => p.id === prId) ??
    linkedPrs.get(prId) ??
    null
  );
}

/**
 * The review lens for a PR, derived purely from identity: `"author"` when the
 * signed-in user is the PR author, otherwise `"reviewer"`. It is the default
 * walkthrough perspective, which the user can change per generation
 * (`getSelectedMode` in the walkthrough store).
 */
export function getReviewModeForPr(prId: string): ReviewMode {
  const pr = getPrById(prId);
  return reviewModeFor(pr?.authorLogin, getCurrentUserLogin());
}

/**
 * PRs the current user is involved in, grouped by repo — the repo homepage's
 * "needs your attention" table.
 *
 * Derived from the raw open-PR list rather than fetched, so it rides the same
 * `prs:updated` SSE reconcile as everything else and can never go stale. It
 * reads `pullRequests`, *not* `filteredPrs`: the sidebar's search box and
 * creator chips must not silently prune the homepage table.
 */
const taggedByRepo = $derived.by((): Map<string, PullRequest[]> => {
  const login = getCurrentUserLogin();
  if (!login) return new Map();
  const tagged = pullRequests.filter((pr) => reasonFor(pr, login) !== null);
  return Map.groupBy(tagged, (pr) => pr.repositoryId);
});

export function getTaggedPrs(repoId: string): PullRequest[] {
  return taggedByRepo.get(repoId) ?? [];
}

/**
 * Whether {@link getTaggedPrs} is answering from real data yet.
 *
 * The tagged set needs both the PR list *and* the viewer's GitHub login, so
 * an empty result before either lands is "unknown", not "nothing to do".
 * Callers must gate their empty state on this or they flash a false
 * "nothing needs your attention" on every cold start.
 */
export function getTaggedPrsResolved(): boolean {
  return isIdentityLoaded() && prsFetchAttempted;
}

/**
 * Apply the full open-PR state from a `prs:updated` SSE event.
 * The server sends the canonical DB list for the active account, so replacing
 * avoids stale closed/reopened rows and preserves server ordering.
 */
export function onPrsUpdated(incoming: PullRequest[]): void {
  pullRequests = incoming;
  if (incoming.length === 0 || archivedPrs.length === 0) return;

  const openIds = new Set(incoming.map((pr) => pr.id));
  archivedPrs = archivedPrs.filter((pr) => !openIds.has(pr.id));
}

/** Merge a targeted deep-link result before navigation mounts the review page. */
export function upsertPullRequest(pullRequest: PullRequest): void {
  const nextLinked = new Map(linkedPrs);
  nextLinked.set(pullRequest.id, pullRequest);
  linkedPrs = nextLinked;
  const nextOpen = pullRequests.filter((item) => item.id !== pullRequest.id);
  const nextArchived = archivedPrs.filter((item) => item.id !== pullRequest.id);
  if (pullRequest.status === "open") {
    pullRequests = [pullRequest, ...nextOpen];
    archivedPrs = nextArchived;
  } else {
    pullRequests = nextOpen;
    archivedPrs = [pullRequest, ...nextArchived];
  }
}

/**
 * Drop a repository's PRs and pins (it is being removed). The returned
 * function puts back exactly what this removed, keeping anything a
 * `prs:updated` brought meanwhile.
 */
export function removeRepoPrsLocally(repoId: string): () => void {
  const open = pullRequests.filter((pr) => pr.repositoryId === repoId);
  const archived = archivedPrs.filter((pr) => pr.repositoryId === repoId);
  const removedIds = new Set([...open, ...archived].map((pr) => pr.id));
  const pins = [...pinnedPrIds].filter((id) => removedIds.has(id));

  pullRequests = pullRequests.filter((pr) => pr.repositoryId !== repoId);
  archivedPrs = archivedPrs.filter((pr) => pr.repositoryId !== repoId);
  if (pins.length > 0) pinnedPrIds = new Set([...pinnedPrIds].filter((id) => !removedIds.has(id)));

  return () => {
    const openIds = new Set(pullRequests.map((pr) => pr.id));
    pullRequests = [...pullRequests, ...open.filter((pr) => !openIds.has(pr.id))];
    const archivedIds = new Set(archivedPrs.map((pr) => pr.id));
    archivedPrs = [...archivedPrs, ...archived.filter((pr) => !archivedIds.has(pr.id))];
    if (pins.length > 0) pinnedPrIds = new Set([...pinnedPrIds, ...pins]);
  };
}

/**
 * Re-read the list and pins (DB-only, cheap): after a reconnect, updates
 * broadcast meanwhile reached no one; after a return to the window, the
 * server's poll fiber may have slept through a suspend.
 */
export function rereadLists(): void {
  void Promise.all([fetchPrs(), fetchPinnedPrs()]);
}

export async function fetchPrs(): Promise<void> {
  try {
    pullRequests = await call(api.api.prs.get(), "Failed to load pull requests");
    void fetchArchivedPrs();
  } catch {
    // The next reconnect or focus reads the list again.
  } finally {
    prsFetchAttempted = true;
  }
}

function archivedAuthorsQuery(): { authors?: string } {
  return archiveAuthors.size === 0 ? {} : { authors: [...archiveAuthors].join(",") };
}

// A paged feed, not a per-key fetch: a filter reload discards pages still in
// flight for the old filter.
let archivedFetchToken = 0;

async function fetchArchivedPrs(): Promise<void> {
  const token = ++archivedFetchToken;
  try {
    const data = await call(
      api.api.prs.archived.get({ query: archivedAuthorsQuery() }),
      "Failed to load the archive",
    );
    if (token !== archivedFetchToken) return;
    archivedPrs = [...data.prs];
    archivedNextCursor = data.nextCursor;
  } catch {
    // The archive is a convenience; the next list read retries.
  }
}

/** Filter the archive to these authors (empty = everyone), server-side, and reload it. */
export function setArchiveAuthors(authors: ReadonlySet<string>): void {
  archiveAuthors = new Set(authors);
  void fetchArchivedPrs();
}

export async function fetchMoreArchived(): Promise<void> {
  if (archivedNextCursor === null) return;
  if (archivedLoadingMore) return;
  archivedLoadingMore = true;
  // A continuation of the same feed, not a reload: a filter reload landing
  // mid-flight discards this page rather than mixing stale-filter rows in.
  const token = archivedFetchToken;
  try {
    const data = await call(
      api.api.prs.archived.get({
        query: { ...archivedAuthorsQuery(), cursor: archivedNextCursor },
      }),
      "Failed to load the archive",
    );
    if (token !== archivedFetchToken) return;
    // A `pr:archived` patch may have landed between request and response.
    const existingIds = new Set(archivedPrs.map((p) => p.id));
    const fresh = data.prs.filter((p) => !existingIds.has(p.id));
    archivedPrs = [...archivedPrs, ...fresh];
    archivedNextCursor = data.nextCursor;
  } catch {
    // The cursor stays, so the user can retry.
  } finally {
    archivedLoadingMore = false;
  }
}

export function getArchivedNextCursor(): string | null {
  return archivedNextCursor;
}

export function getArchivedLoadingMore(): boolean {
  return archivedLoadingMore;
}

export function isPrPinned(prId: string): boolean {
  return pinnedPrIds.has(prId);
}

export async function fetchPinnedPrs(): Promise<void> {
  try {
    pinnedPrIds = new Set(await call(api.api.prs.pinned.get(), "Failed to load pins"));
  } catch {
    // The next reconnect or focus reads the pins again.
  }
}

export async function pinPr(prId: string): Promise<void> {
  if (pinnedPrIds.has(prId)) return;
  pinnedPrIds = new Set(pinnedPrIds).add(prId);
  try {
    await call(api.api.prs.pinned.post({ prId }), "Failed to pin");
  } catch {
    const next = new Set(pinnedPrIds);
    next.delete(prId);
    pinnedPrIds = next;
  }
}

export async function unpinPr(prId: string): Promise<void> {
  if (!pinnedPrIds.has(prId)) return;
  const next = new Set(pinnedPrIds);
  next.delete(prId);
  pinnedPrIds = next;
  try {
    await call(api.api.prs.pinned({ prId }).delete(), "Failed to unpin");
  } catch {
    pinnedPrIds = new Set(pinnedPrIds).add(prId);
  }
}

/**
 * Move a PR from the open list into the archive (`pr:archived`). A PR not
 * known locally waits for the next `prs:updated` reconcile.
 */
export function onPrArchived(data: {
  prId: string;
  repoId: string;
  status: "closed" | "merged";
  closedAt: string;
}): void {
  const archIdx = archivedPrs.findIndex((p) => p.id === data.prId);
  if (archIdx >= 0) {
    const existing = archivedPrs[archIdx];
    if (!existing) return;
    archivedPrs = [
      ...archivedPrs.slice(0, archIdx),
      { ...existing, status: data.status, closedAt: data.closedAt },
      ...archivedPrs.slice(archIdx + 1),
    ];
    pullRequests = pullRequests.filter((p) => p.id !== data.prId);
    return;
  }
  const openIdx = pullRequests.findIndex((p) => p.id === data.prId);
  if (openIdx >= 0) {
    const existing = pullRequests[openIdx];
    if (!existing) return;
    const archived = { ...existing, status: data.status, closedAt: data.closedAt };
    pullRequests = [...pullRequests.slice(0, openIdx), ...pullRequests.slice(openIdx + 1)];
    // The archive is filtered server-side by author, so a newly closed PR by
    // an author outside the filter must not pop into it.
    if (archiveAuthors.size === 0 || archiveAuthors.has(archived.authorLogin)) {
      archivedPrs = [archived, ...archivedPrs];
    }
  }
}

/**
 * Owner-only PR mutations are optimistic (conventions §4.6); the successful
 * round-trip's `prs:updated` broadcast reconciles the canonical list.
 */
function flipPrDraftLocally(prId: string, isDraft: boolean): void {
  pullRequests = pullRequests.map((p) => (p.id === prId ? { ...p, isDraft } : p));
}

export async function convertPrToDraft(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr || pr.isDraft) return;
  const prevIsDraft = pr.isDraft;

  flipPrDraftLocally(prId, true);

  try {
    await call(api.api.prs({ id: prId })["convert-to-draft"].post(), "Failed to convert to draft");
  } catch (e) {
    flipPrDraftLocally(prId, prevIsDraft);
    toast.error(thrownMessage(e));
    throw e;
  }
}

export async function markPrReadyForReview(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr?.isDraft) return;
  const prevIsDraft = pr.isDraft;

  flipPrDraftLocally(prId, false);

  try {
    await call(
      api.api.prs({ id: prId })["ready-for-review"].post(),
      "Failed to mark ready for review",
    );
  } catch (e) {
    flipPrDraftLocally(prId, prevIsDraft);
    toast.error(thrownMessage(e));
    throw e;
  }
}

/**
 * Put a PR back into the open list from the caller's pre-close copy — the
 * reverse of `onPrArchived`. From the copy, not the archive: with an author
 * filter active the forward move may not have added it there.
 */
function restorePrFromArchive(snapshot: PullRequest): void {
  archivedPrs = archivedPrs.filter((p) => p.id !== snapshot.id);
  if (pullRequests.some((p) => p.id === snapshot.id)) return;
  pullRequests = [snapshot, ...pullRequests];
}

export async function closePr(prId: string): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr) {
    // Not known locally: no optimistic move; SSE reconciles.
    try {
      await call(api.api.prs({ id: prId }).close.post(), "Failed to close PR");
    } catch (e) {
      toast.error(thrownMessage(e));
      throw e;
    }
    return;
  }

  onPrArchived({
    prId,
    repoId: pr.repositoryId,
    status: "closed",
    closedAt: new Date().toISOString(),
  });

  try {
    await call(api.api.prs({ id: prId }).close.post(), "Failed to close PR");
  } catch (e) {
    restorePrFromArchive(pr);
    toast.error(thrownMessage(e));
    throw e;
  }
}

const MERGE_FAILED = "Failed to merge pull request";

export async function mergePr(prId: string, mergeMethod: MergeMethod): Promise<void> {
  const pr = pullRequests.find((p) => p.id === prId);
  if (!pr) {
    // Not known locally: no optimistic move; SSE reconciles.
    try {
      await call(api.api.prs({ id: prId }).merge.post({ mergeMethod }), MERGE_FAILED);
    } catch (e) {
      toast.error(thrownMessage(e));
      throw e;
    }
    toast.success("Pull request merged successfully");
    return;
  }

  onPrArchived({
    prId,
    repoId: pr.repositoryId,
    status: "merged",
    closedAt: new Date().toISOString(),
  });

  try {
    await call(api.api.prs({ id: prId }).merge.post({ mergeMethod }), MERGE_FAILED);
    toast.success("Pull request merged successfully");
  } catch (e) {
    restorePrFromArchive(pr);
    toast.error(thrownMessage(e));
    throw e;
  }
}

export function getPullRequests(): PullRequest[] {
  return pullRequests;
}

export function reset(): void {
  pullRequests = [];
  prsFetchAttempted = false;
  archivedPrs = [];
  linkedPrs = new Map();
  archivedNextCursor = null;
  archivedLoadingMore = false;
  archiveAuthors = new Set();
  archivedFetchToken++;
  pinnedPrIds = new Set();
}
