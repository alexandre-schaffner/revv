// ── Conversation ────────────────────────────────────────────────────────────
//
// The Conversation tab's data: the PR's GitHub conversation (description,
// reviewers, assignees, labels, timeline) and the head commit's CI checks.
// GitHub is the source of truth, so this store only ever mirrors it:
//
// - Reads are stale-while-revalidate. The server's cached snapshot paints
//   first, then a fresh fetch replaces it. A conversation never replaces a
//   newer one (`fetchedAt`), and a load that raced a write is dropped.
// - Writes are optimistic. The local copy changes at once (a patch from
//   `conversation-patches.ts`), the server applies the write on GitHub and
//   answers the re-read conversation, which replaces the optimistic copy; a
//   failure undoes the rows the patch touched, nothing else.
// - The tab polls pending CI while it's on screen (see `watchChecks`).

import type {
  ActorOption,
  CheckDetails,
  CiRollup,
  ConversationWrite,
  ConversationWriteResult,
  PrConversation,
  PrConversationResponse,
  PrLabel,
  ReviewerOptions,
} from "@revv/shared";
import { hydrateConversationAvatars } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { apiErrorMessage } from "$lib/api/errors";
import { plain, thrownMessage } from "$lib/api/wire";
import {
  addAssigneesPatch,
  addLabelsPatch,
  type ConversationPatch,
  deleteCommentPatch,
  editBodyPatch,
  editCommentPatch,
  postCommentPatch,
  type ReviewerChange,
  removeAssigneesPatch,
  removeLabelsPatch,
  removeReviewersPatch,
  requestReviewersPatch,
} from "$lib/utils/conversation-patches";
import { RequestState } from "./_types";

/**
 * Affordances GitHub refused with a 403 this session. A GitHub App install
 * can lack `actions: write` or `issues: write` even when the viewer has
 * repo access; once refused, the UI swaps the control for "Open on GitHub"
 * instead of failing the same way again.
 */
export type DeniedCapability = "rerun" | "edit";

export interface ConversationEntry {
  readonly request: RequestState<PrConversation>;
  /** The shown data is the cached snapshot; GitHub couldn't be reached. */
  readonly stale: boolean;
  readonly checkDetails: ReadonlyMap<number, RequestState<CheckDetails>>;
  readonly denied: ReadonlySet<DeniedCapability>;
  /**
   * A re-run was just requested and GitHub may not report the new run yet:
   * CI polling keeps asking for a little while even with nothing pending.
   */
  readonly awaitingRerun: boolean;
}

const EMPTY: ConversationEntry = Object.freeze({
  request: RequestState.idle<PrConversation>(),
  stale: false,
  checkDetails: new Map(),
  denied: new Set<DeniedCapability>(),
  awaitingRerun: false,
});

/** A fresh fetch younger than this is good enough for a tab switch. */
const FRESH_FOR_MS = 30_000;

let entries = $state(new Map<string, ConversationEntry>());

/** In-flight loads per PR; plain Map, nothing renders it. */
const inflight = new Map<string, Promise<void>>();

/**
 * Bumped when a write starts and when it lands. A load that began under an
 * older generation may have read GitHub before the write and is dropped.
 */
const writeGeneration = new Map<string, number>();

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

/** Rewrite the loaded conversation in place; a no-op while there's none. */
function updateData(prId: string, updater: (conversation: PrConversation) => PrConversation): void {
  updateEntry(prId, (entry) =>
    entry.request.status === "ok"
      ? { ...entry, request: RequestState.ok(updater(entry.request.data)) }
      : entry,
  );
}

/**
 * Show `conversation` unless what's on screen was fetched later. `stale`
 * describes the answer either way: a snapshot served because GitHub was
 * unreachable keeps newer data, but the banner still says GitHub is down.
 */
function accept(prId: string, conversation: PrConversation, stale: boolean): void {
  updateEntry(prId, (entry) => {
    const current = entry.request.status === "ok" ? entry.request.data : null;
    const newer = !current || conversation.fetchedAt >= current.fetchedAt;
    return { ...entry, request: newer ? RequestState.ok(conversation) : entry.request, stale };
  });
}

/** A conversation off the wire, ready to render. */
function received(value: unknown): PrConversation {
  return hydrateConversationAvatars(plain(value) as PrConversation);
}

function describeFailure(error: { status: number; value?: unknown }): string {
  if (error.status === 429) return "GitHub's rate limit is exhausted. Try again shortly.";
  // A 502 is any upstream failure GitHub answered badly, not only an outage;
  // the server's own wording says which.
  return apiErrorMessage(
    error,
    error.status === 502 ? "GitHub couldn't be reached" : "Request failed",
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

/** The server's cached snapshot, which costs GitHub nothing. */
async function loadSnapshot(prId: string): Promise<void> {
  try {
    const { data } = await api.api.prs({ id: prId }).conversation.cached.get();
    if (data && "conversation" in data && data.conversation) {
      accept(prId, received(data.conversation), getConversation(prId).stale);
    }
  } catch {
    // Whoever asked has something better to fall back on.
  }
}

async function fetchConversation(prId: string): Promise<void> {
  const generation = writeGeneration.get(prId) ?? 0;
  if (dataOf(prId) === null) {
    updateEntry(prId, (entry) => ({ ...entry, request: RequestState.loading() }));
    // First paint from the server's snapshot while GitHub answers.
    await loadSnapshot(prId);
  }

  const failed = (message: string) =>
    updateEntry(prId, (entry) => ({
      ...entry,
      // Keep showing what we have; only an empty tab shows the error.
      request: entry.request.status === "ok" ? entry.request : RequestState.error(message),
      stale: entry.request.status === "ok",
    }));

  try {
    const { data, error } = await api.api.prs({ id: prId }).conversation.get();
    if (error || !data || !("conversation" in data)) {
      failed(error ? describeFailure(error) : "Unexpected response");
      return;
    }
    // A write began meanwhile; this answer may predate it.
    if ((writeGeneration.get(prId) ?? 0) !== generation && dataOf(prId) !== null) return;
    const response = plain(data) as PrConversationResponse;
    accept(prId, hydrateConversationAvatars(response.conversation), response.stale);
  } catch (e) {
    failed(thrownMessage(e));
  }
}

/** Re-read only the CI rollup; cheap enough to poll. Null when the ask failed. */
async function refreshChecks(prId: string): Promise<{ rollup: CiRollup | null } | null> {
  try {
    const { data, error } = await api.api.prs({ id: prId }).checks.get();
    if (error || !data || !("rollup" in data)) return null;
    const rollup = plain(data.rollup) as CiRollup | null;
    const ciAccess = data.access;
    updateData(prId, (c) => ({ ...c, ci: rollup, ciAccess }));
    refreshSettledDetails(prId, rollup);
    return { rollup };
  } catch {
    return null;
  }
}

/** True once a check's output can't change any more. */
function isFinal(details: RequestState<CheckDetails> | undefined): boolean {
  return details?.status === "ok" && details.data.completed;
}

export async function loadCheckDetails(prId: string, checkRunId: number): Promise<void> {
  const existing = getConversation(prId).checkDetails.get(checkRunId);
  if (existing?.status === "loading" || isFinal(existing)) return;
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
    put(RequestState.error(thrownMessage(e)));
  }
}

/**
 * Details fetched while a job was running say "still running" for good;
 * once the poll sees that job settle, ask again for its log.
 */
function refreshSettledDetails(prId: string, rollup: CiRollup | null): void {
  const details = getConversation(prId).checkDetails;
  for (const check of rollup?.checks ?? []) {
    if (check.checkRunId === null || check.bucket === "pending") continue;
    const shown = details.get(check.checkRunId);
    if (shown?.status === "ok" && !isFinal(shown)) void loadCheckDetails(prId, check.checkRunId);
  }
}

// ── Pickers ─────────────────────────────────────────────────────────────────

export async function loadReviewerOptions(prId: string, q: string): Promise<ReviewerOptions> {
  const { data, error } = await api.api.prs({ id: prId })["reviewer-options"].get({ query: { q } });
  if (error || !data || !("users" in data)) throw new Error("Reviewer options failed");
  return data;
}

export async function loadAssigneeOptions(prId: string, q: string): Promise<ActorOption[]> {
  const { data, error } = await api.api.prs({ id: prId })["assignee-options"].get({ query: { q } });
  if (error || !Array.isArray(data)) throw new Error("Assignee options failed");
  return data;
}

export async function loadLabelOptions(prId: string): Promise<PrLabel[]> {
  const { data, error } = await api.api.prs({ id: prId })["label-options"].get();
  if (error || !Array.isArray(data)) throw new Error("Label options failed");
  return data;
}

// ── CI polling ──────────────────────────────────────────────────────────────

const POLL_FIRST_MS = 20_000;
/** GitHub registers a re-run within seconds; the first look comes sooner. */
const POLL_AFTER_RERUN_MS = 5_000;
const POLL_MAX_MS = 60_000;
/** Polls with nothing pending before a re-run is taken to have been a no-op. */
const RERUN_GRACE_POLLS = 3;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollPrId: string | null = null;

export function hasPendingChecks(rollup: CiRollup | null | undefined): boolean {
  return (
    rollup?.state === "pending" ||
    rollup?.state === "expected" ||
    (rollup?.checks.some((c) => c.bucket === "pending") ?? false)
  );
}

/**
 * Poll the PR's CI, backing off from 20s to 60s, pausing while the window is
 * hidden, and stopping once nothing is pending (or a re-run's grace polls
 * ran out). A failed poll backs off and tries again. One PR at a time:
 * watching another stops the first. The tab owns when to watch; this
 * returns the stop function for its `$effect` teardown.
 */
export function watchChecks(prId: string): () => void {
  stopWatchingChecks();
  pollPrId = prId;
  let delay = getConversation(prId).awaitingRerun ? POLL_AFTER_RERUN_MS : POLL_FIRST_MS;
  let graceLeft = RERUN_GRACE_POLLS;

  const schedule = () => {
    pollTimer = setTimeout(() => void tick(), delay);
    delay = Math.min(delay * 1.5, POLL_MAX_MS);
  };
  const tick = async () => {
    pollTimer = null;
    if (pollPrId !== prId) return;
    if (typeof document !== "undefined" && document.hidden) {
      schedule();
      return;
    }
    const before = dataOf(prId)?.ci?.state ?? null;
    const answer = await refreshChecks(prId);
    if (pollPrId !== prId) return;
    if (!answer) {
      schedule();
      return;
    }
    const awaiting = getConversation(prId).awaitingRerun;
    if (hasPendingChecks(answer.rollup)) {
      if (awaiting) updateEntry(prId, (entry) => ({ ...entry, awaitingRerun: false }));
      schedule();
      return;
    }
    if (awaiting && graceLeft-- > 0) {
      schedule();
      return;
    }
    if (awaiting) updateEntry(prId, (entry) => ({ ...entry, awaitingRerun: false }));
    // Settled: the timeline's per-commit CI glyphs are now out of date too.
    if (answer.rollup?.state !== before) void loadConversation(prId, { force: true });
  };

  schedule();
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

function bumpGeneration(prId: string): void {
  writeGeneration.set(prId, (writeGeneration.get(prId) ?? 0) + 1);
}

/**
 * Apply a write, showing `patch` right away. On failure the patch is undone
 * against whatever the conversation reads by then, and a re-read reconciles
 * a write that only partly landed. Resolves true once GitHub took the write;
 * failures toast and resolve false.
 */
async function applyWrite(
  prId: string,
  write: ConversationWrite,
  patch?: ConversationPatch,
): Promise<boolean> {
  if (patch) updateData(prId, patch.apply);
  bumpGeneration(prId);

  const fail = (message: string, denied: boolean) => {
    if (patch) updateData(prId, patch.undo);
    if (denied) {
      updateEntry(prId, (entry) => ({
        ...entry,
        denied: new Set([...entry.denied, capabilityOf(write)]),
      }));
    }
    toast.error(message);
    void loadConversation(prId, { force: true });
    return false;
  };

  let result: ConversationWriteResult;
  try {
    const { data, error } = await api.api.prs({ id: prId }).conversation.writes.post(write);
    bumpGeneration(prId);
    if (error || !data || !("conversation" in data)) {
      // Eden types only the statuses the route declares; handleAppError
      // answers GitHub's refusal with a 403 the schema doesn't list.
      const status: number | undefined = error?.status;
      if (status === 403) {
        return fail(
          "GitHub refused this change for your account. Open the PR on GitHub to make it.",
          true,
        );
      }
      return fail(error ? describeFailure(error) : "GitHub didn't accept the change.", false);
    }
    result = data;
  } catch (e) {
    bumpGeneration(prId);
    return fail(e instanceof Error ? e.message : "GitHub couldn't be reached.", false);
  }

  if (result.conversation) {
    accept(prId, received(result.conversation), false);
  } else {
    // The write landed but the server couldn't re-read it: keep the
    // optimistic copy and catch up.
    void loadConversation(prId, { force: true });
  }
  if (capabilityOf(write) === "rerun") {
    // Reruns get new check IDs; existing IDs still describe their original runs.
    updateEntry(prId, (entry) => ({ ...entry, awaitingRerun: true }));
  }
  return true;
}

export function postComment(prId: string, body: string): Promise<boolean> {
  return applyWrite(prId, { kind: "post_comment", body }, postCommentPatch(body));
}

export function editComment(prId: string, commentId: number, body: string): Promise<boolean> {
  return applyWrite(
    prId,
    { kind: "edit_comment", commentId, body },
    editCommentPatch(commentId, body),
  );
}

export function deleteComment(prId: string, commentId: number): Promise<boolean> {
  return applyWrite(prId, { kind: "delete_comment", commentId }, deleteCommentPatch(commentId));
}

export function editBody(prId: string, body: string): Promise<boolean> {
  return applyWrite(prId, { kind: "edit_body", body }, editBodyPatch(body));
}

export async function changeReviewers(
  prId: string,
  added: ReviewerChange,
  removed: ReviewerChange,
): Promise<void> {
  if (added.users.length > 0 || added.teams.length > 0) {
    await applyWrite(
      prId,
      { kind: "request_reviewers", users: [...added.users], teams: [...added.teams] },
      requestReviewersPatch(added),
    );
  }
  if (removed.users.length > 0 || removed.teams.length > 0) {
    await applyWrite(
      prId,
      { kind: "remove_reviewers", users: [...removed.users], teams: [...removed.teams] },
      removeReviewersPatch(removed),
    );
  }
}

export async function changeAssignees(
  prId: string,
  added: readonly string[],
  removed: readonly string[],
): Promise<void> {
  if (added.length > 0) {
    await applyWrite(prId, { kind: "add_assignees", logins: [...added] }, addAssigneesPatch(added));
  }
  if (removed.length > 0) {
    await applyWrite(
      prId,
      { kind: "remove_assignees", logins: [...removed] },
      removeAssigneesPatch(removed),
    );
  }
}

export async function changeLabels(
  prId: string,
  added: readonly PrLabel[],
  removed: readonly string[],
): Promise<void> {
  if (added.length > 0) {
    await applyWrite(
      prId,
      { kind: "add_labels", names: added.map((l) => l.name) },
      addLabelsPatch(added),
    );
  }
  if (removed.length > 0) {
    await applyWrite(
      prId,
      { kind: "remove_labels", names: [...removed] },
      removeLabelsPatch(removed),
    );
  }
}

export async function rerunFailedRuns(prId: string, runIds: readonly number[]): Promise<void> {
  if (runIds.length > 0) await applyWrite(prId, { kind: "rerun_failed", runIds: [...runIds] });
}

export async function rerunJob(prId: string, jobId: number): Promise<void> {
  await applyWrite(prId, { kind: "rerun_job", jobId });
}

// ── SSE ─────────────────────────────────────────────────────────────────────

export function onPrConversationUpdated(data: { prId: string; fetchedAt: string | null }): void {
  if (!entries.has(data.prId)) return;
  if (data.fetchedAt === null) {
    void loadConversation(data.prId, { force: true });
    return;
  }
  // The view that made the write already holds this snapshot or a newer one.
  const current = dataOf(data.prId);
  if (current && current.fetchedAt >= data.fetchedAt) return;
  void loadSnapshot(data.prId);
}
