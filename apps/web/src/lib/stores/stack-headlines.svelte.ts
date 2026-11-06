import type { StackHeadline } from "@revv/shared";
import { api } from "$lib/api/client";
import { createResource } from "./resource";

let byRepo = $state(new Map<string, ReadonlyMap<number, StackHeadline>>());

async function fetchHeadlines(repositoryId: string): Promise<void> {
  try {
    const { data, error } = await api.api.repos({ id: repositoryId })["stack-headlines"].get();
    if (error || !data || !("headlines" in data)) return;
    const map = new Map<number, StackHeadline>();
    for (const [number, headline] of Object.entries(data.headlines)) {
      map.set(Number(number), headline);
    }
    byRepo.set(repositoryId, map);
    byRepo = new Map(byRepo);
  } catch {}
}

const reads = createResource<void, void>({
  fetch: async (repositoryId) => {
    await fetchHeadlines(repositoryId);
    return { status: "ok", data: undefined };
  },
});

export function ensureStackHeadlines(repositoryId: string): void {
  if (!byRepo.has(repositoryId)) void reads.load(repositoryId, undefined);
}

export function getStackHeadline(repositoryId: string, stackNumber: number): StackHeadline | null {
  return byRepo.get(repositoryId)?.get(stackNumber) ?? null;
}

function refreshLoaded(repositoryId: string): void {
  if (byRepo.has(repositoryId)) void reads.refresh(repositoryId, undefined);
}

export function onStackUpdated(data: { repositoryId: string }): void {
  refreshLoaded(data.repositoryId);
}

export function onStackBriefStatusChanged(data: { repositoryId: string }): void {
  refreshLoaded(data.repositoryId);
}

export function reset(): void {
  reads.reset();
  byRepo = new Map();
}
