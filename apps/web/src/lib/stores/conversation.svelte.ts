// ── Conversation ────────────────────────────────────────────────────────────
//
// The Conversation tab's data: the PR's GitHub conversation (description,
// reviewers, assignees, labels, timeline) and the head commit's CI checks.
// GitHub is the source of truth, so this store only ever mirrors it:
//
// - Reads are stale-while-revalidate. The server's cached snapshot paints
//   first, then a fresh fetch replaces it.
// - Writes are optimistic. The local copy changes at once, the server applies
//   the write on GitHub and answers the re-read conversation, which replaces
//   the optimistic copy; a failure restores the fields it touched.
// - Pending CI is polled while the tab is on screen (see `watchChecks`).

import {
  type CheckDetails,
  type CiRollup,
  hydrateConversationAvatars,
  type PrConversation,
  type PrConversationResponse,
} from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { RequestState } from "./_types";

/** A write the tab makes; mirrors the server's `ConversationWrite`. */
export type ConversationWrite =
  | { kind: "request_reviewers"; users: string[]; teams: string[] }
  | { kind: "remove_reviewers"; users: string[]; teams: string[] }
  | { kind: "add_assignees"; logins: string[] }
  | { kind: "remove_assignees"; logins: string[] }
  | { kind: "add_labels"; names: string[] }
  | { kind: "remove_label"; name: string }
  | { kind: "post_comment"; body: string }
  | { kind: "edit_comment"; commentId: number; body: string }
  | { kind: "delete_comment"; commentId: number }
  | { kind: "edit_body"; body: string }
  | { kind: "rerun_failed"; runId: number }
  | { kind: "rerun_job"; jobId: number };

/**
 * Affordances GitHub refused with a 403 this session. A GitHub App install
 * can lack `actions: write` or `issues: write` even when the viewer has
 * repo access; once refused, the UI swaps the control for "Open on GitHub"
 * instead of failing the same way again.
 */
export type DeniedCapability = "rerun" | "edit";

export interface ConversationEntry {
  readonly request: RequestState<PrConversation>;
  /** A fresh fetch is in flight while `request` shows older data. */
  readonly refreshing: boolean;
  /** The shown data is the cached snapshot; GitHub couldn't be reached. */
  readonly stale: boolean;
  readonly checkDetails: ReadonlyMap<number, RequestState<CheckDetails>>;
  readonly denied: ReadonlySet<DeniedCapability>;
}

const EMPTY: ConversationEntry = Object.freeze({
  request: RequestState.idle<PrConversation>(),
  refreshing: false,
  stale: false,
  checkDetails: new Map(),
  denied: new Set<DeniedCapability>(),
});

/** A fresh fetch younger than this is good enough for a tab switch. */
const FRESH_FOR_MS = 30_000;

let entries = $state(new Map<string, ConversationEntry>());

/** In-flight loads per PR; plain Map, nothing renders it. */
const inflight = new Map<string, Promise<void>>();

function setEntry(prId: string, entry: ConversationEntry): void {
  entries.set(prId, entry);
  entries = new Map(entries);
}

function updateEntry(prId: string, updater: (entry: ConversationEntry) => ConversationEntry): void {
  setEntry(prId, updater(entries.get(prId) ?? EMPTY));
}

export function getConversation(prId: string): ConversationEntry {
  return entries.get(prId) ?? EMPTY;
}

/** The loaded conversation, or null while it isn't. */
function dataOf(prId: string): PrConversation | null {
  const request = getConversation(prId).request;
  return request.status === "ok" ? request.data : null;
}

/**
 * Eden revives ISO strings into `Date`s on the way in; the shared types say
 * `string`. A JSON round trip puts them back, so formatting code downstream
 * never has to ask which one it holds.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A conversation off the wire, ready to render. */
function received(value: unknown): PrConversation {
  return hydrateConversationAvatars(plain(value) as PrConversation);
}

function describeFailure(error: { status: number; value: unknown }): string {
  const value = error.value as { error?: unknown; message?: unknown } | null;
  const detail =
    typeof value?.error === "string"
      ? value.error
      : typeof value?.message === "string"
        ? value.message
        : null;
  if (error.status === 429) return "GitHub's rate limit is exhausted. Try again shortly.";
  // A 502 is any upstream failure GitHub answered badly, not only an outage;
  // the server's own wording says which.
  return (
    detail ??
    (error.status === 502 ? "GitHub couldn't be reached." : `Request failed (HTTP ${error.status})`)
  );
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Load the conversation. With data younger than {@link FRESH_FOR_MS} it does
 * nothing unless `force`; concurrent calls share one fetch.
 */
export function loadConversation(prId: string, opts: { force?: boolean } = {}): Promise<void> {
  const current = dataOf(prId);
  if (
    !opts.force &&
    current &&
    !getConversation(prId).stale &&
    Date.now() - Date.parse(current.fetchedAt) < FRESH_FOR_MS
  ) {
    return Promise.resolve();
  }
  const running = inflight.get(prId);
  if (running) return running;
  const run = fetchConversation(prId).finally(() => inflight.delete(prId));
  inflight.set(prId, run);
  return run;
}

async function fetchConversation(prId: string): Promise<void> {
  const hadData = dataOf(prId) !== null;
  updateEntry(prId, (entry) => ({
    ...entry,
    request: hadData ? entry.request : RequestState.loading(),
    refreshing: true,
  }));

  // First paint from the server's snapshot while GitHub answers.
  if (!hadData) {
    try {
      const { data } = await api.api.prs({ id: prId }).conversation.cached.get();
      if (data && "conversation" in data && data.conversation && dataOf(prId) === null) {
        const snapshot = received(data.conversation);
        updateEntry(prId, (entry) => ({ ...entry, request: RequestState.ok(snapshot) }));
      }
    } catch {
      // The fresh fetch below reports anything that matters.
    }
  }

  try {
    const { data, error } = await api.api.prs({ id: prId }).conversation.get();
    if (error || !data || !("conversation" in data)) {
      const message = error ? describeFailure(error) : "Unexpected response";
      updateEntry(prId, (entry) => ({
        ...entry,
        // Keep showing what we have; only an empty tab shows the error.
        request: entry.request.status === "ok" ? entry.request : RequestState.error(message),
        stale: entry.request.status === "ok",
        refreshing: false,
      }));
      return;
    }
    const response = plain(data) as PrConversationResponse;
    updateEntry(prId, (entry) => ({
      ...entry,
      request: RequestState.ok(hydrateConversationAvatars(response.conversation)),
      stale: response.stale,
      refreshing: false,
    }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    updateEntry(prId, (entry) => ({
      ...entry,
      request: entry.request.status === "ok" ? entry.request : RequestState.error(message),
      stale: entry.request.status === "ok",
      refreshing: false,
    }));
  }
}

/** Re-read only the CI rollup; cheap enough to poll. */
export async function refreshChecks(prId: string): Promise<CiRollup | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).checks.get();
    if (error || !data || !("rollup" in data)) return null;
    const rollup = plain(data.rollup) as CiRollup | null;
    const ciAccess = data.access;
    updateEntry(prId, (entry) =>
      entry.request.status === "ok"
        ? { ...entry, request: RequestState.ok({ ...entry.request.data, ci: rollup, ciAccess }) }
        : entry,
    );
    return rollup;
  } catch {
    return null;
  }
}

export async function loadCheckDetails(prId: string, checkRunId: number): Promise<void> {
  const existing = getConversation(prId).checkDetails.get(checkRunId);
  if (existing?.status === "ok" || existing?.status === "loading") return;
  const put = (state: RequestState<CheckDetails>) =>
    updateEntry(prId, (entry) => {
      const next = new Map(entry.checkDetails);
      next.set(checkRunId, state);
      return { ...entry, checkDetails: next };
    });
  put(RequestState.loading());
  try {
    const { data, error } = await api.api.prs({ id: prId }).checks({ checkRunId }).get();
    if (error || !data || !("checkRunId" in data)) {
      put(RequestState.error(error ? describeFailure(error) : "Unexpected response"));
      return;
    }
    put(RequestState.ok(plain(data) as CheckDetails));
  } catch (e) {
    put(RequestState.error(e instanceof Error ? e.message : String(e)));
  }
}

/** Drop a check's cached details, e.g. after a re-run replaced its log. */
function forgetCheckDetails(prId: string): void {
  updateEntry(prId, (entry) => ({ ...entry, checkDetails: new Map() }));
}

// ── CI polling ──────────────────────────────────────────────────────────────

const POLL_FIRST_MS = 20_000;
const POLL_MAX_MS = 60_000;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollPrId: string | null = null;

function hasPendingChecks(rollup: CiRollup | null | undefined): boolean {
  return rollup?.checks.some((c) => c.bucket === "pending") ?? false;
}

/**
 * Poll the PR's CI while any check is pending, backing off from 20s to 60s,
 * and pausing while the window is hidden. One PR at a time: watching another
 * stops the first. Returns the stop function, for a `$effect` teardown.
 */
export function watchChecks(prId: string): () => void {
  stopWatchingChecks();
  pollPrId = prId;
  let delay = POLL_FIRST_MS;

  const tick = async () => {
    pollTimer = null;
    if (pollPrId !== prId) return;
    if (typeof document !== "undefined" && document.hidden) {
      schedule();
      return;
    }
    const before = dataOf(prId)?.ci?.state ?? null;
    const rollup = await refreshChecks(prId);
    if (pollPrId !== prId) return;
    if (!hasPendingChecks(rollup)) {
      // Settled: the timeline's per-commit CI glyphs are now out of date too.
      if (rollup?.state !== before) void loadConversation(prId, { force: true });
      return;
    }
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
    schedule();
  };
  const schedule = () => {
    pollTimer = setTimeout(() => void tick(), delay);
  };

  if (hasPendingChecks(dataOf(prId)?.ci)) schedule();
  return stopWatchingChecks;
}

function stopWatchingChecks(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
  pollPrId = null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

function capabilityOf(write: ConversationWrite): DeniedCapability {
  return write.kind === "rerun_failed" || write.kind === "rerun_job" ? "rerun" : "edit";
}

/**
 * Apply a write. `optimistic` returns the conversation as it should read
 * right away; on failure the conversation goes back to what it was, unless
 * something else (a refetch, another write) replaced it meanwhile. Resolves
 * true on success; failures toast and resolve false.
 */
export async function applyConversationWrite(
  prId: string,
  write: ConversationWrite,
  optimistic?: (conversation: PrConversation) => PrConversation,
): Promise<boolean> {
  const before = dataOf(prId);
  let shown: PrConversation | null = null;
  if (before && optimistic) {
    shown = optimistic(before);
    const next = shown;
    updateEntry(prId, (entry) => ({ ...entry, request: RequestState.ok(next) }));
  }
  const rollback = () => {
    if (before && shown && dataOf(prId) === shown) {
      updateEntry(prId, (entry) => ({ ...entry, request: RequestState.ok(before) }));
    }
  };

  try {
    const { data, error } = await api.api.prs({ id: prId }).conversation.writes.post(write);
    if (error || !data || !("timeline" in data)) {
      rollback();
      // Eden types only the statuses the route declares; handleAppError
      // answers GitHub's refusal with a 403 the schema doesn't list.
      const status: number | undefined = error?.status;
      if (status === 403) {
        updateEntry(prId, (entry) => ({
          ...entry,
          denied: new Set([...entry.denied, capabilityOf(write)]),
        }));
        toast.error(
          "GitHub refused this change for your account. Open the PR on GitHub to make it.",
        );
      } else {
        toast.error(error ? describeFailure(error) : "GitHub didn't accept the change.");
      }
      return false;
    }
    const fresh = received(data);
    updateEntry(prId, (entry) => ({ ...entry, request: RequestState.ok(fresh), stale: false }));
    if (capabilityOf(write) === "rerun") {
      forgetCheckDetails(prId);
      watchChecks(prId);
    }
    return true;
  } catch (e) {
    rollback();
    toast.error(e instanceof Error ? e.message : "GitHub couldn't be reached.");
    return false;
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────────

export function onPrConversationUpdated(data: { prId: string }): void {
  if (!entries.has(data.prId)) return;
  void loadConversation(data.prId, { force: true });
}
