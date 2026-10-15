// ── First pass reducers ─────────────────────────────────────────────────────
//
// Plain module (no runes) so the `hunk-scan:*` reducer and the hydrate merge
// are unit-testable, same as `walkthrough-entry-equal.ts`. Every function
// returns new arrays, never touching the ones it was given, so a store that
// reassigns its entry sees the change.

import {
  type HunkScanEventMessage,
  type HunkScanRow,
  type HunkScanStatus,
  hunkKey,
  isHunkRowPending,
  isHunkScanFinished,
} from "@revv/shared";

type Rows = readonly HunkScanRow[];

interface ScanState {
  readonly rows: Rows;
  readonly status: HunkScanStatus | null;
}

/**
 * One `hunk-scan:*` event applied to a head's scan.
 * - `started` is full-state: its rows replace whatever the head held, including
 *   a `partial` scan being retried or a scan rebuilt from a newer diff.
 * - `hunk` is a delta, upserted on `(filePath, hunkIndex)`.
 * - `complete` leaves the rows as the server did: on `failed` it deleted them,
 *   so the first pass disappears; otherwise whatever Jev never answered is now
 *   `unscanned`.
 */
export function reduceHunkScanEvent(
  state: ScanState,
  event: HunkScanEventMessage,
): { rows: HunkScanRow[]; status: HunkScanStatus | null } {
  switch (event.type) {
    case "hunk-scan:started":
      return { rows: [...event.data.rows], status: "running" };
    case "hunk-scan:hunk": {
      const { row } = event.data;
      const key = hunkKey(row);
      const idx = state.rows.findIndex((r) => hunkKey(r) === key);
      const rows =
        idx >= 0 ? state.rows.map((r, i) => (i === idx ? row : r)) : [...state.rows, row];
      return { rows, status: state.status };
    }
    case "hunk-scan:complete": {
      const { status } = event.data;
      if (status === "failed") return { rows: [], status };
      return {
        rows: state.rows.map((r) => (isHunkRowPending(r) ? { ...r, skipReason: "unscanned" } : r)),
        status,
      };
    }
  }
}

/** What reached a head over SSE while its snapshot was in flight. */
export type EventsSinceAsked = "none" | "deltas" | "started";

/**
 * Hydrate merge, by what SSE delivered while the snapshot was in flight:
 * - `none`: the snapshot is the newer word and replaces the entry outright —
 *   that is how a `partial` scan the server is retrying goes back to `running`.
 * - `started`: a new run began and its rows replaced the entry; the snapshot
 *   is either older than that or no newer than the stream, so the entry stands.
 * - `deltas`: either side may be newer. Snapshot rows form the base; a row the
 *   client holds wins when it is answered or skipped or when the snapshot
 *   doesn't have it; and a status the client saw end beats `running`.
 * A `failed` scan has no rows whatever the client held.
 */
export function mergeHydratedHunkScan(
  entry: ScanState,
  snapshot: ScanState,
  since: EventsSinceAsked,
): { rows: HunkScanRow[]; status: HunkScanStatus | null } {
  if (since === "started") return { rows: [...entry.rows], status: entry.status };
  if (since === "none") {
    const { status } = snapshot;
    return { rows: status === "failed" ? [] : [...snapshot.rows], status };
  }
  const entryEnded = entry.status === "failed" || isHunkScanFinished(entry.status);
  const status = entryEnded ? entry.status : (snapshot.status ?? entry.status);
  if (status === "failed") return { rows: [], status };
  const merged = new Map<string, HunkScanRow>();
  for (const r of snapshot.rows) merged.set(hunkKey(r), r);
  for (const r of entry.rows) {
    const key = hunkKey(r);
    if (!isHunkRowPending(r) || !merged.has(key)) merged.set(key, r);
  }
  return { rows: Array.from(merged.values()), status };
}
