// ── First pass derivations ──────────────────────────────────────────────────
//
// Pure helpers over `HunkScanRow` rows. What the review made of each lead
// comes from the verdicts its agent recorded (`resolve_lead`) when the
// walkthrough tracked them. Older and imported walkthroughs carry none, and
// for those it is inferred by overlapping the hunk with the issues.

import {
  flaggedHunkSmells,
  HUNK_SMELL_FLOORS,
  HUNK_SMELLS,
  type HunkRange,
  type HunkScanRow,
  type HunkScanStatus,
  type HunkSmell,
  hunkNewEnd,
  isHunkRowPending,
  type WalkthroughIssue,
  type WalkthroughLead,
} from "@revv/shared";

export type FlaggedSmell = ReturnType<typeof flaggedHunkSmells>[number];

/**
 * What the review made of a hunk's lead:
 * - `confirmed` — it became an issue (an explicit link, or an overlap when untracked).
 * - `withdrawn` — confirmed, but the relevance check or an edit removed its issue.
 * - `rejected` — the agent read it and said why it doesn't hold up.
 * - `unchecked` — handed to the agent, which finished without a verdict.
 * - `not_raised` — untracked walkthrough, finished with no issue on the hunk.
 * - `not_sent` — never handed to the agent: past the lead cap, outside an
 *   incremental review's files, or flagged after the run started.
 * - `pending` — generation is still running.
 */
export type LeadOutcome =
  | { kind: "confirmed"; issueIds: string[] }
  | { kind: "withdrawn" }
  | { kind: "rejected"; reason: string | null }
  | { kind: "unchecked" }
  | { kind: "not_raised" }
  | { kind: "not_sent" }
  | { kind: "pending" };

/** The recorded lead for a scan row, matched on file and hunk position. */
export function leadForRow(
  entry: HunkScanRow,
  leads: readonly WalkthroughLead[],
): WalkthroughLead | undefined {
  return leads.find((l) => l.filePath === entry.filePath && l.hunkIndex === entry.hunkIndex);
}

/**
 * Issues on the row's file whose lines overlap the hunk's new-side range
 * `[newStart, newStart + newLines)`, which is empty for a pure deletion: a
 * hunk with no new-side lines never confirms. An issue without a start line
 * can't be placed, so it never overlaps.
 */
export function overlappingIssueIds(
  entry: HunkScanRow,
  issues: readonly WalkthroughIssue[],
): string[] {
  const hunkEnd = entry.newStart + entry.newLines;
  return issues
    .filter((issue) => {
      if (issue.filePath !== entry.filePath || issue.startLine === undefined) return false;
      const issueEnd = issue.endLine ?? issue.startLine;
      return issue.startLine < hunkEnd && issueEnd >= entry.newStart;
    })
    .map((issue) => issue.id);
}

/**
 * What the review made of a hunk's lead. `leads` is the walkthrough's
 * recorded selection, or null when it never recorded one — then a lead counts
 * as `confirmed` when an issue overlaps the hunk (`overlappingIssueIds`).
 * `isComplete` only decides between the outcomes a finished review can give
 * an unconfirmed lead and `pending`.
 */
export function leadOutcome(
  entry: HunkScanRow,
  issues: readonly WalkthroughIssue[],
  isComplete: boolean,
  leads: readonly WalkthroughLead[] | null,
): LeadOutcome {
  if (leads !== null) {
    const lead = leadForRow(entry, leads);
    if (!lead) return { kind: "not_sent" };
    switch (lead.verdict) {
      case "confirmed": {
        const { issueId } = lead;
        return issueId !== null && issues.some((i) => i.id === issueId)
          ? { kind: "confirmed", issueIds: [issueId] }
          : { kind: "withdrawn" };
      }
      case "rejected":
        return { kind: "rejected", reason: lead.reason };
      case null:
        return isComplete ? { kind: "unchecked" } : { kind: "pending" };
    }
  }
  const issueIds = overlappingIssueIds(entry, issues);
  if (issueIds.length > 0) return { kind: "confirmed", issueIds };
  return isComplete ? { kind: "not_raised" } : { kind: "pending" };
}

/** A one-line account of an outcome, for tooltips. Null where the chip already says it. */
export function leadOutcomeNote(outcome: LeadOutcome): string | null {
  switch (outcome.kind) {
    case "confirmed":
      return "Confirmed by the review.";
    case "withdrawn":
      return "The review confirmed it, but the issue it raised was withdrawn.";
    case "rejected":
      return outcome.reason
        ? `The review checked it and didn't raise it: ${outcome.reason}`
        : "The review checked it and didn't raise it.";
    case "unchecked":
      return "The review finished without giving it a verdict.";
    case "not_raised":
      return "The review didn't raise it.";
    case "not_sent":
      return "Not handed to the review: past the lead cap, outside the files an incremental review covered, or flagged after it started.";
    case "pending":
      return null;
  }
}

/**
 * Skipped because of what the hunk is (generated, deletion-only, …) rather
 * than because the call failed. These never count toward the scan's total.
 */
export function isContentSkip(entry: HunkScanRow): boolean {
  return entry.skipReason !== null && entry.skipReason !== "unscanned";
}

/** `answered` of `total` for "Scanning N of M hunks…"; content skips aren't in either. */
export function scanProgress(rows: readonly HunkScanRow[]): {
  answered: number;
  total: number;
} {
  let answered = 0;
  let total = 0;
  for (const row of rows) {
    if (row.signals !== null) answered += 1;
    if (!isContentSkip(row)) total += 1;
  }
  return { answered, total };
}

export type SmellTone = "danger" | "warning";

export function smellTone(smell: HunkSmell): SmellTone {
  return smell === "vulnerability" ? "danger" : "warning";
}

/** The tone of a hunk's worst flagged smell; null when nothing is flagged. */
export function hunkTone(entry: HunkScanRow): SmellTone | null {
  const flagged = flaggedHunkSmells(entry.signals);
  if (flagged.length === 0) return null;
  return flagged.some((s) => smellTone(s.smell) === "danger") ? "danger" : "warning";
}

/**
 * The row was scanned from the hunk the diff on screen shows at its index.
 * A row from another diff of the same file (a scan seeded before a force-push,
 * say) must not decorate whatever hunk now sits at that position.
 */
export function rowMatchesHunk(
  entry: HunkScanRow,
  hunk: Pick<HunkRange, "newStart" | "newLines">,
): boolean {
  return entry.newStart === hunk.newStart && entry.newLines === hunk.newLines;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** New-side ranges of a unified patch's hunks, in `hunkIndex` order. */
export function patchHunkRanges(patch: string): Array<Pick<HunkRange, "newStart" | "newLines">> {
  const ranges: Array<Pick<HunkRange, "newStart" | "newLines">> = [];
  for (const line of patch.split("\n")) {
    const m = HUNK_HEADER.exec(line);
    if (m) ranges.push({ newStart: Number(m[1]), newLines: m[2] === undefined ? 1 : Number(m[2]) });
  }
  return ranges;
}

/** `L42–68`, or `L42` for a one-line hunk. */
export function hunkRangeLabel(entry: HunkScanRow): string {
  const last = hunkNewEnd(entry);
  return last === entry.newStart ? `L${entry.newStart}` : `L${entry.newStart}–${last}`;
}

export type ScanTickState = "pending" | "unscanned" | "clean" | "warning" | "danger";

/** One tick of the scan ribbon: one hunk, or several neighbours sharing a tick. */
export interface ScanTick {
  state: ScanTickState;
  /**
   * Strongest smell against its floor, `0` (nothing) to `1` (at or past the
   * floor). Only answered hunks contribute; flagged ticks are always `1`.
   */
  level: number;
  /**
   * Flagged hunks over answered hunks. A shared tick showing one lead among
   * ten clean hunks shouldn't stand as tall as a run of ten leads.
   */
  share: number;
  hunks: HunkScanRow[];
}

/** Worst first: a tick shows the most urgent state among its hunks. */
const TICK_PRIORITY: readonly ScanTickState[] = [
  "danger",
  "warning",
  "pending",
  "unscanned",
  "clean",
];

function hunkTickState(entry: HunkScanRow): ScanTickState {
  if (isHunkRowPending(entry)) return "pending";
  if (entry.signals === null) return "unscanned";
  return hunkTone(entry) ?? "clean";
}

function hunkLevel(entry: HunkScanRow): number {
  const { signals } = entry;
  if (signals === null) return 0;
  let level = 0;
  for (const smell of HUNK_SMELLS) {
    level = Math.max(level, Math.min(1, signals[smell] / HUNK_SMELL_FLOORS[smell]));
  }
  return level;
}

/**
 * The hunks the scan covers, in the order the server keeps them (diff order),
 * split into at most `maxTicks` contiguous ticks so the ribbon keeps its size
 * whatever the PR's size. Content skips are left out: they were never going
 * to be scanned.
 */
export function scanTicks(rows: readonly HunkScanRow[], maxTicks: number): ScanTick[] {
  const hunks = rows.filter((row) => !isContentSkip(row));
  const count = Math.min(hunks.length, Math.max(1, Math.floor(maxTicks)));
  return Array.from({ length: count }, (_, i) => {
    const slice = hunks.slice(
      Math.floor((i * hunks.length) / count),
      Math.floor(((i + 1) * hunks.length) / count),
    );
    const tickStates = slice.map(hunkTickState);
    const states = new Set(tickStates);
    const state = TICK_PRIORITY.find((s) => states.has(s)) ?? "clean";
    const flagged = tickStates.filter((s) => s === "warning" || s === "danger").length;
    const answered = slice.filter((row) => row.signals !== null).length;
    return {
      state,
      level: Math.max(0, ...slice.map(hunkLevel)),
      share: answered === 0 ? 0 : flagged / answered,
      hunks: slice,
    };
  });
}

/** A flagged hunk the review hasn't raised an issue on (yet, while it runs). */
export interface UnraisedLead {
  row: HunkScanRow;
  smells: FlaggedSmell[];
  outcome: LeadOutcome;
}

function leadKey(lead: UnraisedLead): number {
  const top = lead.smells[0];
  return top ? (smellTone(top.smell) === "danger" ? 2 : 1) + top.probability : 0;
}

/** What the review made of the first pass, from one walk over the flagged rows. */
interface FirstPassReview {
  /**
   * Flagged hunks no live issue confirms, vulnerabilities first, then
   * strongest smell first. The leads the review did take up show on their
   * issue instead.
   */
  unraised: UnraisedLead[];
  /** Per issue, the smells the first pass flagged on the hunks it confirmed. */
  smellsByIssue: Map<string, HunkSmell[]>;
}

function reviewFirstPass(
  rows: readonly HunkScanRow[],
  issues: readonly WalkthroughIssue[],
  isComplete: boolean,
  leads: readonly WalkthroughLead[] | null,
): FirstPassReview {
  const unraised: UnraisedLead[] = [];
  const byIssue = new Map<string, Set<HunkSmell>>();
  for (const row of rows) {
    const smells = flaggedHunkSmells(row.signals);
    if (smells.length === 0) continue;
    const outcome = leadOutcome(row, issues, isComplete, leads);
    if (outcome.kind !== "confirmed") {
      unraised.push({ row, smells, outcome });
      continue;
    }
    for (const id of outcome.issueIds) {
      const set = byIssue.get(id) ?? new Set<HunkSmell>();
      for (const { smell } of smells) set.add(smell);
      byIssue.set(id, set);
    }
  }
  return {
    unraised: unraised.sort((a, b) => leadKey(b) - leadKey(a)),
    smellsByIssue: new Map(
      Array.from(byIssue, ([id, set]) => [id, HUNK_SMELLS.filter((smell) => set.has(smell))]),
    ),
  };
}

/** Everything the walkthrough shows of the first pass, for one head. */
export interface FirstPassView extends FirstPassReview {
  /** Empty when there's no first pass to show. */
  rows: readonly HunkScanRow[];
  running: boolean;
  /** `Scanning 3 of 12`, while it runs. */
  scanning: string;
  /** What it found once over: `4 leads in 12 hunks`, or `of 12` for a partial scan. */
  result: string;
  /** Why the scan didn't cover the whole diff, when it didn't. */
  note: string | null;
  /** Something folds under the issues: unraised leads, or the note. */
  hasLeads: boolean;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function firstPassView(
  rows: readonly HunkScanRow[],
  status: HunkScanStatus | null,
  issues: readonly WalkthroughIssue[],
  isComplete: boolean,
  leads: readonly WalkthroughLead[] | null,
): FirstPassView {
  const review = reviewFirstPass(rows, issues, isComplete, leads);
  const { answered, total } = scanProgress(rows);
  const flagged = rows.filter((row) => flaggedHunkSmells(row.signals).length > 0).length;
  const unscanned = rows.filter((row) => row.skipReason === "unscanned").length;
  const partial = status === "partial";
  const covered = `${partial ? `${answered} of ${total}` : answered} ${plural(partial ? total : answered, "hunk", "hunks")}`;
  const note = partial
    ? `TypeSafe stopped answering, so ${unscanned} ${plural(unscanned, "hunk was", "hunks were")} never judged.`
    : null;
  return {
    ...review,
    rows,
    running: status === "running",
    scanning: `Scanning ${answered} of ${total}`,
    result: `${flagged === 0 ? "No" : flagged} ${plural(flagged, "lead", "leads")} in ${covered}`,
    note,
    hasLeads: review.unraised.length > 0 || note !== null,
  };
}
