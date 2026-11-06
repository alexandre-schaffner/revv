// GitHub teams per org, for the creator filter's "everyone on team X"
// shortcuts. Fetched the first time the filter opens for an org's repo.

import type { Team } from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { createResource } from "./resource";

/**
 * Keyed by lowercased org. A clean answer, an empty list included (no teams,
 * or the token lacks `read:org`), is kept for the session; a failure is asked
 * again on the next open rather than pinned as "no teams".
 */
const teams = createResource<string, Team[]>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async (_key, org) => {
    const { data, error } = await api.api.github.teams({ org }).get();
    if (error) return { status: "error", error: apiErrorMessage(error, "Failed to load teams") };
    return { status: "ok", data: data && "teams" in data ? data.teams : [] };
  },
});

export function getTeamsForOrg(owner: string): Team[] {
  return teams.data(owner.toLowerCase()) ?? [];
}

export function getTeamsFetchStateForOrg(owner: string): "idle" | "loading" | "loaded" | "error" {
  const entry = teams.entry(owner.toLowerCase());
  if (entry.loading) return "loading";
  switch (entry.request.status) {
    case "ok":
      return "loaded";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

export async function fetchTeamsForOrg(
  owner: string,
  options?: { force?: boolean },
): Promise<void> {
  const key = owner.toLowerCase();
  if (options?.force) teams.invalidate(key);
  await teams.load(key, owner);
}

export function reset(): void {
  teams.reset();
}
