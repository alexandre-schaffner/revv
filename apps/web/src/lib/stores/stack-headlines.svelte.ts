import type { StackHeadline } from "@revv/shared";
import { api } from "$lib/api/client";
import { singleFlight } from "./single-flight";

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

const reads = singleFlight<void>((repositoryId) => fetchHeadlines(repositoryId));

export function ensureStackHeadlines(repositoryId: string): void {
  if (!byRepo.has(repositoryId)) void reads.run(repositoryId);
}

export function getStackHeadline(repositoryId: string, stackNumber: number): StackHeadline | null {
  return byRepo.get(repositoryId)?.get(stackNumber) ?? null;
}

export function onStackHeadlineSignal(data: { repositoryId: string }): void {
  if (byRepo.has(data.repositoryId)) void reads.runFromNow(data.repositoryId);
}
