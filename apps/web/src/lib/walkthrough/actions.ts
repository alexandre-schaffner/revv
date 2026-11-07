// The user's walkthrough verbs. Each asks the server over REST and seeds the
// entry so the button reacts at once; the run itself reports back through
// `lifecycle:*` events on the global SSE bus.

import type { WalkthroughMode } from "@revv/shared";
import { api } from "$lib/api/client";
import { ApiError, call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import { startingEntry } from "./reducer";
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
} from "./store.svelte";
import { wtTrace } from "./trace";

type GenerationMode = "full" | "incremental";

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
    e.streamEndReason = null;
  });
}

/**
 * Ask the server to run a walkthrough of the PR's head. Idempotent server-side:
 * a job already running for the head answers with its id — unless `fresh`
 * asks it to start over. Resolves with the
 * new walkthrough's id, or null after recording the failure on the entry.
 */
async function requestStart(
  prId: string,
  mode: WalkthroughMode,
  generationMode: GenerationMode,
  fresh = false,
): Promise<string | null> {
  try {
    const { walkthroughId } = await call(
      api.api.reviews({ id: prId }).walkthrough.start.post({ mode, generationMode, fresh }),
      "Failed to start walkthrough",
    );
    return walkthroughId;
  } catch (e) {
    wtTrace("lifecycle", `start prId=${prId} error=${thrownMessage(e)}`);
    failStart(prId, e instanceof ApiError ? e.message : "Failed to start walkthrough");
    return null;
  }
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
 * Stop the run. The entry leaves its streaming state at once; the server then
 * reports `lifecycle:error` with reason `cancelled`.
 */
export function abort(prId: string): void {
  const mode = getSelectedMode(prId);
  updateEntry(prId, (e) => {
    e.isStreaming = false;
    e.streamError = null;
  });
  // A hung start/regenerate request must not keep the buttons disabled.
  clearPendingAction(prId);
  // If this is lost the agent runs on in the background; the next
  // regenerate or pull supersedes it.
  void api.api
    .reviews({ id: prId })
    .walkthrough.abort.post({ mode })
    .catch(() => undefined);
}

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
  // `fresh`: the server stops and supersedes every review of the PR first.
  const walkthroughId = await requestStart(prId, mode, generationMode, true);
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
      streamEndReason: null,
      superseded: false,
      historical: false,
      liveGeneration: true,
      phase: "connecting",
      phaseMessage: "Resuming walkthrough...",
      streamStartedAt: Date.now(),
    });
    const failResume = (message: string): void =>
      updateEntry(prId, (e) => {
        e.isStreaming = false;
        e.liveGeneration = false;
        e.streamError = message;
        e.streamEndReason = null;
      });
    let walkthroughId: string;
    try {
      ({ walkthroughId } = await call(
        api.api.reviews({ id: prId }).walkthrough.resume.post({ mode }),
        "Failed to resume walkthrough",
      ));
    } catch (err) {
      if (!(err instanceof ApiError)) {
        failResume(`Failed to resume walkthrough: ${thrownMessage(err)}`);
      } else if (err.code === "NOT_FOUND") {
        // Nothing to resume: review the head afresh.
        await runRegenerate(prId, mode, "incremental");
      } else {
        failResume(err.message);
      }
      return;
    }
    updateEntry(prId, (e) => {
      e.walkthroughId = walkthroughId;
    });
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
  // A refusal or a network failure is ignored: the next regenerate supersedes it anyway.
  await call(api.api.reviews({ id: prId }).walkthrough.supersede.post(), "Supersede failed").catch(
    () => {},
  );
}
