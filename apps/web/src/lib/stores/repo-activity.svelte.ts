import type { RepoActivity, RepoPrFlow } from "@revv/shared";
import { api } from "$lib/api/client";
import { RequestState } from "$lib/stores/_types";
import { createResource } from "./resource";

export type ReadyRepoActivity = Extract<RepoActivity, { status: "ready" }>;

export interface RepoActivityData {
  commits: ReadyRepoActivity | null;
  commitsPending: boolean;
  flow: RepoPrFlow | null;
}

/**
 * GitHub answers its commit statistics with 202 while it computes them; the
 * server keeps asking and announces the outcome (`repo-activity:settled`), so
 * a computing answer waits for that. The PR flow arrives with the first
 * answer and stays up.
 */
const activity = createResource<void, Omit<RepoActivityData, "commitsPending">>({
  freshForMs: Number.POSITIVE_INFINITY,
  waitForSignalMs: 3 * 60_000,
  keepDataOnError: true,
  fetch: async (repoId) => {
    const res = await api.api
      .repos({ id: repoId })
      .activity.get()
      .catch(() => null);
    if (!res) return { status: "error", error: "Couldn't reach the Revv server" };
    const { data, error } = res;
    if (error || !data || !("commits" in data)) {
      return { status: "error", error: "Couldn't load activity from GitHub" };
    }
    const commits = data.commits.status === "ready" ? data.commits : null;
    return commits
      ? { status: "ok", data: { commits, flow: data.flow } }
      : { status: "pending", data: { commits: null, flow: data.flow } };
  },
});

export function getRepoActivity(repoId: string): RequestState<RepoActivityData> {
  const { request, loading } = activity.entry(repoId);
  if (request.status !== "ok") return request;
  return RequestState.ok({ ...request.data, commitsPending: loading && !request.data.commits });
}

export async function loadRepoActivity(repoId: string): Promise<void> {
  await activity.load(repoId, undefined);
}

/**
 * The server stopped waiting on GitHub. Ready: re-read, which also brings in
 * code churn that arrived after the heatmap. Not ready: stop waiting.
 */
export function onRepoActivitySettled(data: { repoId: string; ready: boolean }): void {
  if (activity.entry(data.repoId).request.status === "idle") return;
  if (data.ready) void activity.refresh(data.repoId, undefined);
  else activity.giveUp(data.repoId);
}

/** A `repo-activity:settled` sent while the stream was down reached no one: ask again. */
export function onEventsReconnected(): void {
  for (const repoId of activity.waitingKeys()) void activity.refresh(repoId, undefined);
}

export function reset(): void {
  activity.reset();
}
