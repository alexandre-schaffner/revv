import {
  type PrStackDetail,
  type StackLayer,
  type StackReviewScope,
  type StackReviewStarted,
  stackKey,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import { layerOf, neighbourOf } from "$lib/stacks/locate";
import { RequestState } from "./_types";
import type { NavigationDirection } from "./navigation-intent.svelte";
import { getPrById } from "./prs.svelte";
import { singleFlight } from "./single-flight";

interface StackEntry {
  readonly request: RequestState<PrStackDetail>;
  readonly viaPrId: string;
  readonly loadedAt: number;
}

const FRESH_FOR_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 400;

let entries = $state(new Map<string, StackEntry>());

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function setEntry(key: string, entry: StackEntry): void {
  entries.set(key, entry);
  entries = new Map(entries);
}

function deleteEntry(key: string): void {
  entries.delete(key);
  entries = new Map(entries);
}

function releasePlaceholderFiledElsewhere(pollKey: string, githubKey: string): void {
  if (githubKey !== pollKey && entries.get(pollKey)?.request.status !== "ok") {
    deleteEntry(pollKey);
  }
}

function keyForPr(prId: string): string | null {
  const pr = getPrById(prId);
  return pr?.stack ? stackKey(pr.repositoryId, pr.stack.number) : null;
}

async function fetchStack(key: string, prId: string): Promise<void> {
  const existing = entries.get(key);
  if (existing?.request.status !== "ok") {
    setEntry(key, { request: RequestState.loading(), viaPrId: prId, loadedAt: 0 });
  }
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.get();
    if (error || !data || !("stack" in data)) {
      const message = error
        ? apiErrorMessage(error, "Couldn't load the stack")
        : "Unexpected response";
      const current = entries.get(key);
      if (current?.request.status !== "ok") {
        setEntry(key, { request: RequestState.error(message), viaPrId: prId, loadedAt: 0 });
      }
      return;
    }
    const stack = data.stack ? (plain(data.stack) as PrStackDetail) : null;
    if (!stack) {
      deleteEntry(key);
      return;
    }
    const githubKey = stackKey(stack.repositoryId, stack.number);
    setEntry(githubKey, { request: RequestState.ok(stack), viaPrId: prId, loadedAt: Date.now() });
    releasePlaceholderFiledElsewhere(key, githubKey);
  } catch (e) {
    const current = entries.get(key);
    if (current?.request.status !== "ok") {
      setEntry(key, {
        request: RequestState.error(thrownMessage(e)),
        viaPrId: prId,
        loadedAt: 0,
      });
    }
  }
}

const reads = singleFlight(fetchStack);

/** Read the stack `prId` is filed under as `stackNumber`, unless a fresh read is on hand. */
export function ensureStack(prId: string, stackNumber: number): Promise<void> {
  const pr = getPrById(prId);
  if (!pr) return Promise.resolve();
  const key = stackKey(pr.repositoryId, stackNumber);
  const entry = entries.get(key);
  if (entry?.request.status === "ok" && Date.now() - entry.loadedAt < FRESH_FOR_MS) {
    return Promise.resolve();
  }
  return reads.run(key, prId);
}

export function refreshStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  return key ? reads.runFromNow(key, prId) : Promise.resolve();
}

export function getStackRequest(prId: string): RequestState<PrStackDetail> {
  const key = keyForPr(prId);
  return (key ? entries.get(key)?.request : undefined) ?? RequestState.idle();
}

export function getStack(prId: string): PrStackDetail | null {
  const request = getStackRequest(prId);
  return request.status === "ok" ? request.data : null;
}

export function getLayer(prId: string): StackLayer | null {
  const stack = getStack(prId);
  return stack ? layerOf(stack, prId, getPrById(prId)?.externalId ?? null) : null;
}

export function getNeighbour(prId: string, direction: NavigationDirection): StackLayer | null {
  const stack = getStack(prId);
  const here = getLayer(prId);
  return stack && here ? neighbourOf(stack, here, direction) : null;
}

function scheduleRefresh(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  const pending = refreshTimers.get(key);
  if (pending) clearTimeout(pending);
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      const current = entries.get(key);
      if (current) void reads.runFromNow(key, current.viaPrId);
    }, REFRESH_DEBOUNCE_MS),
  );
}

export function onStackUpdated(data: { repositoryId: string; stackNumber: number }): void {
  scheduleRefresh(stackKey(data.repositoryId, data.stackNumber));
}

export function onStackBriefStatusChanged(data: {
  repositoryId: string;
  stackNumber: number;
}): void {
  onStackUpdated(data);
}

export function onMemberWalkthroughLifecycle(prId: string): void {
  const key = keyForPr(prId);
  if (key) scheduleRefresh(key);
}

export async function startStackReview(
  prId: string,
  scope: StackReviewScope,
): Promise<StackReviewStarted | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.review.post({ scope });
    if (error || !data || !("queued" in data)) return null;
    void refreshStack(prId);
    return data;
  } catch {
    return null;
  }
}

export async function requestStackBrief(prId: string): Promise<string | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).stack.brief.post();
    if (error || !data || !("briefId" in data)) return null;
    void refreshStack(prId);
    return data.briefId;
  } catch {
    return null;
  }
}

export function warmNeighbours(prId: string): void {
  void api.api
    .prs({ id: prId })
    .stack.warm.post()
    .catch(() => undefined);
}
