// ── Global SSE event stream ─────────────────────────────────────────────────
//
// Owns the long-lived `EventSource` to `GET /api/events?token=…` and routes
// each envelope, whole, to the stores that own its state. Stores filter on
// envelope fields themselves and own their reconcile after a reconnect or a
// return to the window; this module only knows who listens to what.
//
// There is no server-side replay: a client that missed events re-reads the
// DB (invariant 8), through the hooks below.
//
// Auth: `?token=` query param. `EventSource` cannot set custom headers.

import type { ServerEventMessage } from "@revv/shared";
import { API_BASE_URL } from "$lib/api/base-url";
import { getToken } from "$lib/session/token.svelte";
import * as auth from "./auth.svelte";
import { onChatQuestionResolved } from "./chat.svelte";
import { onPrConversationUpdated } from "./conversation.svelte";
import { setError } from "./errors.svelte";
import * as hunkScan from "./hunk-scan.svelte";
import * as prs from "./prs.svelte";
import { onRecapAdded, onRecapStatusChanged } from "./recaps.svelte";
import * as review from "./review.svelte";
import { getGithubHost } from "./settings.svelte";
import * as stackHeadlines from "./stack-headlines.svelte";
import { onStackMergeProgress } from "./stack-merge.svelte";
import * as stacks from "./stacks.svelte";
import * as sync from "./sync.svelte";
import * as walkthrough from "./walkthrough.svelte";

/** Every (re)connect, the first included. */
const ON_OPEN: ReadonlyArray<() => void> = [walkthrough.onEventsOpened, sync.onEventsOpened];

/** A reconnect: events sent while the stream was down reached no one. */
const ON_RECONNECT: ReadonlyArray<() => void> = [
  prs.onEventsReconnected,
  walkthrough.onEventsReconnected,
  hunkScan.onEventsReconnected,
  review.onEventsReconnected,
];

/** The window came back to the foreground while a stream exists. */
const ON_FOREGROUND: ReadonlyArray<(streamOpen: boolean) => void> = [
  sync.onWindowForeground,
  review.onWindowForeground,
  prs.onWindowForeground,
];

const DEAD_CONNECTION_THRESHOLD_MS = 60_000;
const KEEPALIVE_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_RECONCILE_DEBOUNCE_MS = 4_000;
const RECOVER_BASE_MS = 1_000;
const RECOVER_MAX_MS = 30_000;

let source: EventSource | null = null;
let activeHostOverride: string | null = null;
// EventSource fires `open` on the first connect AND on every auto-reconnect.
let openCount = 0;
let lastEventTime = 0;
let lastReconnectReconcileAt = 0;
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
    case "stack:updated":
      stacks.onStackUpdated(msg.data);
      stackHeadlines.onStackUpdated(msg.data);
      break;
    case "stack-merge:progress":
      onStackMergeProgress(msg.data);
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
      walkthrough.onPrsUpdated(msg.data);
      break;
    case "pr:archived":
      prs.onPrArchived(msg.data);
      break;
    case "pr:conversation-updated":
      onPrConversationUpdated(msg.data);
      break;
    case "prs:sync-started":
      sync.onPrsSyncStarted();
      break;
    case "prs:sync-complete":
      sync.onPrsSyncComplete();
      break;
    case "prs:sync-summary":
      sync.onPrsSyncSummary(msg.data);
      break;
    case "repos:updated":
      prs.onReposUpdated(msg.data);
      break;
    case "repos:clone-status":
      prs.onReposCloneStatus(msg.data);
      break;
    case "user:updated":
      auth.onUserUpdated(msg.data);
      break;
    case "error":
      sync.onError(msg.data);
      setError(msg.data);
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
    case "threads:sync-error":
      sync.onThreadsSyncError(msg.data);
      break;
    case "threads:new-reply":
      review.onThreadsNewReply(msg.data);
      break;
    case "chat:question-resolved":
      onChatQuestionResolved(
        msg.data.prId,
        msg.data.questionId,
        msg.data.status,
        msg.data.answers,
        msg.data.customAnswers,
        msg.data.supersededPlanId,
      );
      break;
    case "recap:status-changed":
      onRecapStatusChanged(msg.data);
      break;
    case "recap:added":
      onRecapAdded(msg.data);
      break;
    case "new-pr-session:created":
    case "new-pr-session:message-appended":
    case "new-pr-session:agent-turn-started":
    case "new-pr-session:agent-turn-ended":
    case "new-pr-session:commit-recorded":
    case "new-pr-session:metadata-updated":
    case "new-pr-session:worktree-changed":
    case "new-pr-session:synced":
    case "new-pr-session:sync-conflicted":
    case "new-pr-session:status-changed":
    case "new-pr-session:pr-opened":
    case "new-pr-session:updated":
      if (import.meta.env.DEV) {
        console.debug("[events] new-pr-session envelope received", msg.type, msg.data);
      }
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
  const now = Date.now();
  if (now - lastReconnectReconcileAt < RECONNECT_RECONCILE_DEBOUNCE_MS) return;
  lastReconnectReconcileAt = now;
  for (const hook of ON_RECONNECT) hook();
}

function onWindowForeground(): void {
  if (document.visibilityState !== "visible" || !source) return;
  if (source.readyState === EventSource.CLOSED) {
    recoverAttempts = 0;
    reopen();
    return;
  }
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
  const host = activeHostOverride ?? getGithubHost();
  const hostParam = host ? `&host=${encodeURIComponent(host)}` : "";
  const es = new EventSource(
    `${API_BASE_URL}/api/events?token=${encodeURIComponent(token)}${hostParam}`,
  );
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
  es.addEventListener("heartbeat", () => {
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

/**
 * Open the stream for the current session token, closing any open one.
 * `hostOverride` binds the stream to an account whose host the settings
 * store doesn't hold yet (an account switch); it sticks across reconnects.
 */
export function connect(hostOverride?: string): void {
  disconnect();
  if (hostOverride !== undefined) activeHostOverride = hostOverride;
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
  activeHostOverride = null;
}
