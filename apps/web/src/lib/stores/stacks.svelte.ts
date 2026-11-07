import {
  type PrStackDetail,
  type StackLayer,
  type StackReviewScope,
  type StackReviewStarted,
  stackKey,
  type WalkthroughEventEnvelope,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { layerOf, neighbourOf } from "$lib/stacks/locate";
import { RequestState } from "./_types";
import type { NavigationDirection } from "./navigation-intent.svelte";
import { getPrById } from "./prs.svelte";
import { createResource } from "./resource";

const REFRESH_DEBOUNCE_MS = 400;

/**
 * Keyed on the stack as the PR row places it, asked through one of its PRs.
 * The answer is the stack as GitHub has it, which can briefly disagree with
 * the row until the next poll; null when GitHub says the PR is in no stack.
 */
const stacks = createResource<string, PrStackDetail | null>({
  freshForMs: 15_000,
  keepDataOnError: true,
  fetch: async (_key, prId) => {
    const { stack } = await call(api.api.prs({ id: prId }).stack.get(), "Couldn't load the stack");
    return { status: "ok", data: stack };
  },
});

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

function keyForPr(prId: string): string | null {
  const pr = getPrById(prId);
  return pr?.stack ? stackKey(pr.repositoryId, pr.stack.number) : null;
}

export function ensureStack(prId: string, stackNumber: number): Promise<void> {
  const pr = getPrById(prId);
  if (!pr) return Promise.resolve();
  return stacks.load(stackKey(pr.repositoryId, stackNumber), prId).then(() => undefined);
}

export function refreshStack(prId: string): Promise<void> {
  const key = keyForPr(prId);
  return key ? stacks.refresh(key, prId).then(() => undefined) : Promise.resolve();
}

export function getStackRequest(prId: string): RequestState<PrStackDetail | null> {
  const key = keyForPr(prId);
  return key ? stacks.entry(key).request : RequestState.idle();
}

export function getStack(prId: string): PrStackDetail | null {
  const key = keyForPr(prId);
  return key ? stacks.data(key) : null;
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
  if (stacks.argOf(key) === undefined) return;
  const pending = refreshTimers.get(key);
  if (pending) clearTimeout(pending);
  refreshTimers.set(
    key,
    setTimeout(() => {
      refreshTimers.delete(key);
      const prId = stacks.argOf(key);
      if (prId !== undefined) void stacks.refresh(key, prId);
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

/** A member's walkthrough starting or settling changes the stack's review state. */
export function onWalkthroughEvent(data: WalkthroughEventEnvelope["data"]): void {
  if (!data.event.type.startsWith("lifecycle:")) return;
  const key = keyForPr(data.prId);
  if (key) scheduleRefresh(key);
}

/** `stack:updated` and brief status changes sent while the stream was down reached no one. */
export function onEventsReconnected(): void {
  stacks.refreshAll();
}

export function reset(): void {
  stacks.reset();
  for (const timer of refreshTimers.values()) clearTimeout(timer);
  refreshTimers.clear();
}

export async function startStackReview(
  prId: string,
  scope: StackReviewScope,
): Promise<StackReviewStarted> {
  const started = await call(
    api.api.prs({ id: prId }).stack.review.post({ scope }),
    "Couldn't start the stack review",
  );
  void refreshStack(prId);
  return started;
}

/** Resolves with the brief's id. */
export async function requestStackBrief(prId: string): Promise<string | null> {
  const { briefId } = await call(
    api.api.prs({ id: prId }).stack.brief.post(),
    "Couldn't start the stack brief",
  );
  void refreshStack(prId);
  return briefId;
}

export function warmNeighbours(prId: string): void {
  void api.api
    .prs({ id: prId })
    .stack.warm.post()
    .catch(() => undefined);
}
