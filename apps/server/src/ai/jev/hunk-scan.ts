// ── First pass: per-hunk smell scan ─────────────────────────────────────────
//
// Before the agent starts, every substantive hunk gets one Jev call asking
// eight yes/no questions, nine in a test file. Nothing here gates anything: the flags reach the
// agent as leads it must verify (see `hunkScanLeads`), and the UI as their own
// layer. Leads rather than locked verdicts on purpose — Jev can't see past the
// hunk, and a verdict the agent must adjudicate doubles the work it replaces.
//
// Per-hunk rather than per-file: a hunk is the unit a reviewer reads, and the
// state stays small enough that an answer depends on the hunk's content alone,
// which is what makes it cacheable across commits.

import { createHash } from "node:crypto";
import {
  flaggedHunkSmells,
  HUNK_SMELLS,
  type HunkScanRow,
  type HunkSkipReason,
  type HunkSmell,
  type WalkthroughLead,
} from "@revv/shared";
import { noul } from "@typesafe-ai/sdk";
import { Deferred, Effect } from "effect";
import { type DbError, JevUnavailable } from "../../domain/errors";
import { CacheService } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import { type PatchHunk, splitHunks } from "../../services/diff-anchors";
import type { HunkScanSeed } from "../../services/hunk-scan-store";
import { JEV_MODEL, JevService } from "../../services/Jev";
import { optionalJev } from "./optional";
import { numericAnswerAt } from "./questions";
import { buildHunkScanState, type FileLike, HUNK_PATCH_MAX_CHARS } from "./state";

/**
 * Ceiling for one call. Answers land in well under a second, so this only
 * matters when Jev hangs — and then the breaker below stops the scan after a
 * few rounds rather than letting every hunk wait out its own timeout.
 */
const HUNK_SCAN_CALL_TIMEOUT_MS = 5_000;

/** Calls in flight. `JevService` paces the whole process under the request quota. */
const HUNK_SCAN_CONCURRENCY = 8;

/**
 * Failures in a row, with no success between, that mean Jev is down rather
 * than blipping. Only a call sent after the last counted failure counts, so
 * one stall that fails every call in flight at once counts once.
 */
const HUNK_SCAN_BREAKER_FAILURES = 3;

/** Retries for one window: one for a failure, a few more for a 429, which says when to come back. */
const HUNK_SCAN_RETRIES = 1;
const HUNK_SCAN_RATE_LIMIT_RETRIES = 4;

/** Pause after a 429 that didn't say how long to wait. */
const HUNK_SCAN_RATE_LIMIT_PAUSE_MS = 2_000;

/** Most leads handed to the agent; past this the list reads as a checklist rather than hints. */
export const HUNK_SCAN_MAX_LEADS = 30;

/**
 * Leads each flagged smell is guaranteed before strength fills the rest of
 * the cap. Smells score on different scales — a padded comment tops out
 * near 0.7 while a swallowed error reaches 0.9 — so ranking on strength
 * alone would cut every readability lead from a large PR.
 */
export const HUNK_SCAN_LEADS_PER_SMELL = 3;

/**
 * Cache namespace; entries are immutable because the key is the content.
 * Bump the version when the questions change — an old answer is to a
 * different question.
 */
const HUNK_SCAN_CACHE_NS = "jev:hunk-scan:v4";

/** Closing line on every question: an answer Jev can't ground in the hunk must be no. */
const HUNK_ONLY =
  "Judge only the added lines, and only what this hunk shows. If the judgment depends on code that is not visible here, answer no.";

const ask = (instructions: string, yes: string, no: string) =>
  noul(`${instructions} ${HUNK_ONLY}`, { true: yes, false: no });

/** Asked of every hunk. */
const CODE_QUESTIONS = {
  vulnerability: ask(
    "Do the added lines in `hunk.patch` introduce a security vulnerability?",
    "A concrete flaw is visible: injection into SQL, a shell, a path, or HTML; a secret or credential in code; an authentication or authorization check removed or bypassed; eval or unsafe deserialization of untrusted input; TLS verification or crypto weakened.",
    "The code merely touches security-sensitive ground, or the flaw would only exist given callers or configuration the hunk does not show.",
  ),
  over_defensive: ask(
    "Do the added lines guard against conditions that cannot happen?",
    "Redundant null or type checks on values the hunk itself just built or already checked, try/catch around code that cannot throw, the same input validated twice, fallbacks for values that are required, or paranoid branches that bury the main path.",
    "The checks sit at a genuine trust boundary — user input, the network, the file system, a parser — or the hunk does not show enough to tell.",
  ),
  silent_failure: ask(
    "Do the added lines swallow a failure without surfacing it?",
    "An empty catch, a catch that returns a default or null without logging or rethrowing, an ignored promise rejection, a `?? []` or `|| {}` that hides an operation that failed, or an error logged and then dropped where the caller needed to know.",
    "Errors propagate or are reported, or the fallback is plainly intended and the failure harmless.",
  ),
  slop: ask(
    "Do the added lines read as careless, generated code?",
    "Comments that narrate what each line does, leftover placeholder or TODO text, stray debug output, dead code or unused variables, duplicated blocks, hedging comments, or names like `data2`, `tempResult`, `handleStuff`.",
    "The code is spare, and its comments, if any, explain why rather than what.",
  ),
  over_engineered: ask(
    "Do the added lines introduce more machinery than the change needs?",
    "An interface, factory, generic, option, or layer with a single use; indirection a direct call would replace; a general mechanism built for one case.",
    "Each abstraction has several uses visible in the hunk, or the code is as direct as the problem allows.",
  ),
  hard_to_read: ask(
    "Would a careful reader have to stop and reread the added lines to follow them?",
    "Deep nesting, one function doing several things, clever one-liners, unclear names, magic numbers, boolean arguments whose meaning is invisible at the call site, or control flow that jumps around.",
    "The code is straightforward, even if it is long.",
  ),
  unclean: ask(
    "Are the added lines sloppy in form, even if they work?",
    "Naming or structure inconsistent within the hunk, commented-out code, unrelated concerns mixed in one function, copy-pasted logic with small variations, or reaching into another module's internals.",
    "The code is tidy; any differences are ones a formatter would settle.",
  ),
  verbose_comment: ask(
    "Is a comment in the added lines far longer than what it has to say?",
    "Half of it could go without losing anything a future reader needs: it restates what the code plainly does, narrates how the change came about or what the code used to do, repeats the same point in several phrasings, explains language or library basics, or runs to a paragraph over a line whose purpose is obvious.",
    "The comments are short, or their length carries a reason the code cannot express — an invariant, a trade-off, a non-obvious constraint, the bug a branch prevents. A long comment that earns every sentence is not this.",
  ),
} as const satisfies Record<Exclude<HunkSmell, "redundant_test">, ReturnType<typeof noul>>;

/**
 * Asked only of test files. Jev can't run coverage, so the question is the
 * part of "adds no coverage" a hunk can show: assertions nothing could break,
 * or a case that walks the same branch as its neighbour.
 */
const TEST_FILE_QUESTIONS = {
  ...CODE_QUESTIONS,
  redundant_test: ask(
    "Could a test added in these lines be deleted without meaningfully reducing what the suite protects?",
    "The test asserts nothing the code under test could break — only that a value is defined, that a mock returns what it was just told to, that a constant equals itself, or that the language or framework works; or it repeats another test visible in the hunk with an input that exercises the same branch; or it restates a trivial getter or pass-through; or it snapshots output nobody would review.",
    "Each test pins a distinct behaviour, edge case, error path, or past regression, even a short one; or the added lines are fixtures, helpers, or setup rather than tests.",
  ),
} as const satisfies Record<HunkSmell, ReturnType<typeof noul>>;

/** Test files by the naming conventions of the common ecosystems. */
const TEST_PATH =
  /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]*\.py$|(Test|Tests|Spec)\.(java|kt|cs|swift|scala)$/;

export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}

/** One hunk the scan can ask about, with everything a Jev call needs. */
export interface ScanTarget {
  readonly filePath: string;
  readonly status: string;
  readonly hunkIndex: number;
  readonly header: string;
  readonly body: string;
  readonly contentHash: string;
}

export interface HunkSelection {
  /** Every hunk considered, skipped ones included, in diff order. */
  readonly seeds: readonly HunkScanSeed[];
  /** The hunks to ask about, most important first. */
  readonly targets: readonly ScanTarget[];
}

/** Cache key and seed identity. Status is in it because it's in the state. */
export function hunkContentHash(filePath: string, status: string, body: string): string {
  return createHash("sha1").update(`${JEV_MODEL}\0${filePath}\0${status}\0${body}`).digest("hex");
}

function toTarget(file: FileLike, hunk: PatchHunk): ScanTarget {
  return {
    filePath: file.filename,
    status: file.status,
    hunkIndex: hunk.index,
    header: hunk.header,
    body: hunk.body,
    contentHash: hunkContentHash(file.filename, file.status, hunk.body),
  };
}

/**
 * Decide which hunks to ask about. Generated (tier-0) files, hunks that add
 * nothing, and files without a patch are recorded but skipped; the rest are
 * ranked by file tier (unscored files last, as in `filePriorityOrder`), then
 * diff order — so if Jev stops answering partway, what's missing is the least
 * important code.
 */
export function selectHunks(
  files: readonly FileLike[],
  filePriorities: ReadonlyMap<string, number | null> | null,
): HunkSelection {
  const seeds: HunkScanSeed[] = [];
  const ranked: Array<{ readonly target: ScanTarget; readonly tier: number }> = [];

  for (const file of files) {
    const hunks = file.patch === null ? [] : splitHunks(file.patch);
    if (hunks.length === 0) {
      seeds.push({
        filePath: file.filename,
        hunkIndex: 0,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        contentHash: hunkContentHash(file.filename, file.status, ""),
        skipReason: "no_patch",
      });
      continue;
    }
    const tier = filePriorities?.get(file.filename) ?? null;
    for (const hunk of hunks) {
      const target = toTarget(file, hunk);
      const addsCode = hunk.addedLines.some((line) => line.trim() !== "");
      const skipReason: HunkSkipReason | null =
        tier === 0 ? "generated" : addsCode ? null : "deletion_only";
      seeds.push({
        filePath: file.filename,
        hunkIndex: hunk.index,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        contentHash: target.contentHash,
        skipReason,
      });
      if (skipReason === null) ranked.push({ target, tier: tier ?? -1 });
    }
  }

  // `sort` is stable, so equal tiers keep diff order.
  ranked.sort((a, b) => b.tier - a.tier);
  return { seeds, targets: ranked.map((r) => r.target) };
}

/** One call's worth of a hunk: the whole of it, or one window of a long one. */
interface HunkWindow {
  readonly body: string;
  readonly part: { readonly index: number; readonly count: number } | null;
  readonly contentHash: string;
}

/**
 * Cut a hunk into windows of at most {@link HUNK_PATCH_MAX_CHARS}, on line
 * boundaries, each repeating the header. Windows that add nothing are dropped
 * — there's nothing in them to judge. A hunk that fits is one window with the
 * hunk's own hash, so its cache entry is the same as an unwindowed call's.
 */
function hunkWindows(target: ScanTarget): HunkWindow[] {
  if (target.body.length <= HUNK_PATCH_MAX_CHARS) {
    return [{ body: target.body, part: null, contentHash: target.contentHash }];
  }
  const [header = "", ...lines] = target.body.split("\n");
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = header.length;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > HUNK_PATCH_MAX_CHARS) {
      chunks.push(current);
      current = [];
      size = header.length;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks
    .filter((chunk) => chunk.some((line) => line.startsWith("+") && line.slice(1).trim() !== ""))
    .map((chunk, index, kept) => {
      const body = [header, ...chunk].join("\n");
      return {
        body,
        part: { index: index + 1, count: kept.length },
        contentHash: hunkContentHash(target.filePath, target.status, body),
      };
    });
}

/**
 * Ask about one window. Outside a test file `redundant_test` is 0 without
 * being asked — a hunk that isn't a test can't be a redundant one. A missing
 * answer fails the call rather than reading as 0. Fails only with
 * {@link JevUnavailable}.
 */
function askWindow(
  target: ScanTarget,
  window: HunkWindow,
): Effect.Effect<Record<HunkSmell, number>, JevUnavailable, JevService> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    const testFile = isTestPath(target.filePath);
    const { answers } = yield* jev.ask({
      label: "hunk-scan",
      timeoutMs: HUNK_SCAN_CALL_TIMEOUT_MS,
      state: buildHunkScanState({
        path: target.filePath,
        status: target.status,
        header: target.header,
        body: window.body,
        part: window.part,
      }),
      questions: testFile ? TEST_FILE_QUESTIONS : CODE_QUESTIONS,
    });
    const signals = {} as Record<HunkSmell, number>;
    for (const smell of HUNK_SMELLS) {
      if (smell === "redundant_test" && !testFile) {
        signals[smell] = 0;
        continue;
      }
      const probability = numericAnswerAt(answers, smell, "noul");
      if (probability === null) {
        return yield* Effect.fail(
          new JevUnavailable({ reason: "malformed", message: `hunk-scan: no answer for ${smell}` }),
        );
      }
      signals[smell] = probability;
    }
    return signals;
  });
}

/** One window's answer, from the content-keyed cache when this exact text was asked before. */
function judgeWindow(
  target: ScanTarget,
  window: HunkWindow,
): Effect.Effect<
  Record<HunkSmell, number>,
  JevUnavailable | DbError,
  JevService | CacheService | DbService
> {
  return Effect.gen(function* () {
    const cache = yield* CacheService;
    return yield* cache.getOrFetch(
      HUNK_SCAN_CACHE_NS,
      window.contentHash,
      () => askWindow(target, window),
      { immutable: true },
    );
  });
}

/** A hunk carries a smell if any of its windows does. */
function strongest(
  a: Record<HunkSmell, number> | null,
  b: Record<HunkSmell, number>,
): Record<HunkSmell, number> {
  if (a === null) return b;
  const merged = { ...a };
  for (const smell of HUNK_SMELLS) merged[smell] = Math.max(a[smell], b[smell]);
  return merged;
}

/**
 * Ask about every window of every target, {@link HUNK_SCAN_CONCURRENCY} at a
 * time. No cap and no time budget: every hunk is read. A failed call gets one
 * retry; once {@link HUNK_SCAN_BREAKER_FAILURES} failures land in a row the
 * scan stops starting calls — Jev is down, and asking the rest would only
 * stall the agent. A 429 isn't a failure: every call waits out the quota and
 * tries again. `onAnswer` runs once per hunk, when its last window lands, so
 * the caller can commit and broadcast each one; a hunk it never ran for is one
 * the scan didn't finish. Never fails.
 */
export function scanHunks<R>(
  targets: readonly ScanTarget[],
  onAnswer: (
    target: ScanTarget,
    signals: Record<HunkSmell, number>,
  ) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, JevService | CacheService | DbService | R> {
  return Effect.gen(function* () {
    const progress = new Map<
      ScanTarget,
      { windowsLeft: number; signals: Record<HunkSmell, number> | null }
    >();
    const work = targets.flatMap((target) => {
      const windows = hunkWindows(target);
      progress.set(target, { windowsLeft: windows.length, signals: null });
      return windows.map((window) => ({ target, window }));
    });

    // The breaker. `round` counts the failures that counted; a call sent
    // before the latest of them was already in flight when it landed, so its
    // own failure is the same outage and doesn't count again.
    let round = 0;
    let failuresInARow = 0;
    // Completed when the breaker trips. Racing every call against it stops
    // the scan waiting on calls in flight; those still finish in the
    // background (`CacheService` runs fetches detached), and their answers
    // are cached for the next run.
    const stop = yield* Deferred.make<null>();
    let isTripped = false;
    let pausedUntil = 0;

    const onFailure = (error: JevUnavailable | DbError, sentInRound: number) =>
      Effect.suspend(() => {
        if (error._tag === "JevUnavailable" && error.reason === "rate_limited") {
          const wait = error.retryAfterMs ?? HUNK_SCAN_RATE_LIMIT_PAUSE_MS;
          pausedUntil = Math.max(pausedUntil, Date.now() + wait);
          return Effect.void;
        }
        if (sentInRound !== round) return Effect.void;
        round += 1;
        failuresInARow += 1;
        if (isTripped || failuresInARow < HUNK_SCAN_BREAKER_FAILURES) return Effect.void;
        isTripped = true;
        return Deferred.succeed(stop, null);
      });

    /** One call, after any 429 pause, reporting its failure to the breaker. */
    const attempt = (target: ScanTarget, window: HunkWindow) =>
      Effect.suspend(() => {
        const sentInRound = round;
        return Effect.sleep(Math.max(0, pausedUntil - Date.now())).pipe(
          Effect.zipRight(judgeWindow(target, window)),
          Effect.tapError((error) => onFailure(error, sentInRound)),
        );
      });

    yield* Effect.forEach(
      work,
      ({ target, window }) =>
        Effect.gen(function* () {
          if (isTripped) return;
          let retries = 0;
          let rateLimitRetries = 0;
          const label = `hunk-scan ${target.filePath}#${target.hunkIndex}${window.part ? ` (${window.part.index}/${window.part.count})` : ""}`;
          const signals = yield* optionalJev(
            label,
            attempt(target, window).pipe(
              Effect.retry({
                while: (error) =>
                  !isTripped &&
                  (error._tag === "JevUnavailable" && error.reason === "rate_limited"
                    ? rateLimitRetries++ < HUNK_SCAN_RATE_LIMIT_RETRIES
                    : retries++ < HUNK_SCAN_RETRIES),
              }),
            ),
          ).pipe(Effect.raceFirst(Deferred.await(stop)));
          if (signals === null) return;
          failuresInARow = 0;
          const state = progress.get(target);
          if (!state) return;
          state.signals = strongest(state.signals, signals);
          state.windowsLeft -= 1;
          if (state.windowsLeft > 0) return;
          yield* onAnswer(target, state.signals);
        }),
      { concurrency: HUNK_SCAN_CONCURRENCY, discard: true },
    );
  });
}

/** A flagged hunk as the agent sees it, before a walkthrough numbers it. */
export type HunkLead = Pick<
  WalkthroughLead,
  "filePath" | "hunkIndex" | "newStart" | "newLines" | "smells"
>;

function smellProbability(lead: HunkLead, smell: HunkSmell): number {
  return lead.smells.find((s) => s.smell === smell)?.probability ?? 0;
}

/**
 * The flagged hunks worth handing the agent, strongest first, capped at
 * {@link HUNK_SCAN_MAX_LEADS}: each smell's strongest
 * {@link HUNK_SCAN_LEADS_PER_SMELL} first, then the strongest of the rest.
 * Only hunks in `promptFiles` count — the scan always covers the full PR,
 * while an incremental review's prompt shows only its range.
 */
export function hunkScanLeads(
  rows: readonly HunkScanRow[],
  promptFiles: ReadonlySet<string>,
): HunkLead[] {
  const byStrength = rows
    .filter((row) => promptFiles.has(row.filePath))
    .map(
      (row): HunkLead => ({
        filePath: row.filePath,
        hunkIndex: row.hunkIndex,
        newStart: row.newStart,
        newLines: row.newLines,
        smells: flaggedHunkSmells(row.signals),
      }),
    )
    .filter((lead) => lead.smells.length > 0)
    .sort((a, b) => (b.smells[0]?.probability ?? 0) - (a.smells[0]?.probability ?? 0));
  const picked = new Set<HunkLead>();
  for (const smell of HUNK_SMELLS) {
    const reserved = byStrength
      .filter((lead) => smellProbability(lead, smell) > 0)
      .sort((a, b) => smellProbability(b, smell) - smellProbability(a, smell))
      .slice(0, HUNK_SCAN_LEADS_PER_SMELL);
    for (const lead of reserved) {
      if (picked.size < HUNK_SCAN_MAX_LEADS) picked.add(lead);
    }
  }
  for (const lead of byStrength) {
    if (picked.size < HUNK_SCAN_MAX_LEADS) picked.add(lead);
  }
  return byStrength.filter((lead) => picked.has(lead));
}
