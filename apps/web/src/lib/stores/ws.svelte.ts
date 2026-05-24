import type { SyncChange, WsServerMessage } from "@revv/shared";
import { toast } from "svelte-sonner";
import { WS_BASE_URL } from "$lib/api/base-url";
import { recordCounter, traced } from "$lib/observability";
import { applyUserUpdate } from "./auth.svelte";
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
import { applySyncError, applySynced, markThreadsSyncing, setPrListSyncing } from "./sync.svelte";
import { hydrateFromCache } from "./walkthrough.svelte";

let ws: WebSocket | null = null;
let reconnectAttempts = $state(0);
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** W2: queue multiple pending thread-sync requests instead of overwriting. */
const pendingThreadSync: Set<string> = new Set();

const MAX_RECONNECT_DELAY_MS = 30_000;

/** W1: dead-connection detection — close the socket if >60s passes without any
 * server-to-client message (ping frames don't count; they exist below the WS
 * message layer). The server pings every ~30s, so 60s of silence means the
 * TCP connection is genuinely dead (proxy/NAT timeout, OS sleep, etc.) and the
 * close handler will schedule a reconnect. */
const DEAD_CONNECTION_THRESHOLD_MS = 60_000;
const KEEPALIVE_CHECK_INTERVAL_MS = 30_000;
let lastMessageTime = 0;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/** W4: stored listener references so disconnect() can remove them explicitly. */
let wsListeners: {
  open: () => void;
  close: () => void;
  error: () => void;
  message: (event: MessageEvent) => void;
} | null = null;

function getReconnectDelay(): number {
  return Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
}

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
        // Walkthrough auto-starts server-side via PollScheduler; the
        // resulting `lifecycle:started` arrives over the global SSE bus
        // and seeds the sidebar spinner without a client-side trigger.
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

function handleMessage(msg: WsServerMessage): void {
  traced("ws.handle", { type: msg.type }, () => dispatchMessage(msg));
}

function dispatchMessage(msg: WsServerMessage): void {
  switch (msg.type) {
    case "prs:updated":
      replacePullRequests(msg.data);
      // No longer blindly refetching the archive list on every prs:updated:
      // the targeted `pr:archived` envelope below patches archive state in
      // place, and the initial archive fetch happens on app boot. Refetching
      // here would re-pull dozens of rows for every poll cycle.
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
      setError(msg.data);
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
      console.error("[ws] Thread sync error for PR", msg.data.prId, msg.data.message);
      applySyncError(msg.data.prId, msg.data.message);
      toast.error("Failed to sync comments from GitHub", {
        description: "Check your connection or try re-authenticating.",
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
    // ── New-PR session envelopes — stubs until the frontend chat
    //    surface lands. The backend isn't broadcasting these yet either,
    //    so the cases exist to keep the exhaustive-switch valid; the
    //    payloads will be routed to a new-pr-sessions store in a
    //    follow-up. Logged in DEV so test runs surface unexpected
    //    deliveries during the feature roll-out.
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
        console.debug("[ws] new-pr-session envelope received", msg.type, msg.data);
      }
      break;
    default: {
      const _exhaustive: never = msg;
      console.warn("[ws] unhandled message type", (_exhaustive as { type: string }).type);
    }
  }
}

/**
 * Active host override for the current WS session. Set by `connect(token, host)`
 * when the caller knows the right host (e.g. account-switch, where the local
 * settings store has just been reset to null and `getGithubHost()` would
 * otherwise return null — making the server fall back to the wrong account
 * for users whose only account is on a non-default GHE host). Survives
 * reconnects so the auto-reconnect path uses the same host as the original
 * connect, not whatever happens to be in the settings store at reconnect time.
 */
let activeHostOverride: string | null = null;

export function connect(token: string, hostOverride?: string): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  if (hostOverride !== undefined) activeHostOverride = hostOverride;
  const host = activeHostOverride ?? getGithubHost();
  const hostParam = host ? `&host=${encodeURIComponent(host)}` : "";
  ws = new WebSocket(`${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}${hostParam}`);

  // W4: capture listener references so disconnect() can remove them explicitly.
  const onOpen = (): void => {
    const isReconnect = reconnectAttempts > 0;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // W1: reset last-message time and start the keepalive check interval.
    lastMessageTime = Date.now();
    keepaliveTimer = setInterval(() => {
      if (
        ws &&
        ws.readyState === WebSocket.OPEN &&
        Date.now() - lastMessageTime > DEAD_CONNECTION_THRESHOLD_MS
      ) {
        // Server is ping-ponging every 30s; if we haven't received any app-level
        // message in 60s, the TCP connection is dead (proxy/NAT timeout, OS sleep).
        // Close it so the close handler fires and reconnect kicks in.
        ws.close(4000, "Dead connection detected");
      }
    }, KEEPALIVE_CHECK_INTERVAL_MS);
    // W2: drain all queued thread-sync requests (was a single string slot; now a Set).
    const toFlush = Array.from(pendingThreadSync);
    pendingThreadSync.clear();
    for (const prId of toFlush) {
      markThreadsSyncing(prId);
      ws?.send(JSON.stringify({ type: "threads:request-sync", data: { prId } }));
    }
    // On reconnect, reconcile missed prs:updated / repos:updated broadcasts.
    if (isReconnect) {
      void Promise.all([fetchRepos(), fetchPrs(), fetchPinnedPrs()]);
    }
    // Recover from any `walkthrough:complete` broadcasts the client missed
    // while WS was unconnected — the canonical case is `resumePending`
    // finishing a walkthrough between server boot and WS hookup, with the
    // user already on the PR view (which has `hydrateFromCache`'d while
    // the row was still `status='generating'` and now sits stuck on the
    // "Generate walkthrough" button). A fresh cache fetch picks up the
    // completed row; the Generate button is template-gated on `summary`
    // being null, so populating the entry hides it automatically.
    const selectedPrId = getSelectedPrId();
    if (selectedPrId) {
      void hydrateFromCache(selectedPrId);
    }
  };

  const onClose = (): void => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    ws = null;
    wsListeners = null;
    recordCounter("ws.disconnects", undefined);
    scheduleReconnect(token);
  };

  const onError = (): void => {
    // close event will fire next, which handles reconnect
  };

  const onMessage = (event: MessageEvent): void => {
    lastMessageTime = Date.now();
    try {
      const msg = JSON.parse(event.data as string) as WsServerMessage;
      handleMessage(msg);
    } catch {
      const raw = typeof event.data === "string" ? event.data.slice(0, 200) : "[binary]";
      console.warn("[ws] malformed message:", raw);
    }
  };

  wsListeners = { open: onOpen, close: onClose, error: onError, message: onMessage };
  ws.addEventListener("open", onOpen);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
  ws.addEventListener("message", onMessage);
}

function scheduleReconnect(token: string): void {
  const delay = getReconnectDelay();
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    connect(token);
  }, delay);
}

export function requestSync(): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "prs:request-sync" }));
  }
}

export function requestThreadSync(prId: string): void {
  markThreadsSyncing(prId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "threads:request-sync", data: { prId } }));
  } else {
    // WS not ready yet — queue it to be sent on connect
    pendingThreadSync.add(prId);
  }
}

export function requestFullSync(prId: string): void {
  markThreadsSyncing(prId);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "prs:request-sync" }));
    ws.send(JSON.stringify({ type: "threads:request-sync", data: { prId } }));
  } else {
    pendingThreadSync.add(prId);
  }
}

export function disconnect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  // W4: remove explicit listeners before nulling the socket so any retained
  // reference to the old WS object (e.g. in a closure) doesn't keep firing.
  if (ws && wsListeners) {
    ws.removeEventListener("open", wsListeners.open);
    ws.removeEventListener("close", wsListeners.close);
    ws.removeEventListener("error", wsListeners.error);
    ws.removeEventListener("message", wsListeners.message);
    wsListeners = null;
  }
  ws?.close(1000, "Client disconnecting");
  ws = null;
  reconnectAttempts = 0;
  activeHostOverride = null;
}
