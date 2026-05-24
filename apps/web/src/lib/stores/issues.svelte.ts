import type { Issue } from "@revv/shared";
import { api } from "$lib/api/client";
import { RequestState } from "$lib/stores/_types";

// Per-repo issue feed state. Each repo gets its own `RequestState<Issue[]>`
// entry so the homepage can render the right state without spilling load
// status across repos.
let openIssuesByRepo = $state<Map<string, RequestState<Issue[]>>>(new Map());

function setEntry(repoId: string, entry: RequestState<Issue[]>): void {
  // Reactive-Map mutation per docs/conventions.md §4.3: `.set` then reassign.
  openIssuesByRepo.set(repoId, entry);
  openIssuesByRepo = new Map(openIssuesByRepo);
}

export function getOpenIssuesState(repoId: string): RequestState<Issue[]> {
  return openIssuesByRepo.get(repoId) ?? RequestState.idle<Issue[]>();
}

export function getOpenIssues(repoId: string): Issue[] {
  const entry = openIssuesByRepo.get(repoId);
  return entry?.status === "ok" ? entry.data : [];
}

export async function fetchOpenIssues(repoId: string): Promise<void> {
  const current = openIssuesByRepo.get(repoId);
  if (current?.status === "loading") return;
  setEntry(repoId, RequestState.loading<Issue[]>());
  try {
    const { data, error } = await api.api.repos({ id: repoId }).issues.get();
    if (error) {
      const value = error.value as { error?: string } | undefined;
      setEntry(
        repoId,
        RequestState.error<Issue[]>(value?.error ?? `Failed to load issues (HTTP ${error.status})`),
      );
      return;
    }
    setEntry(repoId, RequestState.ok<Issue[]>(data as Issue[]));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load issues";
    setEntry(repoId, RequestState.error<Issue[]>(message));
  }
}

export function reset(): void {
  openIssuesByRepo = new Map();
}
