// Owns the long-lived `EventSource` to `GET /api/events?token=…` and routes
// each envelope, whole, to the stores that own its state. Stores filter on
// envelope fields themselves.
//
// There is no server-side replay: a client that missed events re-reads the
// DB (invariant 8). `CATCH_UP` makes that a decision per event type: each one
// names the re-reads that recover what a missed envelope carried, or why none
// is needed. A new event type doesn't compile until it says which.
//
// Auth: `?token=` query param. `EventSource` cannot set custom headers.

import {
  type ServerEventMessage,
  SSE_HEARTBEAT_EVENT,
  SSE_HEARTBEAT_INTERVAL_MS,
} from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import * as hunkScan from "$lib/hunk-scan/store.svelte";
import * as recaps from "$lib/recaps/store.svelte";
import { getToken } from "$lib/session/token.svelte";
import * as walkthroughSizing from "$lib/walkthrough/sizing.svelte";
import * as walkthrough from "$lib/walkthrough/store.svelte";
import * as auth from "./auth.svelte";
import * as conversation from "./conversation.svelte";
import * as mergeEligibility from "./merge-eligibility.svelte";
import * as prs from "./prs.svelte";
import * as repoActivity from "./repo-activity.svelte";
import * as repos from "./repos.svelte";
import { refreshAllWaiting } from "./resource";
import * as review from "./review.svelte";
import * as stackHeadlines from "./stack-headlines.svelte";
import * as stackMerge from "./stack-merge.svelte";
import * as stacks from "./stacks.svelte";
import * as sync from "./sync.svelte";

type CatchUp = () => void;
/** Why a missed envelope of this type needs no re-read. */
type NoCatchUp = `none: ${string}`;

/**
 * Every (re)connect, the first included: these read what the server is
 * working on right now, so they double as catch-up for the events they seed.
 */
const ON_OPEN: readonly CatchUp[] = [walkthrough.onEventsOpened, sync.onEventsOpened];

/**
 * Per event type, the re-reads that recover a missed envelope. After a
 * reconnect each distinct hook runs once; `refreshAllWaiting` runs first, so a
 * store's own hook can tell an ask it just restarted from one it should make.
 */
const CATCH_UP: Record<ServerEventMessage["type"], readonly CatchUp[] | NoCatchUp> = {
  "walkthrough:event": [walkthrough.onEventsReconnected, stacks.onEventsReconnected],
  "walkthrough:live": "none: live-only progress, never replayed; the next event replaces it",
  "stack:updated": [stacks.onEventsReconnected, stackHeadlines.onEventsReconnected],
  "stack-merge:progress": [stackMerge.onEventsReconnected, stacks.onEventsReconnected],
  "stack-brief:status-changed": [stacks.onEventsReconnected, stackHeadlines.onEventsReconnected],
  "hunk-scan:started": [hunkScan.onEventsReconnected],
  "hunk-scan:hunk": [hunkScan.onEventsReconnected],
  "hunk-scan:complete": [hunkScan.onEventsReconnected],
  "prs:updated": [prs.rereadLists, walkthrough.onEventsReconnected],
  "pr:archived": [prs.rereadLists],
  "pr:conversation-updated": [conversation.onEventsReconnected],
  "pr:merge-eligibility": [refreshAllWaiting],
  "diff:cached": [refreshAllWaiting],
  "repo-activity:settled": [refreshAllWaiting],
  "prs:sync-started": "none: the next poll cycle's prs:sync-complete settles the spinner",
  "prs:sync-complete": "none: the next poll cycle's prs:sync-complete settles the spinner",
  "prs:sync-failed": "none: a toast; the failed sync's spinner settles with the next cycle",
  "prs:sync-summary": "none: toasts about changes the list re-read already shows",
  "repos:updated": [repos.rereadRepos],
  "repos:clone-status": [repos.rereadRepos],
  "user:updated": [auth.onEventsReconnected],
  "auth:reauth-required": [auth.onEventsReconnected],
  "auth:reauth-cleared": [auth.onEventsReconnected],
  "thread:created": [review.onEventsReconnected],
  "thread:updated": [review.onEventsReconnected],
  "thread:message": [review.onEventsReconnected],
  "thread:deleted": [review.onEventsReconnected],
  "thread:message:edited": [review.onEventsReconnected],
  "thread:message:deleted": [review.onEventsReconnected],
  "threads:synced": [review.onEventsReconnected],
  "threads:linked": [review.onEventsReconnected],
  "threads:sync-error": [review.onEventsReconnected],
  "recap:status-changed": [recaps.onEventsReconnected],
  "recap:added": [recaps.onEventsReconnected],
};

/** A reconnect: events sent while the stream was down reached no one. */
const ON_RECONNECT: readonly CatchUp[] = [
  refreshAllWaiting,
  ...new Set(
    Object.values(CATCH_UP)
      .flatMap((entry) => (typeof entry === "string" ? [] : entry))
      .filter((hook) => hook !== refreshAllWaiting && !ON_OPEN.includes(hook)),
  ),
];

/** The window came back to the foreground while a stream exists. */
const ON_FOREGROUND: ReadonlyArray<(streamOpen: boolean) => void> = [
  sync.onWindowForeground,
  conversation.onWindowForeground,
  review.onWindowForeground,
  prs.rereadLists,
  repos.rereadRepos,
];

const DEAD_CONNECTION_THRESHOLD_MS = 4 * SSE_HEARTBEAT_INTERVAL_MS;
const KEEPALIVE_CHECK_INTERVAL_MS = 30_000;
/**
 * A focus within this long of a reconnect's catch-up, or of the last focus
 * (a rapid alt-tab), re-reads nothing. A reconnect always catches up: the
 * focus re-reads only a subset of what it recovers.
 */
const FOREGROUND_DEBOUNCE_MS = 4_000;
const RECOVER_BASE_MS = 1_000;
const RECOVER_MAX_MS = 30_000;

let source: EventSource | null = null;
// EventSource fires `open` on the first connect AND on every auto-reconnect.
let openCount = 0;
let lastEventTime = 0;
let lastReconnectAt = 0;
let lastForegroundAt = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let recoverTimer: ReturnType<typeof setTimeout> | null = null;
let recoverAttempts = 0;
let foregroundListenersBound = false;

function dispatch(msg: ServerEventMessage): void {
  switch (msg.type) {
    case "walkthrough:event":
      walkthrough.onWalkthroughEvent(msg.data);
      stacks.onWalkthroughEvent(msg.data);
      break;
    case "walkthrough:live":
      walkthrough.onWalkthroughLive(msg.data);
      break;
    case "stack:updated":
      stacks.onStackUpdated(msg.data);
      stackHeadlines.onStackUpdated(msg.data);
      break;
    case "stack-merge:progress":
      stackMerge.onStackMergeProgress(msg.data);
      break;
    case "stack-brief:status-changed":
      stacks.onStackBriefStatusChanged(msg.data);
      stackHeadlines.onStackBriefStatusChanged(msg.data);
      break;
    case "hunk-scan:started":
      hunkScan.onHunkScanStarted(msg.data);
      break;
    case "hunk-scan:hunk":
      hunkScan.onHunkScanHunk(msg.data);
      break;
    case "hunk-scan:complete":
      hunkScan.onHunkScanComplete(msg.data);
      break;
    case "prs:updated":
      prs.onPrsUpdated(msg.data);
      walkthrough.onPrsUpdated(msg.data.prs);
      break;
    case "pr:archived":
      prs.onPrArchived(msg.data);
      break;
    case "pr:conversation-updated":
      conversation.onPrConversationUpdated(msg.data);
      break;
    case "pr:merge-eligibility":
      mergeEligibility.onPrMergeEligibility(msg.data);
      break;
    case "diff:cached":
      walkthroughSizing.onDiffCached(msg.data);
      hunkScan.onDiffCached(msg.data);
      break;
    case "repo-activity:settled":
      repoActivity.onRepoActivitySettled(msg.data);
      break;
    case "prs:sync-started":
      sync.onPrsSyncStarted();
      break;
    case "prs:sync-complete":
      sync.onPrsSyncComplete();
      break;
    case "prs:sync-failed":
      sync.onPrsSyncFailed(msg.data);
      break;
    case "prs:sync-summary":
      sync.onPrsSyncSummary(msg.data);
      break;
    case "repos:updated":
      repos.onReposUpdated(msg.data);
      break;
    case "repos:clone-status":
      repos.onReposCloneStatus(msg.data);
      break;
    case "user:updated":
      auth.onUserUpdated(msg.data);
      break;
    case "auth:reauth-required":
      auth.onAuthReauthRequired(msg.data);
      break;
    case "auth:reauth-cleared":
      auth.onAuthReauthCleared();
      break;
    case "thread:created":
      review.onThreadCreated(msg.data);
      break;
    case "thread:updated":
      review.onThreadUpdated(msg.data);
      break;
    case "thread:message":
      review.onThreadMessage(msg.data);
      break;
    case "thread:deleted":
      review.onThreadDeleted(msg.data);
      break;
    case "thread:message:edited":
      review.onThreadMessageEdited(msg.data);
      break;
    case "thread:message:deleted":
      review.onThreadMessageDeleted(msg.data);
      break;
    case "threads:synced":
      sync.onThreadsSynced(msg.data);
      review.onThreadsSynced(msg.data);
      break;
    case "threads:linked":
      review.onThreadsLinked(msg.data);
      break;
    case "threads:sync-error":
      sync.onThreadsSyncError(msg.data);
      break;
    case "recap:status-changed":
      recaps.onRecapStatusChanged(msg.data);
      break;
    case "recap:added":
      recaps.onRecapAdded(msg.data);
      break;
    default: {
      const _exhaustive: never = msg;
      console.warn("[events] unhandled message", (_exhaustive as { type: string }).type);
    }
  }
}

function onStreamOpen(): void {
  lastEventTime = Date.now();
  recoverAttempts = 0;
  openCount += 1;
  for (const hook of ON_OPEN) hook();
  if (openCount === 1) return;
  lastReconnectAt = Date.now();
  for (const hook of ON_RECONNECT) hook();
}

function onWindowForeground(): void {
  if (document.visibilityState !== "visible" || !source) return;
  if (source.readyState === EventSource.CLOSED) {
    recoverAttempts = 0;
    reopen();
    return;
  }
  const now = Date.now();
  if (now - Math.max(lastReconnectAt, lastForegroundAt) < FOREGROUND_DEBOUNCE_MS) return;
  lastForegroundAt = now;
  const streamOpen = source.readyState === EventSource.OPEN;
  for (const hook of ON_FOREGROUND) hook(streamOpen);
}

function bindForegroundListeners(): void {
  if (foregroundListenersBound || typeof document === "undefined") return;
  foregroundListenersBound = true;
  document.addEventListener("visibilitychange", onWindowForeground);
  window.addEventListener("focus", onWindowForeground);
}

function clearRecoverTimer(): void {
  if (recoverTimer) clearTimeout(recoverTimer);
  recoverTimer = null;
}

/** Replace the stream; `openCount` carries over, so its `open` counts as a reconnect. */
function reopen(): void {
  clearRecoverTimer();
  source?.close();
  source = null;
  open();
}

/**
 * A hard failure (401/5xx on a reconnect) leaves the `EventSource` CLOSED
 * and the browser stops retrying; reopen it with backoff.
 */
function scheduleRecover(): void {
  if (recoverTimer) return;
  const delay = Math.min(RECOVER_BASE_MS * 2 ** recoverAttempts, RECOVER_MAX_MS);
  recoverAttempts += 1;
  recoverTimer = setTimeout(reopen, delay);
}

function startWatchdog(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!source) return;
    if (source.readyState === EventSource.CLOSED) {
      scheduleRecover();
    } else if (
      source.readyState === EventSource.OPEN &&
      Date.now() - lastEventTime > DEAD_CONNECTION_THRESHOLD_MS
    ) {
      reopen();
    }
  }, KEEPALIVE_CHECK_INTERVAL_MS);
}

function open(): void {
  const token = getToken();
  if (!token) return;
  // One stream carries the pushes of every account of the signed-in user.
  const es = new EventSource(`${API_BASE_URL}/api/events?token=${encodeURIComponent(token)}`);
  source = es;
  lastEventTime = Date.now();

  es.addEventListener("open", () => {
    if (source === es) onStreamOpen();
  });
  es.addEventListener("error", () => {
    // The browser retries transient failures itself; only a source it gave
    // up on needs us.
    if (source === es && es.readyState === EventSource.CLOSED) scheduleRecover();
  });
  es.addEventListener(SSE_HEARTBEAT_EVENT, () => {
    lastEventTime = Date.now();
  });
  es.addEventListener("message", (event: MessageEvent<string>) => {
    lastEventTime = Date.now();
    let msg: ServerEventMessage;
    try {
      msg = JSON.parse(event.data) as ServerEventMessage;
    } catch (err) {
      console.warn("[events] malformed message:", err);
      return;
    }
    dispatch(msg);
  });
}

export function connect(): void {
  disconnect();
  openCount = 0;
  recoverAttempts = 0;
  startWatchdog();
  bindForegroundListeners();
  open();
}

export function disconnect(): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
  clearRecoverTimer();
  source?.close();
  source = null;
}
