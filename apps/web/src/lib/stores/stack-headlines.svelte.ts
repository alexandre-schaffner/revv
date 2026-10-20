// ── Stack headlines ─────────────────────────────────────────────────────────
//
// What each stack in a repo builds, for the homepage queue. One read per repo
// (DB-only on the server, so it costs GitHub nothing); re-read when the
// server says a stack of that repo moved or got named.

import type { StackHeadline } from "@revv/shared";
import { api } from "$lib/api/client";

let byRepo = $state(new Map<string, ReadonlyMap<number, StackHeadline>>());
const inflight = new Map<string, Promise<void>>();

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
  } catch {
    // The queue falls back to "N pull requests"; nothing to surface.
  }
}

function load(repositoryId: string): Promise<void> {
  const running = inflight.get(repositoryId);
  if (running) return running;
  const promise = fetchHeadlines(repositoryId).finally(() => inflight.delete(repositoryId));
  inflight.set(repositoryId, promise);
  return promise;
}

/** Read the repo's stack headlines once; later reads come from `stack:updated`. */
export function ensureStackHeadlines(repositoryId: string): void {
  if (!byRepo.has(repositoryId)) void load(repositoryId);
}

export function getStackHeadline(repositoryId: string, stackNumber: number): StackHeadline | null {
  return byRepo.get(repositoryId)?.get(stackNumber) ?? null;
}

/** A stack of a repo the queue shows moved or got named: re-read that repo. */
export function onStackHeadlineSignal(data: { repositoryId: string }): void {
  if (byRepo.has(data.repositoryId)) void load(data.repositoryId);
}
