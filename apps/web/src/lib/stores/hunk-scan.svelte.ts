// ── First pass ──────────────────────────────────────────────────────────────
//
// The per-hunk smell scan for each PR head, independent of any walkthrough:
// the review page asks for it once the diff has loaded (`ensureHunkScan`), and
// its rows stream in over `hunk-scan:*`. A walkthrough for the same head reuses
// the scan, so the Diff tab and the walkthrough read the same entry. Keyed on
// `(prId, headSha)` like the sizing preview, not on `prId` alone: a pull starts
// a new scan rather than changing the old one, and the diff on screen keeps
// the scan of the head it was loaded at until the user pulls.

import type {
  HunkScanCompleteEnvelope,
  HunkScanEnsureResult,
  HunkScanEventMessage,
  HunkScanHunkEnvelope,
  HunkScanRow,
  HunkScanStartedEnvelope,
  HunkScanStatus,
} from "@revv/shared";
import { api } from "$lib/api/client";
import { getLoadedHeadSha } from "$lib/stores/diff-files.svelte";
import { getSelectedPrId } from "$lib/stores/route.svelte";
import {
  type EventsSinceAsked,
  mergeHydratedHunkScan,
  reduceHunkScanEvent,
} from "./hunk-scan-reducers";
import { type Answer, createResource } from "./resource";

/** What a settled ask learned: TypeSafe is off, or the scan came back. */
type EnsureOutcome = Exclude<HunkScanEnsureResult["status"], "pending">;

interface HunkScanEntry {
  /** One per hunk. Empty until the scan starts, and after it fails. */
  readonly rows: HunkScanRow[];
  /** The persisted lifecycle; null when it never ran. */
  readonly status: HunkScanStatus | null;
}

const EMPTY: HunkScanEntry = Object.freeze({ rows: [], status: null });

let entries = $state(new Map<string, HunkScanEntry>());

/**
 * `hunk-scan:*` events seen per key, so a snapshot can tell whether the stream
 * moved while it was in flight. Plain Maps: nothing renders them.
 */
const eventsSeen = new Map<string, number>();
const startsSeen = new Map<string, number>();

function entryKey(prId: string, headSha: string): string {
  return `${prId}@${headSha}`;
}

function setEntry(key: string, entry: HunkScanEntry): void {
  entries.set(key, entry);
  entries = new Map(entries);
}

function updateEntry(key: string, updater: (entry: HunkScanEntry) => HunkScanEntry): void {
  setEntry(key, updater(entries.get(key) ?? EMPTY));
}

/** Read the event counters now; call the result once the snapshot is back. */
function markEvents(key: string): () => EventsSinceAsked {
  const events = eventsSeen.get(key) ?? 0;
  const starts = startsSeen.get(key) ?? 0;
  return () =>
    (startsSeen.get(key) ?? 0) !== starts
      ? "started"
      : (eventsSeen.get(key) ?? 0) !== events
        ? "deltas"
        : "none";
}

export function getHunkScan(prId: string | null, headSha: string | null): HunkScanEntry {
  if (prId === null || headSha === null) return EMPTY;
  return entries.get(entryKey(prId, headSha)) ?? EMPTY;
}

export function getHunkScanForFile(
  prId: string | null,
  headSha: string | null,
  filePath: string,
): HunkScanRow[] {
  return getHunkScan(prId, headSha).rows.filter((r) => r.filePath === filePath);
}

/**
 * The server decides what an ask means — start the scan, retry a `partial` or
 * `failed` one, rebuild one seeded from an older diff, or just return it — so
 * the client always asks rather than skipping a scan it holds as ended.
 * `pending` (the diff isn't cached yet; the fill has no client-visible event)
 * is asked again on a timer. The answer's rows merge into `entries`.
 */
const asks = createResource<{ prId: string }, EnsureOutcome>({
  retryDelaysMs: [2_500, 2_500, 2_500, 2_500, 2_500],
  gaveUpError: "The PR's diff never reached the cache.",
  fetch: async (key, { prId }): Promise<Answer<EnsureOutcome>> => {
    const since = markEvents(key);
    const { data: result, error, status } = await api.api.reviews({ id: prId })["hunk-scan"].post();
    if (error || !result || "error" in result) {
      return { status: "error", error: `First pass request failed (${status})` };
    }
    if (result.status === "pending") return { status: "pending" };
    if (result.status === "off") return { status: "ok", data: "off" };
    // The server answers for the head it holds, which a pull may have moved.
    const { scan } = result;
    const scanKey = entryKey(prId, scan.headSha);
    updateEntry(scanKey, (entry) =>
      mergeHydratedHunkScan(entry, scan, scanKey === key ? since() : "deltas"),
    );
    return { status: "ok", data: "ready" };
  },
});

/** Ask the server for the scan of the PR's head on screen. */
export function ensureHunkScan(prId: string, headSha: string): Promise<void> {
  return asks.load(entryKey(prId, headSha), { prId }).then(() => undefined);
}

/** Rows that streamed during a dropped connection are gone; re-ask for the PR on screen. */
export function onEventsReconnected(): void {
  const prId = getSelectedPrId();
  const headSha = prId ? getLoadedHeadSha(prId) : null;
  if (prId && headSha) void ensureHunkScan(prId, headSha);
}

export function reset(): void {
  asks.reset();
  entries = new Map();
  eventsSeen.clear();
  startsSeen.clear();
}

function applyEvent(event: HunkScanEventMessage): void {
  const key = entryKey(event.data.prId, event.data.headSha);
  eventsSeen.set(key, (eventsSeen.get(key) ?? 0) + 1);
  if (event.type === "hunk-scan:started") startsSeen.set(key, (startsSeen.get(key) ?? 0) + 1);
  updateEntry(key, (entry) => reduceHunkScanEvent(entry, event));
}

export function onHunkScanStarted(data: HunkScanStartedEnvelope["data"]): void {
  applyEvent({ type: "hunk-scan:started", data });
}

export function onHunkScanHunk(data: HunkScanHunkEnvelope["data"]): void {
  applyEvent({ type: "hunk-scan:hunk", data });
}

export function onHunkScanComplete(data: HunkScanCompleteEnvelope["data"]): void {
  applyEvent({ type: "hunk-scan:complete", data });
}
