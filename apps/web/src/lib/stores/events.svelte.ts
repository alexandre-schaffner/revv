// ── Global SSE event stream ─────────────────────────────────────────────────
//
// Owns the long-lived `EventSource` to `GET /api/events?token=…` for the
// authenticated session. Replaces the per-PR walkthrough SSE — walkthrough
// events now arrive on this single connection regardless of which PR the
// user is viewing.
//
// Why SSE: `EventSource` provides free reconnect with
// `Last-Event-ID`. We don't use the server-side replay (no event buffer —
// reconciliation happens via REST snapshots), but we still get automatic
// reconnect-on-disconnect and a one-directional channel that matches the
// access pattern (server pushes only).
//
// Auth: `?token=` query param. `EventSource` cannot set custom headers,
// so we mirror the pattern used by authenticated realtime routes.

import type { ServerEventMessage, SyncChange } from "@revv/shared";
import { toast } from "svelte-sonner";
import { API_BASE_URL } from "$lib/api/base-url";
import { applyUserUpdate, clearReauthRequired, setReauthRequired } from "./auth.svelte";
import { onChatQuestionResolved } from "./chat.svelte";
import { setError } from "./errors.svelte";
import {
  fetchPinnedPrs,
  fetchPrs,
  fetchRepos,
  getSelectedPrId,
  onPrArchived,
  replacePullRequests,
  setRepositories,
  updateRepoCloneStatus,
} from "./prs.svelte";
import { onRecapAdded, onRecapStatusChanged } from "./recaps.svelte";
import {
  loadSession,
  onThreadCreated,
  onThreadDeleted,
  onThreadMessage,
  onThreadMessageDeleted,
  onThreadMessageEdited,
  onThreadUpdated,
} from "./review.svelte";
import { getGithubHost } from "./settings.svelte";
import { applySynced, requestThreadSync, setPrListSyncing, setSyncError } from "./sync.svelte";
import {
  hydrateActiveWalkthroughs,
  hydrateFromCache,
  onWalkthroughEvent,
  refreshReviewRoundsForPrs,
} from "./walkthrough.svelte";

let source: EventSource | null = null;
let activeHostOverride: string | null = null;
// EventSource fires `open` on the first connect AND on every auto-reconnect;
// we use this counter to distinguish them (see the `open` handler below).
let openCount = 0;
let lastEventTime = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

const DEAD_CONNECTION_THRESHOLD_MS = 60_000;
const KEEPALIVE_CHECK_INTERVAL_MS = 30_000;
const RECONNECT_RECONCILE_DEBOUNCE_MS = 4_000;
let lastReconcileAt = 0;

function notifySyncChanges(changes: SyncChange[]): void {
  if (changes.length === 0) return;
  if (changes.length > 3) {
    toast.info(`${changes.length} pull request updates`);
    return;
  }
  for (const change of changes) {
    const description = `${change.repoFullName} #${change.prNumber}: ${change.prTitle}`;
    switch (change.kind) {
      case "review_requested":
        toast.info("Review requested", { description });
        break;
      case "pr_updated":
        toast.info("PR updated", { description });
        break;
      case "pr_closed":
        toast.info("PR closed", { description });
        break;
      case "pr_authored":
        toast.info("Your new PR", { description });
        break;
    }
  }
}

function startWatchdog(token: string): void {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (
      source &&
      source.readyState === EventSource.OPEN &&
      Date.now() - lastEventTime > DEAD_CONNECTION_THRESHOLD_MS
    ) {
      const host = activeHostOverride ?? undefined;
      source.close();
      source = null;
      connect(token, host);
    }
  }, KEEPALIVE_CHECK_INTERVAL_MS);
}

function reconcileOnReconnect(): void {
  const now = Date.now();
  if (now - lastReconcileAt < RECONNECT_RECONCILE_DEBOUNCE_MS) return;
  lastReconcileAt = now;

  void Promise.all([fetchRepos(), fetchPrs(), fetchPinnedPrs()]);
  const selectedPrId = getSelectedPrId();
  if (selectedPrId) {
    void hydrateFromCache(selectedPrId, { activate: false });
    requestThreadSync(selectedPrId);
    void loadSession(selectedPrId);
  }
}

/**
 * Re-read local state when the window comes back to the foreground.
 *
 * The server's poll fiber sleeps between cycles, so after the machine suspends
 * — or the app simply sits in the background — the first thing the user sees on
 * return is up to a full interval stale, with no event inbound to correct it.
 * These are DB-only REST reads (no GitHub traffic), so running them on every
 * focus is cheap; the same debounce as the reconnect path keeps a rapid
 * alt-tab from firing repeatedly.
 */
function reconcileOnForeground(): void {
  if (document.visibilityState !== "visible") return;
  if (!source || source.readyState === EventSource.CLOSED) return;
  const now = Date.now();
  if (now - lastReconcileAt < RECONNECT_RECONCILE_DEBOUNCE_MS) return;
  lastReconcileAt = now;
  void Promise.all([fetchRepos(), fetchPrs(), fetchPinnedPrs()]);
}

let foregroundListenersBound = false;

function bindForegroundReconcile(): void {
  if (foregroundListenersBound || typeof document === "undefined") return;
  foregroundListenersBound = true;
  document.addEventListener("visibilitychange", reconcileOnForeground);
  window.addEventListener("focus", reconcileOnForeground);
}

/**
 * Open the global SSE stream for the given bearer token. Closes any
 * existing connection first. Called from `auth.svelte.ts` on sign-in /
 * account-switch.
 *
 * `hostOverride` lets account-switch hand
 * us a specific host the local settings store is still empty for, we
 * pass it explicitly so the server binds the connection to the right
 * account on the first attempt.
 */
export function connect(token: string, hostOverride?: string): void {
  if (source) {
    disconnect();
  }
  if (hostOverride !== undefined) activeHostOverride = hostOverride;
  const host = activeHostOverride ?? getGithubHost();
  const hostParam = host ? `&host=${encodeURIComponent(host)}` : "";
  const url = `${API_BASE_URL}/api/events?token=${encodeURIComponent(token)}${hostParam}`;
  const es = new EventSource(url);
  source = es;
  openCount = 0;
  lastEventTime = Date.now();
  startWatchdog(token);
  bindForegroundReconcile();

  es.addEventListener("open", () => {
    lastEventTime = Date.now();
    openCount += 1;
    // On (re)connect: seed sidebar + lastSeenSeq cursors for any
    // in-flight walkthroughs the user wasn't watching. Best-effort —
    // failures here mean the sidebar spinner shows up late, not data loss.
    void hydrateActiveWalkthroughs();

    // On RECONNECT only, refetch the active PR's snapshot. Events broadcast
    // during the disconnect gap hit zero writers and are gone from this
    // client; hydrateFromCache merges the DB snapshot back into the entry.
    // Background PRs catch up via the component-mount hydration path.
    if (openCount > 1) {
      reconcileOnReconnect();
    }
  });

  es.addEventListener("error", () => {
    // EventSource auto-reconnects on transient failures (its built-in
    // backoff). We don't manually reconnect because that would race the
    // browser's retry. If `readyState === CLOSED` after a hard failure,
    // the next sign-in / account-switch will create a fresh source.
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

function dispatch(msg: ServerEventMessage): void {
  switch (msg.type) {
    case "walkthrough:event":
      onWalkthroughEvent(msg.data.prId, msg.data.walkthroughId, msg.data.seq, msg.data.event);
      break;
    case "prs:updated":
      replacePullRequests(msg.data);
      refreshReviewRoundsForPrs(msg.data.map((pr) => pr.id));
      break;
    case "pr:archived":
      onPrArchived(msg.data);
      break;
    case "prs:sync-started":
      setPrListSyncing(true);
      break;
    case "prs:sync-complete":
      setPrListSyncing(false);
      break;
    case "repos:updated":
      void setRepositories(msg.data);
      break;
    case "repos:clone-status":
      updateRepoCloneStatus(msg.data.repoId, msg.data.status, msg.data.error);
      break;
    case "user:updated":
      applyUserUpdate({
        image: msg.data.image,
        githubLogin: msg.data.githubLogin,
        name: msg.data.name,
        email: msg.data.email,
      });
      break;
    case "error":
      // A sync failure is a terminal outcome for that sync, and no
      // `prs:sync-complete` follows it — so release the sidebar spinner here or
      // it spins until the next successful cycle.
      if (msg.data.code === "SYNC_ERROR") setPrListSyncing(false);
      setError(msg.data);
      break;
    case "auth:reauth-required":
      setReauthRequired({ host: msg.data.host, githubLogin: msg.data.githubLogin });
      break;
    case "auth:reauth-cleared":
      clearReauthRequired();
      break;
    case "thread:created":
      onThreadCreated(msg.data.thread, msg.data.message);
      break;
    case "thread:updated":
      onThreadUpdated(msg.data.threadId, msg.data.status);
      break;
    case "thread:message":
      onThreadMessage(msg.data.threadId, msg.data.message);
      break;
    case "thread:deleted":
      onThreadDeleted(msg.data.threadId);
      break;
    case "thread:message:edited":
      onThreadMessageEdited(msg.data.threadId, msg.data.message);
      break;
    case "thread:message:deleted":
      onThreadMessageDeleted(msg.data.threadId, msg.data.messageId);
      break;
    case "threads:synced":
      applySynced(msg.data.prId, msg.data.summary, msg.data.timestamp);
      if (msg.data.prId === getSelectedPrId()) {
        void loadSession(msg.data.prId);
      }
      break;
    case "threads:sync-error":
      setSyncError(msg.data.prId, msg.data.message);
      toast.error("Comment sync failed", {
        description: msg.data.message,
        duration: 6000,
      });
      break;
    case "threads:new-reply":
      onThreadCreated(msg.data.thread, msg.data.message);
      break;
    case "prs:sync-summary":
      notifySyncChanges(msg.data);
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

export function disconnect(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
  activeHostOverride = null;
}
