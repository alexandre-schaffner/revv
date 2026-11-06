// The user's walkthrough verbs. Each asks the server over REST and seeds the
// entry so the button reacts at once; the run itself reports back through
// `lifecycle:*` events on the global SSE bus.

import type { CloneStatus, WalkthroughMode } from "@revv/shared";
import { api } from "$lib/api/client";
import { onReposCloneStatus, retryClone } from "$lib/stores/repos.svelte";
import {
  clearPendingAction,
  deleteEntry,
  followCurrentReport,
  getPendingAction,
  getSelectedMode,
  getWalkthroughEntry,
  hydrateFromCache,
  type PendingAction,
  setEntry,
  setPendingAction,
  updateEntry,
} from "$lib/stores/walkthrough.svelte";
import { startingEntry } from "$lib/stores/walkthrough-reducer";
import { wtTrace } from "$lib/utils/wt-trace";

type GenerationMode = "full" | "incremental";

/** Runs `action` holding the PR's pending slot; a second click while it's held is dropped. */
async function withPending(
  prId: string,
  action: PendingAction,
  run: () => Promise<void>,
): Promise<void> {
  if (getPendingAction(prId) !== null) return;
  setPendingAction(prId, action);
  try {
    await run();
  } finally {
    clearPendingAction(prId);
  }
}

function failStart(prId: string, message: string): void {
  updateEntry(prId, (e) => {
    e.isStreaming = false;
    e.streamError = message;
    e.streamErrorCode = null;
  });
}

/**
 * Ask the server to run a walkthrough of the PR's head. Idempotent server-side:
 * a job already running for the head answers with its id. Resolves with the
 * new walkthrough's id, or null after recording the failure on the entry.
 */
async function requestStart(
  prId: string,
  mode: WalkthroughMode,
  generationMode: GenerationMode,
): Promise<string | null> {
  try {
    const { data, error } = await api.api
      .reviews({ id: prId })
      .walkthrough.start.post({ mode, generationMode });
    if (error) {
      failStart(prId, `Failed to start walkthrough (HTTP ${error.status}).`);
      return null;
    }
    return data && "walkthroughId" in data ? data.walkthroughId : null;
  } catch (e) {
    wtTrace("lifecycle", `start prId=${prId} error=${e instanceof Error ? e.message : String(e)}`);
    failStart(prId, "Failed to start walkthrough");
    return null;
  }
}

/** Start a run without touching the entry: the page is already showing its wait. */
export async function startWalkthrough(
  prId: string,
  mode: WalkthroughMode = getSelectedMode(prId),
): Promise<void> {
  await requestStart(prId, mode, "full");
}

/**
 * The Generate button. Seeds a streaming entry right away so the bar flips to
 * Stop: the server can spend seconds resolving the diff and booting the agent
 * before `lifecycle:started` arrives.
 */
export function generateWalkthrough(
  prId: string,
  mode: WalkthroughMode = getSelectedMode(prId),
): Promise<void> {
  return withPending(prId, "start", async () => {
    followCurrentReport(prId);
    setEntry(prId, startingEntry(mode, "Starting walkthrough…"));
    await requestStart(prId, mode, "full");
  });
}

/**
 * Stop the run. The entry leaves its streaming state at once; the server's
 * interrupt then reports `lifecycle:error` with code `Cancelled`.
 */
export function abort(prId: string): void {
  const mode = getSelectedMode(prId);
  updateEntry(prId, (e) => {
    e.isStreaming = false;
    e.streamError = null;
  });
  // A hung start/regenerate request must not keep the buttons disabled.
  clearPendingAction(prId);
  stopClonePoll(prId);
  // If this is lost the agent runs on in the background; the next
  // regenerate or pull supersedes it.
  void api.api
    .reviews({ id: prId })
    .walkthrough.abort.post({ mode })
    .catch(() => undefined);
}

/** Supersede the PR's walkthrough server-side and start a new run. */
async function runRegenerate(
  prId: string,
  mode: WalkthroughMode,
  generationMode: GenerationMode,
): Promise<void> {
  deleteEntry(prId);
  followCurrentReport(prId);
  setEntry(
    prId,
    startingEntry(
      mode,
      generationMode === "incremental" ? "Reviewing new commits..." : "Regenerating...",
    ),
  );
  try {
    await api.api.reviews({ id: prId }).walkthrough.regenerate.post({ mode, generationMode });
  } catch {
    // The start below creates a fresh job regardless.
  }
  const walkthroughId = await requestStart(prId, mode, generationMode);
  if (walkthroughId) await hydrateFromCache(prId, { reportId: walkthroughId, replace: true });
}

export function regenerate(
  prId: string,
  mode: WalkthroughMode = getSelectedMode(prId),
  generationMode: GenerationMode = "incremental",
): Promise<void> {
  return withPending(prId, "regenerate", () => runRegenerate(prId, mode, generationMode));
}

export function regenerateFromScratch(
  prId: string,
  mode: WalkthroughMode = getSelectedMode(prId),
): Promise<void> {
  return regenerate(prId, mode, "full");
}

export function resume(prId: string, mode: WalkthroughMode = getSelectedMode(prId)): Promise<void> {
  return withPending(prId, "resume", async () => {
    followCurrentReport(prId);
    const entry = getWalkthroughEntry(prId) ?? startingEntry(mode, "Resuming walkthrough...");
    setEntry(prId, {
      ...entry,
      mode,
      isStreaming: true,
      doneReceived: false,
      streamError: null,
      streamErrorCode: null,
      superseded: false,
      historical: false,
      liveGeneration: true,
      cloneInProgress: false,
      cloneRepoId: null,
      phase: "connecting",
      phaseMessage: "Resuming walkthrough...",
      streamStartedAt: Date.now(),
    });
    const failResume = (message: string): void =>
      updateEntry(prId, (e) => {
        e.isStreaming = false;
        e.liveGeneration = false;
        e.streamError = message;
        e.streamErrorCode = null;
        e.streamErrorCode = null;
      });
    try {
      const { data, error } = await api.api.reviews({ id: prId }).walkthrough.resume.post({ mode });
      if (error) {
        // The route's typed errors don't list it, but a missing row answers 404.
        const status: number = error.status;
        if (status === 404) {
          // Nothing to resume: review the head afresh.
          await runRegenerate(prId, mode, "incremental");
          return;
        }
        failResume(`Failed to resume walkthrough (HTTP ${status}).`);
        return;
      }
      const walkthroughId = data && "walkthroughId" in data ? data.walkthroughId : null;
      if (walkthroughId) {
        updateEntry(prId, (e) => {
          e.walkthroughId = walkthroughId;
        });
      }
    } catch (err) {
      failResume(
        `Failed to resume walkthrough: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * A pulled commit makes the walkthrough describe an older head: mark it
 * superseded here and server-side. The user regenerates explicitly.
 */
export async function invalidateForPull(prId: string): Promise<void> {
  updateEntry(prId, (entry) => {
    entry.superseded = true;
    entry.isStreaming = false;
    entry.liveGeneration = false;
    entry.streamError = null;
  });
  try {
    await api.api.reviews({ id: prId }).walkthrough.regenerate.post({});
  } catch {
    // The next regenerate supersedes it anyway.
  }
}

// ── Waiting on a repository clone ───────────────────────────────────────────
//
// A walkthrough can't start until its repository is cloned. The SSE carries
// the clone's progress, but a missed message or a server restart (which
// resets clone state) would strand the page on "Cloning…"; the clone-status
// endpoint is authoritative for every outcome, so it's polled.

const clonePollers = new Map<string, { cancelled: boolean }>();
const CLONE_POLL_INTERVAL_MS = 2000;
const CLONE_POLL_MAX_MS = 10 * 60 * 1000;

function stillCloning(prId: string, repoId: string): boolean {
  const entry = getWalkthroughEntry(prId);
  return entry?.cloneInProgress === true && entry.cloneRepoId === repoId;
}

function failClone(prId: string, message: string): void {
  updateEntry(prId, (e) => {
    e.cloneInProgress = false;
    e.cloneRepoId = null;
    e.isStreaming = false;
    e.streamError = message;
    e.streamErrorCode = null;
  });
}

export function stopClonePoll(prId: string): void {
  const poller = clonePollers.get(prId);
  if (poller) poller.cancelled = true;
  clonePollers.delete(prId);
}

/** Start the walkthrough once the repo is cloned, or record why it can't. */
export async function startWhenCloned(
  prId: string,
  repoId: string,
  mode: WalkthroughMode = getSelectedMode(prId),
): Promise<void> {
  if (clonePollers.has(prId)) return;
  const token = { cancelled: false };
  clonePollers.set(prId, token);
  const startedAt = Date.now();
  try {
    while (!token.cancelled && stillCloning(prId, repoId)) {
      let status: CloneStatus = "cloning";
      let error: string | null = null;
      try {
        const { data } = await api.api.repos({ id: repoId })["clone-status"].get();
        if (data) {
          status = data.status;
          error = data.error ?? null;
        }
      } catch {
        // A network blip: ask again next tick.
      }
      if (token.cancelled || !stillCloning(prId, repoId)) return;

      onReposCloneStatus({ repoId, status, ...(error ? { error } : {}) });
      if (status === "ready") {
        void startWalkthrough(prId, mode);
        return;
      }
      if (status === "error") {
        failClone(prId, `Repository clone failed${error ? `: ${error}` : ""}. Retry to try again.`);
        return;
      }
      if (status === "pending") {
        failClone(prId, "Repository clone was reset. Retry to try again.");
        return;
      }
      if (Date.now() - startedAt > CLONE_POLL_MAX_MS) {
        failClone(prId, "Repository clone is taking too long. Retry to try again.");
        return;
      }
      await new Promise((r) => setTimeout(r, CLONE_POLL_INTERVAL_MS));
    }
  } finally {
    if (clonePollers.get(prId) === token) clonePollers.delete(prId);
  }
}

/** The page's escape hatch when a clone seems stuck: clone again, then keep waiting. */
export async function retryWalkthroughClone(prId: string, repoId: string): Promise<void> {
  try {
    await retryClone(repoId);
  } catch {
    // `retryClone` already put the failure on the repo and in a toast.
    return;
  }
  void startWhenCloned(prId, repoId);
}
