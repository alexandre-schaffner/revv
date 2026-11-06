// ── Walkthrough store ───────────────────────────────────────────────────────
//
// One entry per PR, folded from the global SSE bus (`onWalkthroughEvent`, routed
// by events.svelte.ts) and from REST snapshots (`hydrateFromCache`). The
// folding itself is pure and lives in walkthrough-reducer.ts; the user's verbs
// (generate, regenerate, resume, stop) live in walkthrough-actions.ts.
//
// SSE delivery is best-effort (invariant 8): whatever a reconnect or a stall
// may have missed is re-read from `/current`, which is authoritative.

import type {
  PullRequest,
  RiskLevel,
  WalkthroughBlock,
  WalkthroughEventEnvelope,
  WalkthroughIssue,
  WalkthroughLead,
  WalkthroughMode,
  WalkthroughRating,
  WalkthroughReviewRoundsResponse,
  WalkthroughTokenUsage,
} from "@revv/shared";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { toast } from "svelte-sonner";
import { API_BASE_URL } from "$lib/api/base-url";
import { authHeaders } from "$lib/session/token.svelte";
import { getReviewModeForPr, getSelectedPrId } from "$lib/stores/prs.svelte";
import { shallowEntryEqual, updateEntryInMap } from "$lib/stores/walkthrough-entry-equal";
import { addressesActiveWalkthrough } from "$lib/stores/walkthrough-event-target";
import {
  applyEvents,
  hasAllContent,
  idleEntry,
  isSettledComplete,
  mergeSnapshot,
  startingEntry,
  type WalkthroughEntry,
  type WalkthroughSnapshot,
  type WalkthroughUiState,
  walkthroughUiState,
  ZERO_TOKEN_USAGE,
} from "$lib/stores/walkthrough-reducer";
import { wtTrace } from "$lib/utils/wt-trace";
import { createResource } from "./resource";

// ── State ───────────────────────────────────────────────────────────────────

// SvelteMap writes notify only when the stored reference changes: an entry is
// replaced, never mutated and re-set (the reducer and `updateEntryInMap` both
// hand back a fresh object).
const entries = new SvelteMap<string, WalkthroughEntry>();
/**
 * Per-walkthrough seq cursor: set from a snapshot's `seqAt`, advanced by every
 * applied envelope. Envelopes at or below it are re-deliveries, or content a
 * newer snapshot already holds.
 */
const lastSeenSeq = new Map<string, number>();
/**
 * Null follows the PR's current walkthrough. An id is a report the user picked
 * from the history, which live events for other walkthroughs must not touch.
 */
const selectedReportIds = new SvelteMap<string, string | null>();

export type PendingAction = "regenerate" | "resume" | "start";

/** Keeps the start/regenerate/resume buttons disabled across their round trip. */
const pendingActions = new SvelteMap<string, PendingAction>();

/** PRs whose page is reading their first snapshot. */
const hydrating = new SvelteSet<string>();

/** PRs on screen. A completion elsewhere gets a "Walkthrough ready" toast. */
const watched = new Set<string>();

/** When the last envelope for a PR was applied; the stall watchdog reads it. */
const lastEventAtByPr = new Map<string, number>();

// ── Writes (this module and walkthrough-actions.ts) ─────────────────────────

export function setEntry(prId: string, entry: WalkthroughEntry): void {
  entries.set(prId, entry);
}

export function deleteEntry(prId: string): void {
  entries.delete(prId);
  lastEventAtByPr.delete(prId);
}

export function updateEntry(prId: string, updater: (e: WalkthroughEntry) => void): void {
  if (updateEntryInMap(entries, prId, updater) === "missing") {
    wtTrace("store", `updateEntry-noop prId=${prId} reason=no-entry`);
  }
}

export function followCurrentReport(prId: string): void {
  selectedReportIds.set(prId, null);
}

export function setPendingAction(prId: string, action: PendingAction): void {
  pendingActions.set(prId, action);
}

export function clearPendingAction(prId: string): void {
  pendingActions.delete(prId);
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getWalkthroughEntry(prId: string): WalkthroughEntry | undefined {
  return entries.get(prId);
}

export function getWalkthroughUiState(prId: string): WalkthroughUiState {
  return walkthroughUiState(entries.get(prId));
}

export function getIsHydrating(prId: string): boolean {
  return hydrating.has(prId);
}

export function getBlocks(prId: string): WalkthroughBlock[] {
  return entries.get(prId)?.blocks ?? [];
}

export function getIssues(prId: string): WalkthroughIssue[] {
  return entries.get(prId)?.issues ?? [];
}

export function getIssuesForFile(prId: string, filePath: string): WalkthroughIssue[] {
  return getIssues(prId).filter((i) => i.filePath === filePath);
}

export function getRatings(prId: string): WalkthroughRating[] {
  return entries.get(prId)?.ratings ?? [];
}

export function getLeads(prId: string): WalkthroughLead[] | null {
  return entries.get(prId)?.leads ?? null;
}

export function getIsStreaming(prId: string): boolean {
  return entries.get(prId)?.isStreaming ?? false;
}

export function getRiskLevel(prId: string): RiskLevel | null {
  return entries.get(prId)?.riskLevel ?? null;
}

/** Model the PR's latest walkthrough launched with, if any has. */
export function getWalkthroughModelUsed(prId: string): string | null {
  return entries.get(prId)?.modelUsed ?? null;
}

export function getTokenUsage(prId: string): WalkthroughTokenUsage {
  return entries.get(prId)?.tokenUsage ?? ZERO_TOKEN_USAGE;
}

export function getDisplayedWalkthroughId(prId: string): string | null {
  return entries.get(prId)?.walkthroughId ?? null;
}

export function getSelectedReportId(prId: string): string | null {
  return selectedReportIds.get(prId) ?? null;
}

export function getPendingAction(prId: string): PendingAction | null {
  return pendingActions.get(prId) ?? null;
}

/**
 * The perspective a walkthrough is written from is the user's pick, stored on
 * the walkthrough itself; only one is active per PR, so the entry is the
 * record. The review session (comments, threads, diff) isn't keyed on it.
 */
export function getSelectedMode(prId: string): WalkthroughMode {
  return entries.get(prId)?.mode ?? getReviewModeForPr(prId);
}

export function getPrWalkthroughStatus(prId: string): "idle" | "generating" | "complete" | "error" {
  const entry = entries.get(prId);
  if (!entry) return "idle";
  if (entry.isStreaming) return "generating";
  if (entry.streamError) return "error";
  if (entry.summary) return "complete";
  return "idle";
}

/**
 * A review of the loaded head is on screen, past its empty start: its issues
 * and lead verdicts can say what became of a first-pass lead.
 */
export function getReviewsLoadedHead(prId: string): boolean {
  const { kind } = getWalkthroughUiState(prId);
  return (
    kind === "streaming" || kind === "complete" || kind === "resumable" || kind === "error-partial"
  );
}

export function getLastWalkthroughEventAt(prId: string): number | null {
  return lastEventAtByPr.get(prId) ?? null;
}

// ── Review rounds ───────────────────────────────────────────────────────────

const reviewRounds = createResource<string, WalkthroughReviewRoundsResponse>({
  fetch: async (_key, prId) => {
    const res = await fetch(`${API_BASE_URL}/api/reviews/${prId}/walkthrough/rounds`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
    return { status: "ok", data: (await res.json()) as WalkthroughReviewRoundsResponse };
  },
});

/** A PR's review rounds, both perspectives in one timeline (each round
 *  carries its `mode`): only one perspective is active per PR at a time. */
export function getReviewRounds(prId: string): WalkthroughReviewRoundsResponse | null {
  return reviewRounds.data(prId);
}

export function getHasUnreviewedCommits(prId: string): boolean {
  return getReviewRounds(prId)?.hasNewCommits ?? false;
}

export async function loadReviewRounds(prId: string): Promise<void> {
  await reviewRounds.load(prId, prId);
}

/** A PR moving changes its rounds; re-read them for every PR this store follows. */
export function onPrsUpdated(prs: readonly PullRequest[]): void {
  for (const { id } of prs) {
    if (reviewRounds.entry(id).request.status !== "idle" || entries.has(id) || watched.has(id)) {
      void loadReviewRounds(id);
    }
  }
}

// ── Snapshots ───────────────────────────────────────────────────────────────

interface HydrateOptions {
  /** Start from the snapshot alone, dropping what the entry holds. */
  replace?: boolean;
  /** A historical report; null or absent reads the current one. */
  reportId?: string | null;
}

/** Concurrent reads of one PR's report share a request; the first caller's options win. */
const hydrations = createResource<{ prId: string; options: HydrateOptions | undefined }, boolean>({
  fetch: async (_key, { prId, options }) => ({
    status: "ok",
    data: await readSnapshot(prId, options),
  }),
});

/**
 * Read a walkthrough snapshot over REST and fold it into the entry. The only
 * client path that returns walkthrough content without ever starting a run.
 * Resolves false when nothing was found or the read failed.
 */
export async function hydrateFromCache(prId: string, options?: HydrateOptions): Promise<boolean> {
  const key = `${prId}:${options?.reportId ?? "current"}`;
  const request = await hydrations.load(key, { prId, options });
  return request.status === "ok" && request.data;
}

async function readSnapshot(prId: string, options?: HydrateOptions): Promise<boolean> {
  const reportId = options?.reportId ?? null;
  wtTrace("lifecycle", `hydrateFromCache enter prId=${prId}`);
  if (!options?.replace && reportId === null) {
    // A fresh run is starting: `/current` would still answer with the row it
    // is about to retire. The start path reads its new row by id instead.
    if (pendingActions.has(prId)) {
      wtTrace("lifecycle", `hydrateFromCache skip prId=${prId} reason=start-pending`);
      return false;
    }
    const existing = entries.get(prId);
    if (existing && isSettledComplete(existing)) {
      wtTrace("lifecycle", `hydrateFromCache skip prId=${prId} reason=already-complete`);
      return true;
    }
  }

  try {
    const endpoint =
      reportId === null
        ? `${API_BASE_URL}/api/reviews/${prId}/walkthrough/current`
        : `${API_BASE_URL}/api/reviews/${prId}/walkthrough/report/${reportId}`;
    const res = await fetch(endpoint, { headers: authHeaders(), credentials: "include" });
    if (!res.ok) {
      wtTrace("lifecycle", `hydrateFromCache prId=${prId} httpStatus=${res.status} → false`);
      return false;
    }
    const body = (await res.json()) as
      | { status: "not_found"; mode?: WalkthroughMode }
      | WalkthroughSnapshot;

    if (body.status === "not_found") {
      wtTrace("lifecycle", `hydrateFromCache prId=${prId} status=not_found → false`);
      // The server names the perspective Generate defaults to; only an entry
      // that isn't following a walkthrough takes it.
      const defaultMode = body.mode;
      if (defaultMode !== undefined) {
        updateEntry(prId, (e) => {
          if (e.walkthroughId === null) e.mode = defaultMode;
        });
      }
      return false;
    }

    const wt = body.walkthrough;
    wtTrace(
      "lifecycle",
      `hydrateFromCache prId=${prId} status=${body.status} blocks=${wt.blocks.length} issues=${wt.issues.length} ratings=${wt.ratings.length}`,
    );
    const entry = mergeSnapshot(options?.replace ? undefined : entries.get(prId), body);
    entries.set(prId, entry);
    selectedReportIds.set(prId, entry.historical ? wt.id : null);
    // Max: the SSE may have advanced past the snapshot during the fetch.
    if (typeof body.seqAt === "number") {
      lastSeenSeq.set(wt.id, Math.max(lastSeenSeq.get(wt.id) ?? -1, body.seqAt));
    }
    return true;
  } catch (e) {
    wtTrace(
      "lifecycle",
      `hydrateFromCache prId=${prId} error=${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * Start following a PR's walkthrough on screen: seed an empty entry so the
 * page doesn't flash its empty state, then read the snapshot. Returns the
 * function that stops following it.
 */
export function watchWalkthrough(prId: string): () => void {
  watched.add(prId);
  if (!entries.has(prId)) entries.set(prId, idleEntry(getSelectedMode(prId)));
  hydrating.add(prId);
  void hydrateFromCache(prId).finally(() => hydrating.delete(prId));
  return () => {
    watched.delete(prId);
    hydrating.delete(prId);
  };
}

export async function selectWalkthroughReport(
  prId: string,
  walkthroughId: string | null,
): Promise<void> {
  selectedReportIds.set(prId, walkthroughId);
  const ok = await hydrateFromCache(prId, { reportId: walkthroughId, replace: true });
  if (!ok) {
    updateEntry(prId, (entry) => {
      entry.isStreaming = false;
      entry.streamError =
        walkthroughId === null
          ? "Failed to load the latest walkthrough report."
          : "Failed to load the selected walkthrough report.";
    });
  }
}

/**
 * Stamp `submittedAt` on walkthrough issues so the "posted to GitHub"
 * treatment shows as soon as a Submit/Approve succeeds.
 */
export function markIssuesAsSubmitted(
  prId: string,
  issueIds: readonly string[],
  submittedAt: string,
): void {
  if (issueIds.length === 0) return;
  const idSet = new Set(issueIds);
  updateEntry(prId, (entry) => {
    entry.issues = entry.issues.map((i) => (idSet.has(i.id) ? { ...i, submittedAt } : i));
  });
}

// ── Global SSE ──────────────────────────────────────────────────────────────

function toastReady(prId: string): void {
  if (watched.has(prId)) return;
  toast.success("Walkthrough ready", { description: "Switch to that PR to review." });
}

export function onWalkthroughEvent({
  prId,
  walkthroughId,
  seq,
  event,
}: WalkthroughEventEnvelope["data"]): void {
  const selectedReportId = selectedReportIds.get(prId) ?? null;
  const entry = entries.get(prId);
  const foreign =
    (selectedReportId !== null && selectedReportId !== walkthroughId) ||
    // `lifecycle:started` is how an entry learns which walkthrough to follow.
    (event.type !== "lifecycle:started" &&
      entry !== undefined &&
      !addressesActiveWalkthrough(entry, walkthroughId, event.type));
  if (foreign) {
    wtTrace(
      "apply",
      `onWalkthroughEvent-foreign wt=${walkthroughId} active=${entry?.walkthroughId ?? "none"} type=${event.type}`,
    );
    if (event.type === "lifecycle:complete") {
      void loadReviewRounds(prId);
      toastReady(prId);
    }
    return;
  }

  const cursor = lastSeenSeq.get(walkthroughId) ?? -1;
  if (seq <= cursor) {
    wtTrace(
      "apply",
      `onWalkthroughEvent-drop wt=${walkthroughId} seq=${seq} cursor=${cursor} type=${event.type}`,
    );
    return;
  }

  // A run in the background may announce itself before its PR was ever
  // opened; the sidebar spinner reads this entry.
  const base =
    entry ??
    (event.type === "lifecycle:started"
      ? startingEntry(event.data.mode ?? getSelectedMode(prId), "Starting walkthrough…")
      : undefined);
  if (base) {
    wtTrace("apply", `applyEvents prId=${prId} type=${event.type}`);
    const next = applyEvents(base, [event]);
    if (base !== entry || !shallowEntryEqual(base, next)) entries.set(prId, next);
  }
  lastSeenSeq.set(walkthroughId, seq);
  lastEventAtByPr.set(prId, Date.now());

  if (event.type === "lifecycle:complete") {
    const applied = entries.get(prId);
    if (applied && !hasAllContent(applied)) void hydrateFromCache(prId);
    void loadReviewRounds(prId);
    toastReady(prId);
  }
}

/**
 * Seed entries for the account's in-flight walkthroughs. A cursor from
 * `/active` is only safe once that run's snapshot is merged; otherwise the
 * already-written events it skips would never render.
 */
async function hydrateActiveWalkthroughs(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/walkthroughs/active`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      walkthroughs: Array<{
        prId: string;
        walkthroughId: string;
        mode?: WalkthroughMode;
        seqAt: number;
      }>;
    };
    for (const row of body.walkthroughs) {
      const selectedReportId = selectedReportIds.get(row.prId) ?? null;
      if (selectedReportId !== null && selectedReportId !== row.walkthroughId) continue;
      if (!entries.has(row.prId)) {
        entries.set(row.prId, {
          ...startingEntry(row.mode ?? getSelectedMode(row.prId), "Generating walkthrough…"),
          walkthroughId: row.walkthroughId,
          liveGeneration: true,
          phase: "writing",
        });
      }
      if (await hydrateFromCache(row.prId)) {
        lastSeenSeq.set(
          row.walkthroughId,
          Math.max(lastSeenSeq.get(row.walkthroughId) ?? -1, row.seqAt),
        );
      }
    }
  } catch (e) {
    wtTrace(
      "lifecycle",
      `hydrateActiveWalkthroughs failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Every (re)connect: seed the sidebar and the cursors of in-flight runs. */
export function onEventsOpened(): void {
  void hydrateActiveWalkthroughs();
}

/**
 * Events broadcast while the stream was down reached no one; merge the open
 * PR's snapshot back in. Background PRs catch up when their page opens.
 */
export function onEventsReconnected(): void {
  const prId = getSelectedPrId();
  if (prId) void hydrateFromCache(prId);
}

export function reset(): void {
  entries.clear();
  lastSeenSeq.clear();
  selectedReportIds.clear();
  pendingActions.clear();
  hydrating.clear();
  watched.clear();
  reviewRounds.reset();
  hydrations.reset();
  lastEventAtByPr.clear();
}
