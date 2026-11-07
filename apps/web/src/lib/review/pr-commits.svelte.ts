import { untrack } from "svelte";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import type { EdenData } from "$lib/api/wire";
import { createResource, type ResourceEntry } from "$lib/stores/resource";
import { refreshPrHead } from "$lib/stores/sync.svelte";

export type PrCommit = EdenData<ReturnType<typeof api.api.prs>["commits"]["get"]>[number];

interface Ask {
  readonly prId: string;
  readonly headSha: string | null;
}

/**
 * Keyed on the PR and the head Revv has stored: a head move makes a listed
 * answer wrong (it misses the new commits, and its "latest" marker points at a
 * commit that is no longer the head), so it is asked afresh, not refreshed in
 * place. An answer for one head never goes stale.
 */
const commits = createResource<Ask, readonly PrCommit[]>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async (_key, { prId, headSha }) => {
    const list = await call(api.api.prs({ id: prId }).commits.get(), "Failed to load commits");
    // The endpoint reads GitHub live, head first, so `list[0]` is the real
    // head. When it disagrees with the stored one the poll hasn't caught this
    // push yet, and every head-derived affordance (the Pull button, the
    // "latest" marker) is wrong until it does: reconcile now.
    const liveHead = list[0]?.sha;
    if (liveHead !== undefined && liveHead !== headSha) refreshPrHead(prId);
    return { status: "ok", data: list };
  },
});

function keyOf(prId: string, headSha: string | null): string {
  return `${prId}@${headSha ?? ""}`;
}

/** Ask for the PR's commits at `headSha`, unless that list is already here or on its way. */
export function loadPrCommits(prId: string, headSha: string | null): void {
  untrack(() => void commits.load(keyOf(prId, headSha), { prId, headSha }));
}

export function getPrCommits(
  prId: string,
  headSha: string | null,
): ResourceEntry<readonly PrCommit[]> {
  return commits.entry(keyOf(prId, headSha));
}

export function reset(): void {
  commits.reset();
}
