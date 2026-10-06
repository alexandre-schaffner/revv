import { HUNK_SCAN_STATUSES, HUNK_SKIP_REASONS } from "@revv/shared";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pullRequests } from "./pull-requests";

/**
 * The first pass for one PR head: the scan's lifecycle, `'running'` from the
 * seed onward, then `'complete' | 'partial' | 'failed'`. Independent of any
 * walkthrough — the review page starts it, and a walkthrough job for the same
 * head reuses it. Orchestrator-owned (CLAUDE.md invariant 2 carve-out).
 */
export const hunkScans = sqliteTable(
  "hunk_scans",
  {
    id: text("id").primaryKey(),
    prId: text("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    status: text("status", { enum: HUNK_SCAN_STATUSES }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_hunk_scans_pr_head").on(t.prId, t.headSha)],
);

/**
 * One row per hunk the scan considered. Seeded up front (skipped hunks
 * included), so the total and progress survive a `kill -9`; `signals` is
 * filled in as Jev answers. Never written by an MCP tool.
 */
export const hunkScanRows = sqliteTable(
  "hunk_scan_rows",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => hunkScans.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    /** Position among the file's hunks — the index `@pierre/diffs` and `hunk_decisions` use. */
    hunkIndex: integer("hunk_index").notNull(),
    oldStart: integer("old_start").notNull(),
    oldLines: integer("old_lines").notNull(),
    newStart: integer("new_start").notNull(),
    newLines: integer("new_lines").notNull(),
    /** sha1 of model + path + status + hunk body: a seed whose hash changed is a different hunk. */
    contentHash: text("content_hash").notNull(),
    skipReason: text("skip_reason", { enum: HUNK_SKIP_REASONS }),
    signals: text("signals"), // JSON Record<HunkSmell, number> | null
    scannedAt: text("scanned_at"),
  },
  (t) => [uniqueIndex("uq_hunk_scan_rows_scan_file_hunk").on(t.scanId, t.filePath, t.hunkIndex)],
);
