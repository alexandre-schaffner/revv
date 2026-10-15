// ── First-pass leads, per walkthrough ───────────────────────────────────────
//
// Which leads one walkthrough's agent was handed, and its verdict on each.
// The orchestrator records the selection once, at the first job start
// (invariant 2's carve-out): a resume prompts with the rows already here, so
// the agent resolves the same ids it saw before the crash. Verdicts are the
// agent's, written only through the `resolve_lead` MCP tool.

import {
  HUNK_SMELLS,
  type HunkScanRow,
  type HunkSmell,
  hunkNewEnd,
  type LeadVerdict,
  type WalkthroughLead,
} from "@revv/shared";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { type HunkLead, hunkScanLeads } from "../ai/jev/hunk-scan";
import type { Db } from "../db";
import { walkthroughLeads } from "../db/schema/walkthrough-leads";
import { walkthroughs } from "../db/schema/walkthroughs";
import { DbError } from "../domain/errors";
import { logError } from "../logger";
import { splitHunks } from "./diff-anchors";
import type { PromptFilesResult } from "./walkthrough-prompt-files";

type Row = typeof walkthroughLeads.$inferSelect;

const SMELLS: ReadonlySet<string> = new Set(HUNK_SMELLS);

function isSmell(value: unknown): value is HunkSmell {
  return typeof value === "string" && SMELLS.has(value);
}

function parseSmells(raw: string): WalkthroughLead["smells"] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return [];
      const smell: unknown = Reflect.get(entry, "smell");
      const probability: unknown = Reflect.get(entry, "probability");
      return isSmell(smell) && typeof probability === "number" ? [{ smell, probability }] : [];
    });
  } catch {
    return [];
  }
}

function parseVerdict(value: string | null): LeadVerdict | null {
  return value === "confirmed" || value === "rejected" ? value : null;
}

function rowToLead(row: Row): WalkthroughLead {
  return {
    id: row.leadKey,
    filePath: row.filePath,
    hunkIndex: row.hunkIndex,
    newStart: row.newStart,
    newLines: row.newLines,
    smells: parseSmells(row.smells),
    verdict: parseVerdict(row.verdict),
    issueId: row.issueId,
    reason: row.reason,
  };
}

/** The lead id the agent sees for the lead at `ordinal`. */
export function leadKeyAt(ordinal: number): string {
  return `L${ordinal + 1}`;
}

/** This walkthrough's leads in prompt order. Empty when none were recorded. */
export function readWalkthroughLeads(db: Db, walkthroughId: string): WalkthroughLead[] {
  return db
    .select()
    .from(walkthroughLeads)
    .where(eq(walkthroughLeads.walkthroughId, walkthroughId))
    .orderBy(asc(walkthroughLeads.ordinal))
    .all()
    .map(rowToLead);
}

/** One of this walkthrough's leads by the id the agent resolves it by. */
export function readWalkthroughLead(
  db: Db,
  walkthroughId: string,
  leadKey: string,
): WalkthroughLead | undefined {
  const row = db
    .select()
    .from(walkthroughLeads)
    .where(
      and(eq(walkthroughLeads.walkthroughId, walkthroughId), eq(walkthroughLeads.leadKey, leadKey)),
    )
    .get();
  return row && rowToLead(row);
}

/**
 * A previous run already recorded this walkthrough's selection, so a resume
 * is prompted with it and has no use for the scan's rows.
 */
export function leadsRecorded(db: Db, walkthroughId: string): boolean {
  const row = db
    .select({ leadsSelectedAt: walkthroughs.leadsSelectedAt })
    .from(walkthroughs)
    .where(eq(walkthroughs.id, walkthroughId))
    .get();
  return row?.leadsSelectedAt != null;
}

/**
 * The leads for the walkthrough DTO: null when the row never recorded a
 * selection (it predates lead tracking, or came from the remote cache).
 */
export function loadWalkthroughLeads(
  db: Db,
  walkthroughId: string,
  leadsSelectedAt: string | null,
): WalkthroughLead[] | null {
  return leadsSelectedAt === null ? null : readWalkthroughLeads(db, walkthroughId);
}

/**
 * Record `candidates` as this walkthrough's leads, unless a previous run
 * already recorded a selection — then that one stands, verdicts included.
 * Returns what the agent should be prompted with. One transaction, so a
 * `kill -9` leaves either no selection or all of it.
 */
export function recordWalkthroughLeads(
  db: Db,
  walkthroughId: string,
  candidates: readonly HunkLead[],
): WalkthroughLead[] {
  return db.transaction(() => {
    const row = db
      .select({ leadsSelectedAt: walkthroughs.leadsSelectedAt })
      .from(walkthroughs)
      .where(eq(walkthroughs.id, walkthroughId))
      .get();
    if (!row) return [];
    if (row.leadsSelectedAt !== null) return readWalkthroughLeads(db, walkthroughId);
    candidates.forEach((lead, ordinal) => {
      db.insert(walkthroughLeads)
        .values({
          id: `${walkthroughId}:${leadKeyAt(ordinal)}`,
          walkthroughId,
          leadKey: leadKeyAt(ordinal),
          ordinal,
          filePath: lead.filePath,
          hunkIndex: lead.hunkIndex,
          newStart: lead.newStart,
          newLines: lead.newLines,
          smells: JSON.stringify(lead.smells),
        })
        .onConflictDoNothing()
        .run();
    });
    db.update(walkthroughs)
      .set({ leadsSelectedAt: new Date().toISOString() })
      .where(eq(walkthroughs.id, walkthroughId))
      .run();
    return readWalkthroughLeads(db, walkthroughId);
  });
}

/**
 * The scan rows the prompt actually shows. The scan always covers the full PR;
 * an incremental review's prompt holds only its range, so there a row counts
 * only where it overlaps a hunk of that range's patch — a lead elsewhere would
 * ask the agent for a verdict on code it was never shown.
 */
export function rowsInPrompt(
  rows: readonly HunkScanRow[],
  prompt: PromptFilesResult,
): HunkScanRow[] {
  if (prompt.diffSource !== "incremental_range") {
    const names = new Set(prompt.files.map((f) => f.filename));
    return rows.filter((row) => names.has(row.filePath));
  }
  const ranges = new Map(
    prompt.files.map((f) => [f.filename, f.patch === null ? [] : splitHunks(f.patch)]),
  );
  return rows.filter((row) =>
    (ranges.get(row.filePath) ?? []).some(
      (hunk) => hunk.newStart <= hunkNewEnd(row) && row.newStart <= hunkNewEnd(hunk),
    ),
  );
}

/**
 * The leads a run's agent is prompted with: the scan's flagged hunks the
 * prompt shows (`rowsInPrompt`), recorded before the first prompt so the verdicts
 * `resolve_lead` writes always have a row to land on (a resume reads the same
 * set back). Leads are hints, so a failure to record them yields none: a
 * review without them beats no review.
 */
export function prepareFirstPassLeads(
  db: Db,
  walkthroughId: string,
  scanRows: readonly HunkScanRow[],
  prompt: PromptFilesResult,
): Effect.Effect<WalkthroughLead[]> {
  const shown = rowsInPrompt(scanRows, prompt);
  return Effect.try({
    try: () =>
      recordWalkthroughLeads(
        db,
        walkthroughId,
        hunkScanLeads(shown, new Set(shown.map((row) => row.filePath))),
      ),
    catch: (cause) => new DbError({ message: "recordWalkthroughLeads failed", cause }),
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        logError("walkthrough-jobs", "recording first-pass leads failed", e);
        return [];
      }),
    ),
  );
}
