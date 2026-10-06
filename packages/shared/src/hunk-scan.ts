// ── First pass: per-hunk smell scan ─────────────────────────────────────────
//
// One scan per PR head SHA: the orchestrator asks Jev to judge every
// substantive hunk against nine smells, starting when the review page opens
// (or when a walkthrough job needs it first). The answers are probabilities
// only — no prose, no line spans — so they reach the agent as leads to verify
// and the UI as a separate layer of the review. Floors live here because both
// sides apply them: the server to pick prompt leads, the web to decide what a
// chip shows.

export const HUNK_SMELLS = [
  "vulnerability",
  "over_defensive",
  "silent_failure",
  "slop",
  "over_engineered",
  "hard_to_read",
  "unclean",
  "verbose_comment",
  "redundant_test",
] as const;

export type HunkSmell = (typeof HUNK_SMELLS)[number];

/**
 * Probability at or above which a smell counts as flagged. Calibrated against
 * jev-1.13.0 on 162 hunks from this repo's own PRs plus planted controls:
 * planted smells score 0.8+, clean code stays under 0.35, and real hunks
 * rarely clear 0.6. `vulnerability` sits lower because a missed one costs more
 * than a false lead; `unclean` higher because it fires alongside every other
 * smell and on generated SQL. `redundant_test` (test files only) is lower: on
 * 44 real test hunks it never passed 0.34, while planted redundant tests
 * scored 0.60–0.85, the weakest (a test that only checks `toBeDefined`) right
 * at 0.60. `verbose_comment` sits above the default: padded comments scored
 * 0.93+, but this repo's own rationale-heavy comments reached 0.58 on a
 * two-line comment that earned its length.
 */
export const HUNK_SMELL_FLOORS: Readonly<Record<HunkSmell, number>> = {
  vulnerability: 0.5,
  over_defensive: 0.6,
  silent_failure: 0.6,
  slop: 0.6,
  over_engineered: 0.6,
  hard_to_read: 0.6,
  unclean: 0.7,
  verbose_comment: 0.65,
  redundant_test: 0.55,
};

export const HUNK_SMELL_META: Readonly<
  Record<HunkSmell, { readonly label: string; readonly description: string }>
> = {
  vulnerability: { label: "Vulnerability", description: "A security flaw visible in the hunk." },
  over_defensive: {
    label: "Over-defensive",
    description: "Guards against conditions that cannot happen.",
  },
  silent_failure: {
    label: "Silent failure",
    description: "An error swallowed without surfacing it.",
  },
  slop: { label: "Slop", description: "Careless, generated-looking code." },
  over_engineered: {
    label: "Over-engineered",
    description: "More abstraction than the change needs.",
  },
  hard_to_read: { label: "Hard to read", description: "A careful reader would have to reread it." },
  unclean: { label: "Unclean", description: "Sloppy in form even if it works." },
  verbose_comment: {
    label: "Long comment",
    description: "A comment far longer than what it has to say.",
  },
  redundant_test: {
    label: "Redundant test",
    description: "A test that adds little coverage and could be deleted.",
  },
};

/**
 * Why a hunk has no answer. `unscanned` is the one reason that isn't a content
 * decision: the scan stopped early because Jev stopped answering.
 */
export const HUNK_SKIP_REASONS = ["generated", "deletion_only", "no_patch", "unscanned"] as const;

export type HunkSkipReason = (typeof HUNK_SKIP_REASONS)[number];

/**
 * The first pass as a whole, persisted on its `hunk_scans` row. `running` until
 * it ends; then `complete` (every hunk answered), `partial` (Jev stopped
 * answering partway, and the rest are `unscanned`), or `failed` (Jev answered
 * nothing, so the rows are gone and the walkthrough reads as if the pass had
 * never run).
 */
export const HUNK_SCAN_STATUSES = ["running", "complete", "partial", "failed"] as const;

export type HunkScanStatus = (typeof HUNK_SCAN_STATUSES)[number];

/** A scan that answered at least one hunk and stopped: its rows are final for this run. */
export function isHunkScanFinished(status: HunkScanStatus | null): boolean {
  return status === "complete" || status === "partial";
}

/** A hunk's span in the unified diff, as its `@@` header gives it. */
export interface HunkRange {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Last new-side line of a hunk; a pure deletion still names the line it sits at. */
export function hunkNewEnd(range: Pick<HunkRange, "newStart" | "newLines">): number {
  return range.newStart + Math.max(range.newLines, 1) - 1;
}

/** One hunk of the first pass, as persisted in `hunk_scan_rows`. */
export interface HunkScanRow extends HunkRange {
  filePath: string;
  /** Position among the file's `@@` hunks — the same index `@pierre/diffs` assigns. */
  hunkIndex: number;
  /** Null for a hunk that is (or will be) scanned. */
  skipReason: HunkSkipReason | null;
  /** Null until Jev answers. */
  signals: Record<HunkSmell, number> | null;
  scannedAt: string | null;
}

/** A hunk's identity within one scan: its file and its position there. */
export function hunkKey(row: { readonly filePath: string; readonly hunkIndex: number }): string {
  return `${row.filePath}\0${row.hunkIndex}`;
}

/** A hunk the scan means to ask about and hasn't heard back on yet. */
export function isHunkRowPending(row: {
  readonly signals: unknown;
  readonly skipReason: unknown;
}): boolean {
  return row.signals === null && row.skipReason === null;
}

/** The first pass for one PR head, as persisted. `status` is null when it never ran. */
export interface HunkScanSnapshot {
  headSha: string;
  status: HunkScanStatus | null;
  rows: HunkScanRow[];
}

/**
 * `POST /api/reviews/:id/hunk-scan`. `off` when TypeSafe is off or has no key;
 * `pending` until the PR's diff is cached (the client retries); otherwise the
 * scan for the PR's current head, started if it hadn't been.
 */
export type HunkScanEnsureResult =
  | { status: "off" }
  | { status: "pending" }
  | { status: "ready"; scan: HunkScanSnapshot };

/** Smells at or above their floor, strongest first. */
export function flaggedHunkSmells(
  signals: Readonly<Record<HunkSmell, number>> | null,
): Array<{ readonly smell: HunkSmell; readonly probability: number }> {
  if (signals === null) return [];
  return HUNK_SMELLS.flatMap((smell) => {
    const probability = signals[smell];
    return probability >= HUNK_SMELL_FLOORS[smell] ? [{ smell, probability }] : [];
  }).sort((a, b) => b.probability - a.probability);
}

/** What the review made of a lead: it held up and became an issue, or it didn't. */
export type LeadVerdict = "confirmed" | "rejected";

/**
 * A first-pass lead as one walkthrough's agent was handed it, and the
 * agent's verdict once it gave one (`resolve_lead`).
 */
export interface WalkthroughLead {
  /** `L1`…`Ln`, strongest first: the id the agent resolves it by. */
  id: string;
  filePath: string;
  hunkIndex: number;
  newStart: number;
  newLines: number;
  smells: Array<{ smell: HunkSmell; probability: number }>;
  /** Null until the agent resolves it. */
  verdict: LeadVerdict | null;
  /** The issue a confirmed lead raised; null once that issue is withdrawn or deleted. */
  issueId: string | null;
  /** Why a rejected lead didn't hold up, in the agent's words. */
  reason: string | null;
}
