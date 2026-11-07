import type { ChatSessionContext } from "@revv/shared";
import { untrack } from "svelte";
import { createResource } from "$lib/stores/resource";
import { getSettings } from "$lib/stores/settings.svelte";
import { fetchAvailableAgents, fetchSessionContext } from "./api";

// A warm read acquires the worktree and starts the agent so slash commands
// exist before the first message. It is heavier than a plain read, so it runs
// once per PR, on the first composer focus; a failed warm stays retryable.
const warmed = new Set<string>();

const contexts = createResource<{ readonly warm: boolean }, ChatSessionContext>({
  freshForMs: Number.POSITIVE_INFINITY,
  keepDataOnError: true,
  fetch: async (prId, { warm }) => {
    const context = await fetchSessionContext(prId, { warm });
    if (warm) warmed.add(prId);
    return { status: "ok", data: context };
  },
});

const planModes = createResource<null, boolean>({
  freshForMs: Number.POSITIVE_INFINITY,
  fetch: async () => ({ status: "ok", data: (await fetchAvailableAgents()).planAvailable }),
});

function planModeKey(): string {
  return getSettings().aiAgent;
}

export function getChatSessionContext(prId: string): ChatSessionContext | null {
  return contexts.data(prId);
}

export function loadChatSessionContext(prId: string): void {
  void contexts.load(prId, { warm: false });
}

/**
 * Read the context again. The first turn opens the agent session, so its slash
 * commands and full repo file list exist only once that turn has ended.
 */
export function refreshChatSessionContext(prId: string): void {
  void contexts.refresh(prId, { warm: false });
}

export function warmChatSessionContext(prId: string): void {
  if (warmed.has(prId)) return;
  if (contexts.entry(prId).loading && contexts.argOf(prId)?.warm) return;
  void contexts.refresh(prId, { warm: true });
}

export function getChatMentionPaths(prId: string, changedPaths: readonly string[]): string[] {
  const changed = new Set(changedPaths);
  const repo = contexts.data(prId)?.repoFiles ?? [];
  return [...changedPaths, ...repo.filter((path) => !changed.has(path))];
}

export function isPlanModeAvailable(): boolean {
  return planModes.data(planModeKey()) ?? false;
}

/** Probe the selected agent once. Tracks only the agent setting. */
export function loadPlanModeAvailability(): void {
  const key = planModeKey();
  untrack(() => void planModes.load(key, null));
}

export function reset(): void {
  contexts.reset();
  planModes.reset();
  warmed.clear();
}
