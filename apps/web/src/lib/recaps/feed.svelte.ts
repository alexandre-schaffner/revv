import type {
  ProjectRecap,
  ProjectRecapStatus,
  ProjectRecapSummary,
  RecapPeriod,
} from "@revv/shared";
import { recapScopeCovers } from "@revv/shared";
import { api } from "$lib/api/client";
import { monthGridRange } from "$lib/recaps/period-window";
import { RequestState, type RequestState as State } from "$lib/stores/_types";
import { getUser } from "$lib/stores/auth.svelte";
import { getRepositories } from "$lib/stores/repos.svelte";
import { getSettings } from "$lib/stores/settings.svelte";

export interface RecapSelection {
  repoId?: string;
  org?: string;
  team?: string;
}
interface Feed {
  recaps: readonly ProjectRecapSummary[];
  nextCursor: string | null;
  label: string;
}
let entries = $state(new Map<string, State<Feed>>());
let epoch = 0;
const revisions = new Map<string, number>();
const selections = new Map<string, { selection: RecapSelection; period: RecapPeriod }>();

export function recapFeedKey(selection: RecapSelection, period: RecapPeriod): string {
  return JSON.stringify([
    getUser()?.email,
    getUser()?.githubLogin,
    getSettings()?.githubHost,
    selection.repoId,
    selection.org,
    selection.team,
    period,
  ]);
}
function setEntry(key: string, value: State<Feed>): void {
  entries.set(key, value);
  entries = new Map(entries);
}
export function getRecapFeed(key: string): State<Feed> {
  const request = selections.get(key);
  const own = entries.get(key);
  if (!request || (!request.selection.repoId && !request.selection.team))
    return own ?? RequestState.idle();
  const canonical = entries.get(recapFeedKey({}, request.period));
  if (canonical?.status !== "ok" || canonical.data.recaps.length === 0)
    return own ?? canonical ?? RequestState.idle();
  const merged = [
    ...(own?.status === "ok" ? own.data.recaps : []),
    ...canonical.data.recaps.filter((recap) =>
      recapScopeCovers(recap.sourceScope, request.selection),
    ),
  ];
  return RequestState.ok({
    ...canonical.data,
    recaps: [...new Map(merged.map((r) => [r.id, r])).values()].filter(
      (recap) =>
        recap.sourceScope?.kind !== "all" || recapScopeCovers(recap.sourceScope, request.selection),
    ),
  });
}

export async function fetchRecapFeed(
  selection: RecapSelection,
  period: RecapPeriod,
  cursor?: string,
  recapId?: string,
  range?: { from: string; to: string },
): Promise<boolean> {
  const generation = epoch;
  const key = recapFeedKey(selection, period);
  selections.set(key, { selection, period });
  if (selection.repoId || selection.team) {
    const canonicalKey = recapFeedKey({}, period);
    if (entries.get(canonicalKey)?.status !== "ok") await fetchCanonical(period);
    const canonical = entries.get(canonicalKey);
    if (
      canonical?.status === "ok" &&
      !range &&
      !cursor &&
      canonical.data.recaps.length > 0 &&
      canonical.data.recaps.every((recap) => recapScopeCovers(recap.sourceScope, selection)) &&
      (!recapId || canonical.data.recaps.some((recap) => recap.id === recapId))
    ) {
      if (generation !== epoch || key !== recapFeedKey(selection, period)) return false;
      const own = entries.get(key);
      setEntry(
        key,
        RequestState.ok({
          ...canonical.data,
          recaps: [
            ...new Map(
              [...(own?.status === "ok" ? own.data.recaps : []), ...canonical.data.recaps].map(
                (recap) => [recap.id, recap],
              ),
            ).values(),
          ],
        }),
      );
      return true;
    }
  }
  const requestKey = range ? `${key}:${range.from}` : key;
  const revision = (revisions.get(requestKey) ?? 0) + 1;
  revisions.set(requestKey, revision);
  const previous = entries.get(key);
  if (!cursor && !range && previous?.status !== "ok") setEntry(key, RequestState.loading());
  try {
    const { data, error } = await api.api["recap-feed"].get({
      query: {
        ...selection,
        period,
        ...(cursor ? { cursor } : {}),
        ...(recapId ? { recapId } : {}),
        ...range,
      },
    });
    if (error || !data || !("recaps" in data))
      throw new Error("Could not load recaps for this scope.");
    if (
      generation !== epoch ||
      revisions.get(requestKey) !== revision ||
      key !== recapFeedKey(selection, period)
    )
      return false;
    const normalized = data.recaps.map((r) => ({
      ...r,
      periodStart: new Date(r.periodStart).toISOString(),
      periodEnd: new Date(r.periodEnd).toISOString(),
      generatedAt: new Date(r.generatedAt).toISOString(),
      completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    }));
    const current = entries.get(key);
    const all = current?.status === "ok" ? [...current.data.recaps, ...normalized] : normalized;
    const recaps = [...new Map(all.map((r) => [r.id, r])).values()];
    setEntry(
      key,
      RequestState.ok({
        recaps,
        nextCursor:
          range && current?.status === "ok"
            ? current.data.nextCursor
            : data.nextCursor
              ? new Date(data.nextCursor).toISOString()
              : null,
        label: data.label,
      }),
    );
    return true;
  } catch (e) {
    if (generation === epoch && !range && revisions.get(requestKey) === revision)
      setEntry(key, RequestState.error(e instanceof Error ? e.message : "Could not load recaps."));
    return false;
  }
}

const canonicalRequests = new Map<string, Promise<boolean>>();
function fetchCanonical(
  period: RecapPeriod,
  range?: { from: string; to: string },
): Promise<boolean> {
  const key = `${recapFeedKey({}, period)}:${range?.from ?? "latest"}`;
  const existing = canonicalRequests.get(key);
  if (existing) return existing;
  const request = fetchRecapFeed({}, period, undefined, undefined, range).finally(() => {
    if (canonicalRequests.get(key) === request) canonicalRequests.delete(key);
  });
  canonicalRequests.set(key, request);
  return request;
}

export async function generateScopeRecap(
  selection: RecapSelection,
  period: RecapPeriod,
  periodStart?: string,
): Promise<string> {
  const { data, error } = await api.api["recap-feed"].generate.post({
    ...selection,
    period,
    ...(periodStart ? { periodStart } : {}),
  });
  if (error || !data || !("recapId" in data))
    throw new Error("Could not start this recap. Check the selected scope and try again.");
  // An account recap is reusable in every view; narrow generations keep
  // their own legacy-compatible history and must not enter the all feed.
  if (!selection.repoId && !selection.team)
    await fetchRecapFeed({}, period, undefined, data.recapId);
  return data.recapId;
}

/** Full-state SSE writes update only matching, already-loaded account/scope feeds. */
export function onRecapFeedAdded(data: { recap: ProjectRecap }): void {
  const recap = data.recap;
  if (
    !getRepositories().some((repo) =>
      recap.sourceScope
        ? recap.sourceScope.repositoryIds.includes(repo.id)
        : repo.id === recap.repositoryId,
    )
  )
    return;
  for (const [key, request] of selections) {
    if (key !== recapFeedKey(request.selection, request.period) || request.period !== recap.period)
      continue;
    const { repoId, org, team } = request.selection;
    const scope = recap.sourceScope;
    const matches =
      (scope?.kind === "all" && recapScopeCovers(scope, request.selection)) ||
      (repoId
        ? !scope && recap.repositoryId === repoId
        : team
          ? scope?.kind === "team" &&
            scope.org?.toLowerCase() === org?.toLowerCase() &&
            scope.teamSlug === team.toLowerCase()
          : false);
    const current = entries.get(key);
    if (!matches || current?.status !== "ok") continue;
    const summary: ProjectRecapSummary = {
      id: recap.id,
      repositoryId: recap.repositoryId,
      sourceScope: scope ?? null,
      period: recap.period,
      periodStart: recap.periodStart,
      periodEnd: recap.periodEnd,
      status: recap.status,
      generatedAt: recap.generatedAt,
      completedAt: recap.completedAt,
      sourcePrCount: recap.sourcePrIds.length,
      summaryStats: recap.summaryStats,
      errorMessage: recap.errorMessage,
    };
    const recaps = [summary, ...current.data.recaps.filter((r) => r.id !== recap.id)];
    setEntry(key, RequestState.ok({ ...current.data, recaps }));
  }
}
export function onRecapFeedStatusChanged(data: {
  recapId: string;
  status: ProjectRecapStatus;
  completedAt?: string | null;
  errorMessage?: string | null;
}): void {
  for (const [key, current] of entries) {
    if (current.status !== "ok") continue;
    const recaps = current.data.recaps.map((r) =>
      r.id === data.recapId
        ? {
            ...r,
            status: data.status,
            ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
            ...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {}),
          }
        : r,
    );
    setEntry(key, RequestState.ok({ ...current.data, recaps }));
  }
}
async function refreshRecapFeeds(): Promise<void> {
  await Promise.all(
    [...selections]
      .filter(([key, request]) => key === recapFeedKey(request.selection, request.period))
      .map(([, request]) => fetchRecapFeed(request.selection, request.period)),
  );
}

export function onEventsReconnected(): void {
  void refreshRecapFeeds();
}

const loadedMonths = new Set<string>();
let pendingMonths = $state(new Set<string>());
export function getRecapFeedMonthPending(key: string, month: string): boolean {
  return pendingMonths.has(`${key}:${month}`);
}
export async function fetchRecapFeedMonth(
  selection: RecapSelection,
  period: RecapPeriod,
  month: string,
): Promise<void> {
  const generation = epoch;
  const key = `${recapFeedKey(selection, period)}:${month}`;
  if (loadedMonths.has(key) || pendingMonths.has(key)) return;
  pendingMonths = new Set(pendingMonths).add(key);
  try {
    const loaded = await fetchRecapFeed(
      selection,
      period,
      undefined,
      undefined,
      monthGridRange(month),
    );
    if (loaded && generation === epoch) loadedMonths.add(key);
  } finally {
    if (generation === epoch) {
      const next = new Set(pendingMonths);
      next.delete(key);
      pendingMonths = next;
    }
  }
}

export function reset(): void {
  epoch += 1;
  entries = new Map();
  revisions.clear();
  selections.clear();
  canonicalRequests.clear();
  loadedMonths.clear();
  pendingMonths = new Set();
}
