import { describe, expect, it } from "bun:test";
import type { HunkScanEventMessage, HunkScanRow, HunkScanStatus, HunkSmell } from "@revv/shared";
import {
  type EventsSinceAsked,
  mergeHydratedHunkScan,
  reduceHunkScanEvent,
} from "./hunk-scan-reducers";

const SIGNALS: Record<HunkSmell, number> = {
  vulnerability: 0.1,
  over_defensive: 0.1,
  silent_failure: 0.1,
  slop: 0.8,
  over_engineered: 0.1,
  hard_to_read: 0.1,
  unclean: 0.1,
  verbose_comment: 0.1,
  redundant_test: 0.1,
};

function row(over: Partial<HunkScanRow> = {}): HunkScanRow {
  return {
    filePath: "a.ts",
    hunkIndex: 0,
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    skipReason: null,
    signals: null,
    scannedAt: null,
    ...over,
  };
}

// Frozen like `updateEntryInMap` freezes entry fields: any in-place write throws.
function frozen(rows: HunkScanRow[]): readonly HunkScanRow[] {
  return Object.freeze(rows);
}

const HEAD = { prId: "pr", headSha: "abc" };

const started = (rows: HunkScanRow[]): HunkScanEventMessage => ({
  type: "hunk-scan:started",
  data: { ...HEAD, rows },
});
const hunk = (r: HunkScanRow): HunkScanEventMessage => ({
  type: "hunk-scan:hunk",
  data: { ...HEAD, row: r },
});
const complete = (status: "complete" | "partial" | "failed"): HunkScanEventMessage => ({
  type: "hunk-scan:complete",
  data: { ...HEAD, status, scanned: 0, flagged: 0, durationMs: 0 },
});

describe("reduceHunkScanEvent", () => {
  it("started replaces a partial scan's rows instead of merging into them", () => {
    const partial = {
      rows: frozen([
        row({ signals: SIGNALS }),
        row({ hunkIndex: 1, skipReason: "unscanned" }),
        row({ hunkIndex: 2, skipReason: "unscanned" }),
      ]),
      status: "partial" as const,
    };
    // The retry runs on a rebuilt diff: two hunks now, none answered yet.
    const next = reduceHunkScanEvent(partial, started([row(), row({ hunkIndex: 1 })]));
    expect(next.status).toBe("running");
    expect(next.rows.map((r) => [r.hunkIndex, r.signals, r.skipReason])).toEqual([
      [0, null, null],
      [1, null, null],
    ]);
  });

  it("hunk upserts on (filePath, hunkIndex) without mutating", () => {
    const state = { rows: frozen([row(), row({ hunkIndex: 1 })]), status: "running" as const };
    const answered = row({ hunkIndex: 1, signals: SIGNALS });
    const next = reduceHunkScanEvent(state, hunk(answered));
    expect(next.rows).not.toBe(state.rows);
    expect(next.rows[1]).toBe(answered);
    expect(next.rows).toHaveLength(2);
    expect(next.status).toBe("running");

    expect(reduceHunkScanEvent(state, hunk(row({ filePath: "b.ts" }))).rows).toHaveLength(3);
  });

  it("complete flips only unresolved rows to unscanned", () => {
    const rows = frozen([
      row(),
      row({ hunkIndex: 1, signals: SIGNALS }),
      row({ hunkIndex: 2, skipReason: "generated" }),
    ]);
    const next = reduceHunkScanEvent({ rows, status: "running" }, complete("partial"));
    expect(next.status).toBe("partial");
    expect(next.rows.map((r) => r.skipReason)).toEqual(["unscanned", null, "generated"]);
    expect(next.rows[1]).toBe(rows[1]);
  });

  it("a failed scan drops every row, as the server did", () => {
    const rows = frozen([row({ signals: SIGNALS }), row({ hunkIndex: 1 })]);
    expect(reduceHunkScanEvent({ rows, status: "running" }, complete("failed"))).toEqual({
      rows: [],
      status: "failed",
    });
  });
});

describe("mergeHydratedHunkScan", () => {
  const merge = (
    entryRows: HunkScanRow[],
    snapshotRows: HunkScanRow[],
    {
      entry = null,
      snapshot = "running",
      since = "deltas",
    }: {
      entry?: HunkScanStatus | null;
      snapshot?: HunkScanStatus | null;
      since?: EventsSinceAsked;
    } = {},
  ) =>
    mergeHydratedHunkScan(
      { rows: entryRows, status: entry },
      { rows: snapshotRows, status: snapshot },
      since,
    );

  describe("with no events since the ask", () => {
    it("replaces the entry with the snapshot, so a retried partial scan runs again", () => {
      const merged = merge(
        [row({ skipReason: "unscanned" }), row({ hunkIndex: 1, signals: SIGNALS })],
        [row(), row({ hunkIndex: 1, signals: SIGNALS })],
        { entry: "partial", snapshot: "running", since: "none" },
      );
      expect(merged.status).toBe("running");
      expect(merged.rows.map((r) => r.skipReason)).toEqual([null, null]);
    });

    it("drops rows the snapshot no longer has (a scan rebuilt from a newer diff)", () => {
      const merged = merge([row({ hunkIndex: 3 })], [row()], { since: "none" });
      expect(merged.rows.map((r) => r.hunkIndex)).toEqual([0]);
    });

    it("shows no rows for a failed scan", () => {
      expect(
        merge([row({ signals: SIGNALS })], [row()], { since: "none", snapshot: "failed" }),
      ).toEqual({
        rows: [],
        status: "failed",
      });
    });
  });

  it("keeps the entry when a run started while the snapshot was in flight", () => {
    const fresh = [row(), row({ hunkIndex: 1 })];
    const merged = merge(fresh, [row({ skipReason: "unscanned" })], {
      entry: "running",
      snapshot: "partial",
      since: "started",
    });
    expect(merged).toEqual({ rows: fresh, status: "running" });
  });

  describe("with deltas since the ask", () => {
    it("prefers resolved entry rows over a stale snapshot", () => {
      const { rows } = merge([row({ signals: SIGNALS })], [row(), row({ hunkIndex: 1 })]);
      expect(rows.map((r) => r.signals !== null)).toEqual([true, false]);
    });

    it("keeps a snapshot answer over an unresolved entry row", () => {
      const { rows } = merge([row()], [row({ signals: SIGNALS })]);
      expect(rows[0]?.signals).toEqual(SIGNALS);
    });

    it("keeps entry rows the snapshot doesn't have", () => {
      expect(merge([row({ filePath: "b.ts" })], []).rows).toHaveLength(1);
    });

    it("lets an ended status beat `running` from either side", () => {
      expect(merge([], [], { entry: "partial", snapshot: "running" }).status).toBe("partial");
      expect(merge([], [], { entry: "running", snapshot: "complete" }).status).toBe("complete");
      expect(merge([], [], { entry: null, snapshot: null }).status).toBeNull();
    });

    it("shows no rows for a failed scan, whatever the client still held", () => {
      const merged = merge([row({ signals: SIGNALS })], [], { snapshot: "failed" });
      expect(merged).toEqual({ rows: [], status: "failed" });
    });
  });
});
