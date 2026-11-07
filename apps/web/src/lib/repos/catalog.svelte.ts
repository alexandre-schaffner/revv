// What the add-repo pickers offer: the repositories the account can see on
// GitHub, their open-PR counts, and where a managed clone lands.

import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { RequestState } from "$lib/stores/_types";
import { preloadOwnerHues } from "./avatar-palette";

export interface AvailableRepo {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly avatarUrl: string | null;
}

let catalog = $state<RequestState<AvailableRepo[]>>(RequestState.idle());
// Open-PR count per `owner/name`. Filled in after the list lands, so the
// picker renders at once and the row hints appear as the counts arrive.
let prCounts = $state<Record<string, number>>({});
// Set once the counts have settled (either way), so a missing entry reads as
// "No open PRs" instead of a hint that never fills in.
let prCountsLoaded = $state(false);
// The server's managed-clone base (`REVV_CLONE_DIR`), asked rather than
// hardcoded so an operator override is honoured. Null until fetched or when
// the fetch failed; the add then omits `basePath` and the server picks.
let defaultCloneBaseDir = $state<string | null>(null);

export function getAvailableRepos(): AvailableRepo[] {
  return catalog.status === "ok" ? catalog.data : [];
}

export function getAvailableReposLoading(): boolean {
  return catalog.status === "loading";
}

export function getAvailableReposFetchFailed(): boolean {
  return catalog.status === "error";
}

export function getAvailablePrCount(fullName: string): number | undefined {
  return prCounts[fullName];
}

export function getAvailablePrCountsLoaded(): boolean {
  return prCountsLoaded;
}

/** `force` asks the server to bypass its own cache of the GitHub list. */
export async function fetchAvailableRepos(force = false): Promise<void> {
  catalog = RequestState.loading();
  try {
    const data = await call(
      api.api.github.repos.get({ query: { force: force ? "true" : undefined } }),
      "Failed to load repositories",
    );
    await preloadOwnerHues(data);
    catalog = RequestState.ok(data);
    void fetchAvailablePrCounts(data.map((r) => r.fullName));
  } catch {
    catalog = RequestState.error("Failed to load repositories");
  }
}

async function fetchAvailablePrCounts(fullNames: string[]): Promise<void> {
  if (fullNames.length === 0) {
    prCountsLoaded = true;
    return;
  }
  try {
    const data = await call(api.api.github["pr-counts"].post({ fullNames }), "PR counts failed");
    prCounts = { ...prCounts, ...data.counts };
  } catch {
    // The hint is optional; the list works without counts.
  } finally {
    prCountsLoaded = true;
  }
}

export async function fetchDefaultCloneBaseDir(): Promise<void> {
  if (defaultCloneBaseDir !== null) return;
  try {
    ({ path: defaultCloneBaseDir } = await call(
      api.api.repos["clone-base-dir"].get(),
      "Couldn't read the clone folder",
    ));
  } catch {
    // Stays null: the add omits `basePath` and the server applies its default.
  }
}

export function getDefaultCloneBaseDir(): string | null {
  return defaultCloneBaseDir;
}

/** The clone base is the server's, not the account's, so it survives. */
export function reset(): void {
  catalog = RequestState.idle();
  prCounts = {};
  prCountsLoaded = false;
}
