import type { RepoActivity, RepoActivityResponse, RepoPrFlow } from "@revv/shared";
import { api } from "$lib/api/client";
import { RequestState } from "$lib/stores/_types";

export type ReadyRepoActivity = Extract<RepoActivity, { status: "ready" }>;

export interface RepoActivityData {
  commits: ReadyRepoActivity | null;
  commitsPending: boolean;
  flow: RepoPrFlow | null;
}

const COMPUTING_RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

let activityByRepo = $state<Map<string, RequestState<RepoActivityData>>>(new Map());

function setEntry(repoId: string, value: RequestState<RepoActivityData>): void {
  const next = new Map(activityByRepo);
  next.set(repoId, value);
  activityByRepo = next;
}

export function getRepoActivity(repoId: string): RequestState<RepoActivityData> {
  return activityByRepo.get(repoId) ?? RequestState.idle();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchActivity(repoId: string): Promise<RepoActivityResponse | string> {
  try {
    const { data, error } = await api.api.repos({ id: repoId }).activity.get();
    if (error || !data || !("commits" in data)) return "Couldn't load activity from GitHub";
    return data;
  } catch {
    return "Couldn't reach the Revv server";
  }
}

export async function loadRepoActivity(repoId: string): Promise<void> {
  const current = getRepoActivity(repoId);
  if (current.status === "loading") return;
  if (current.status === "ok" && (current.data.commits || current.data.commitsPending)) return;
  if (current.status !== "ok") setEntry(repoId, RequestState.loading());

  for (let attempt = 0; ; attempt++) {
    const answer = await fetchActivity(repoId);
    if (typeof answer === "string") {
      const shown = getRepoActivity(repoId);
      setEntry(
        repoId,
        shown.status === "ok"
          ? RequestState.ok({ ...shown.data, commitsPending: false })
          : RequestState.error(answer),
      );
      return;
    }
    const ready = answer.commits.status === "ready" ? answer.commits : null;
    const delay = COMPUTING_RETRY_MS[attempt];
    setEntry(
      repoId,
      RequestState.ok({
        commits: ready,
        commitsPending: !ready && delay !== undefined,
        flow: answer.flow,
      }),
    );
    if (ready || delay === undefined) return;
    await sleep(delay);
  }
}
