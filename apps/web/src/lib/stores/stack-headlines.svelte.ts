import type { StackHeadline } from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { createResource } from "./resource";

/** Per repository, by stack number. A failed read shows no headlines and is asked again next open. */
const headlines = createResource<void, ReadonlyMap<number, StackHeadline>>({
  freshForMs: Number.POSITIVE_INFINITY,
  keepDataOnError: true,
  fetch: async (repositoryId) => {
    const data = await call(
      api.api.repos({ id: repositoryId })["stack-headlines"].get(),
      "Couldn't load stack headlines",
    );
    const map = new Map<number, StackHeadline>();
    for (const [number, headline] of Object.entries(data.headlines)) {
      map.set(Number(number), headline);
    }
    return { status: "ok", data: map };
  },
});

export function ensureStackHeadlines(repositoryId: string): void {
  void headlines.load(repositoryId, undefined);
}

export function getStackHeadline(repositoryId: string, stackNumber: number): StackHeadline | null {
  return headlines.data(repositoryId)?.get(stackNumber) ?? null;
}

function refreshLoaded(repositoryId: string): void {
  if (headlines.data(repositoryId) !== null) void headlines.refresh(repositoryId, undefined);
}

export function onStackUpdated(data: { repositoryId: string }): void {
  refreshLoaded(data.repositoryId);
}

export function onStackBriefStatusChanged(data: { repositoryId: string }): void {
  refreshLoaded(data.repositoryId);
}

/** Changes announced while the stream was down reached no one. */
export function onEventsReconnected(): void {
  headlines.refreshAll();
}

export function reset(): void {
  headlines.reset();
}
