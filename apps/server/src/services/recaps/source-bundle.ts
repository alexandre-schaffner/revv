// What a recap is written from: the window's archived pull requests (the
// local mirror, backfilled from GitHub's search for what it missed), the work
// still open as the window closed, and a compact digest of each diff that has
// no finished walkthrough to describe it.

import type { ProjectRecap, RecapPeriod, RecapSummaryStats, RecapWindowBounds } from "@revv/shared";
import { windowIsCurrent } from "@revv/shared";
import { type Context, Effect } from "effect";
import type { RecapSourcePrDiff, RecapSourcePrDiffFile } from "../../ai/providers/recap-tools";
import type {
  RecapSourceBundle,
  RecapSourcePr,
  RecapSourcePrDigest,
} from "../../db/schema/project-recaps";
import type { DbError } from "../../domain/errors";
import type { ObservedPr } from "../../domain/observed-pr";
import { debug, logError } from "../../logger";
import type { DiffCacheService } from "../DiffCache";
import type { GitHubGateway } from "../github/gateway";
import type { GitHubClient } from "../github/transport";
import type { PrContextService } from "../PrContext";
import type { PrMirror } from "../PrMirror";
import type { ArchivedPrWithWalkthrough, PullRequestService } from "../PullRequest";
import { truncatePatchToChars } from "../patch-truncate";

export const RECAP_DIFF_MAX_FILES_PER_PR = 25;
export const RECAP_DIFF_MAX_PATCH_CHARS = 3000;

export function truncatePatch(patch: string | null): { patch: string | null; truncated: boolean } {
  if (patch === null) return { patch: null, truncated: false };
  return truncatePatchToChars(patch, RECAP_DIFF_MAX_PATCH_CHARS, "patch");
}

export function buildSourceBundle(
  repoFullName: string,
  params: {
    repoId: string;
    period: RecapPeriod;
    periodStart: string;
    periodEnd: string;
  },
  windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
  openPrs: ReadonlyArray<ArchivedPrWithWalkthrough>,
): RecapSourceBundle {
  const toRecapPr = (row: ArchivedPrWithWalkthrough, statusOverride?: "open"): RecapSourcePr => {
    const pr = row.pr;
    return {
      id: pr.id,
      externalId: pr.externalId,
      title: pr.title,
      authorLogin: pr.authorLogin,
      status:
        statusOverride ?? ((pr.status === "merged" ? "merged" : "closed") as "merged" | "closed"),
      closedAt: pr.closedAt ?? "",
      sourceBranch: pr.sourceBranch,
      targetBranch: pr.targetBranch,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      url: pr.url,
      body: pr.body ? truncateBody(pr.body) : null,
      walkthrough: row.walkthrough
        ? {
            id: row.walkthrough.id,
            summary: row.walkthrough.summary,
            sentiment: row.walkthrough.sentiment ?? null,
            riskLevel:
              row.walkthrough.riskLevel === "high" || row.walkthrough.riskLevel === "medium"
                ? row.walkthrough.riskLevel
                : "low",
            completedAt: row.walkthrough.completedAt ?? null,
          }
        : null,
      diffDigest: null,
    };
  };

  const prs: RecapSourcePr[] = windowed.map((row) => toRecapPr(row));
  const openPrList: RecapSourcePr[] = openPrs.map((row) => toRecapPr(row, "open"));

  let mergedCount = 0;
  let closedCount = 0;
  const authorSet = new Set<string>();
  let low = 0;
  let medium = 0;
  let high = 0;
  let missing = 0;
  for (const p of prs) {
    if (p.status === "merged") mergedCount++;
    else closedCount++;
    authorSet.add(p.authorLogin);
    if (p.walkthrough) {
      if (p.walkthrough.riskLevel === "high") high++;
      else if (p.walkthrough.riskLevel === "medium") medium++;
      else low++;
    } else {
      missing++;
    }
  }
  const stats: RecapSummaryStats = {
    prCount: prs.length,
    mergedCount,
    closedCount,
    authorCount: authorSet.size,
    riskBreakdown: { low, medium, high },
    walkthroughsMissingCount: missing,
  };

  return {
    repoId: params.repoId,
    repoFullName,
    period: params.period,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    prs,
    openPrs: openPrList,
    stats,
  };
}

export function attachRecapDigests(
  bundle: RecapSourceBundle,
  digests: ReadonlyMap<string, RecapSourcePrDigest>,
): RecapSourceBundle {
  const attach = (pr: RecapSourcePr): RecapSourcePr => ({
    ...pr,
    diffDigest: pr.walkthrough ? null : (digests.get(pr.id) ?? pr.diffDigest),
  });
  return {
    ...bundle,
    prs: bundle.prs.map(attach),
    openPrs: bundle.openPrs.map(attach),
  };
}

export function buildDigestForRecapPr(
  pr: ArchivedPrWithWalkthrough["pr"],
  diff: RecapSourcePrDiff | null,
): RecapSourcePrDigest {
  if (diff === null || diff.source === "unavailable") {
    return {
      source: "unavailable",
      digest:
        "Raw diff was unavailable during recap ingestion. Describe this PR from title, body, branch names, and +/- counts only; state the limitation if detail matters.",
      files: [],
      note: diff?.note ?? "No diff bytes were available for this PR.",
    };
  }

  const files = diff.files.slice(0, 12).map((file) => ({
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patchAvailable: file.patch !== null,
    patchTruncated: file.patchTruncated,
  }));
  const primaryFiles = files
    .slice(0, 8)
    .map((file) => `${file.status} ${file.path} (+${file.additions}/-${file.deletions})`)
    .join("; ");
  const patchHints = diff.files
    .flatMap((file) => extractPatchHints(file))
    .slice(0, 18)
    .join("; ");
  const extraNotes: string[] = [];
  if (diff.filesTruncated) {
    extraNotes.push(`file list truncated from ${diff.totalFiles} files`);
  }
  if (diff.note) extraNotes.push(diff.note);
  const note = extraNotes.length > 0 ? extraNotes.join(" ") : null;
  const digest = [
    `PR #${pr.externalId} "${pr.title}" diff digest.`,
    primaryFiles ? `Primary files: ${primaryFiles}.` : "No file-level rows were available.",
    patchHints
      ? `Patch signals: ${patchHints}.`
      : "Patch text was absent or too small to extract semantic hints.",
    note ? `Limitations: ${note}` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1600);

  return { source: diff.source, digest, files, note };
}

function extractPatchHints(file: RecapSourcePrDiffFile): string[] {
  if (!file.patch) return [];
  const hints: string[] = [];
  for (const rawLine of file.patch.split("\n")) {
    if (hints.length >= 4) break;
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (!rawLine.startsWith("+") && !rawLine.startsWith("-")) continue;
    const line = rawLine.slice(1).trim();
    if (line.length < 8) continue;
    if (/^[{}()[\],.;]+$/.test(line)) continue;
    hints.push(`${file.path}: ${rawLine[0]} ${line.slice(0, 120)}`);
  }
  return hints;
}

function truncateBody(body: string): string {
  const MAX = 2000;
  if (body.length <= MAX) return body;
  return `${body.slice(0, MAX)}\n\n[…truncated…]`;
}

/** Cap on per-PR GitHub fetches during one backfill pass — defends against a
 *  misconfigured search returning thousands of PRs. */
const RECAP_BACKFILL_MAX_FETCHES = 50;

export interface RecapSources {
  /** The repo owner's client, or null: the recap then reads diffs from the cache only. */
  readonly repoClient: (repoId: string) => Effect.Effect<GitHubClient | null>;
  /**
   * A PR's diff, capped per file and per PR so one PR can't blow up the
   * agent's context window. Any failure degrades to a metadata-only PR.
   */
  readonly loadDiff: (
    pr: ArchivedPrWithWalkthrough["pr"],
    repoFullName: string,
    client: GitHubClient | null,
  ) => Effect.Effect<RecapSourcePrDiff>;
  /**
   * The window's pull requests, open work and digests. A window with nothing
   * in it is final once closed (`empty`), and "nothing yet" while open.
   */
  readonly assemble: (
    recap: ProjectRecap,
    repoFullName: string,
  ) => Effect.Effect<RecapSourceBundle | "empty" | "nothing-yet", DbError>;
  /**
   * No pull request closed in the window or was open as it closed, as far as
   * the local mirror knows: the same boundary as `assemble`'s empty check.
   */
  readonly windowIsSilent: (
    repoId: string,
    window: RecapWindowBounds,
  ) => Effect.Effect<boolean, DbError>;
}

export function makeRecapSources(deps: {
  readonly prs: Context.Service.Shape<typeof PullRequestService>;
  readonly prContext: Context.Service.Shape<typeof PrContextService>;
  readonly diffCache: Context.Service.Shape<typeof DiffCacheService>;
  readonly github: Context.Service.Shape<typeof GitHubGateway>;
  readonly mirror: Context.Service.Shape<typeof PrMirror>;
}): RecapSources {
  const { prs, diffCache, github, mirror } = deps;

  const archivedIn = (repoId: string, periodStart: string, periodEnd: string) =>
    prs.listArchivedPrsForWindow(repoId, periodStart, periodEnd);
  const openAsOf = (repoId: string, periodEnd: string) =>
    prs.listOpenPrsAsOfWindow(repoId, periodEnd);

  const repoClient = (repoId: string): Effect.Effect<GitHubClient | null> =>
    deps.prContext.forRepo(repoId).pipe(
      Effect.map((ctx): GitHubClient | null => ctx.client),
      Effect.catch((err) =>
        Effect.sync(() => {
          debug(
            "recap-jobs",
            `no GitHub client for repo ${repoId} — recap will fall back to cache-only diffs:`,
            err instanceof Error ? err.message : String(err),
          );
          return null;
        }),
      ),
    );

  const loadDiff = (
    pr: ArchivedPrWithWalkthrough["pr"],
    repoFullName: string,
    client: GitHubClient | null,
  ): Effect.Effect<RecapSourcePrDiff> =>
    Effect.gen(function* () {
      const loaded =
        client === null
          ? yield* diffCache
              .getCachedFiles(pr.id)
              .pipe(
                Effect.map((files) =>
                  files === null ? null : { files, source: "cache" as const },
                ),
              )
          : yield* diffCache.getOrFetch(pr, repoFullName, client);
      if (loaded === null) {
        return {
          files: [],
          totalFiles: 0,
          filesTruncated: false,
          source: "unavailable",
          note: "No diff cached locally and no GitHub token available — describe this PR from title/body/+/- counts only.",
        } satisfies RecapSourcePrDiff;
      }

      const totalFiles = loaded.files.length;
      const trimmed = loaded.files.slice(0, RECAP_DIFF_MAX_FILES_PER_PR);
      const filesTruncated = trimmed.length < totalFiles;
      const recapFiles: RecapSourcePrDiffFile[] = trimmed.map((f) => {
        const { patch, truncated } = truncatePatch(f.patch);
        return {
          path: f.path,
          oldPath: f.oldPath,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch,
          patchTruncated: truncated,
        };
      });
      const notes: string[] = [];
      if (filesTruncated) {
        notes.push(
          `Showing ${trimmed.length} of ${totalFiles} files — only the first ${RECAP_DIFF_MAX_FILES_PER_PR} were included.`,
        );
      }
      const truncatedPatchCount = recapFiles.filter((f) => f.patchTruncated).length;
      if (truncatedPatchCount > 0) {
        notes.push(
          `${truncatedPatchCount} patch(es) clipped to ${RECAP_DIFF_MAX_PATCH_CHARS} chars.`,
        );
      }
      return {
        files: recapFiles,
        totalFiles,
        filesTruncated,
        source: loaded.source,
        note: notes.length > 0 ? notes.join(" ") : null,
      } satisfies RecapSourcePrDiff;
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          debug(
            "recap-jobs",
            `diff load failed for pr ${pr.id} (#${pr.externalId}) — recap will skip diff:`,
            err instanceof Error ? err.message : String(err),
          );
          return {
            files: [],
            totalFiles: 0,
            filesTruncated: false,
            source: "unavailable",
            note: "Diff fetch from GitHub failed — describe this PR from title/body/+/- counts only.",
          } satisfies RecapSourcePrDiff;
        }),
      ),
    );

  // The local mirror is populated by the poll scheduler, which only fetches
  // *open* PRs. A PR that closes between two poll cycles, or closed before the
  // user added the repo, never lands in `pull_requests`, so the window query
  // misses it — silent data loss for a recap whose whole job is "what
  // shipped". GitHub's issue search fills in what the mirror is missing.
  // Failure is non-fatal: the recap goes ahead on the local mirror.
  const backfillMissingPrs = (
    repoId: string,
    repoFullName: string,
    periodStart: string,
    periodEnd: string,
    windowed: ReadonlyArray<ArchivedPrWithWalkthrough>,
  ): Effect.Effect<{ readonly addedCount: number }> =>
    Effect.gen(function* () {
      const client = yield* repoClient(repoId);
      if (client === null) {
        debug("recap-jobs", `backfill skipped for repo ${repoId} — no GitHub token resolvable`);
        return { addedCount: 0 };
      }

      const searched = yield* github.prs
        .searchClosedInWindow(client, repoFullName, periodStart, periodEnd)
        .pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              debug(
                "recap-jobs",
                `searchClosedPrsInWindow failed for ${repoFullName} — proceeding with local data only:`,
                err instanceof Error ? err.message : String(err),
              );
              return [] as ReadonlyArray<{
                readonly number: number;
                readonly closedAt: string;
                readonly merged: boolean;
              }>;
            }),
          ),
        );

      if (searched.length === 0) return { addedCount: 0 };

      const knownNumbers = new Set(windowed.map((row) => row.pr.externalId));
      const missing = searched
        .filter((s) => !knownNumbers.has(s.number))
        .slice(0, RECAP_BACKFILL_MAX_FETCHES);

      if (missing.length === 0) return { addedCount: 0 };

      debug(
        "recap-jobs",
        `backfilling ${missing.length} closed PR(s) for ${repoFullName} window ${periodStart}..${periodEnd}`,
      );

      const fetched = yield* github.prs
        .getMany(
          client,
          repoFullName,
          repoId,
          missing.map((m) => m.number),
        )
        .pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              debug(
                "recap-jobs",
                `PR read failed during backfill for ${repoFullName}:`,
                err instanceof Error ? err.message : String(err),
              );
              return new Map<number, ObservedPr>();
            }),
          ),
        );
      const upsertable = [...fetched.values()];

      if (upsertable.length === 0) return { addedCount: 0 };

      yield* mirror.apply(upsertable).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            logError(
              "recap-jobs",
              `upsertPrs failed during recap backfill for ${repoFullName}:`,
              err instanceof Error ? err.message : String(err),
            );
          }),
        ),
      );

      return { addedCount: upsertable.length };
    });

  const assemble = (
    recap: ProjectRecap,
    repoFullName: string,
  ): Effect.Effect<RecapSourceBundle | "empty" | "nothing-yet", DbError> =>
    Effect.gen(function* () {
      const { repositoryId, periodStart, periodEnd } = recap;
      let windowed = yield* archivedIn(repositoryId, periodStart, periodEnd);
      const backfill = yield* backfillMissingPrs(
        repositoryId,
        repoFullName,
        periodStart,
        periodEnd,
        windowed,
      );
      if (backfill.addedCount > 0)
        windowed = yield* archivedIn(repositoryId, periodStart, periodEnd);

      // As of the window's close, so a historical recap doesn't describe
      // today's open PRs. Read before the empty-window check so a window
      // with only open PRs still gets an "active work" recap.
      const openPrs = yield* openAsOf(repositoryId, periodEnd);

      if (windowed.length === 0 && openPrs.length === 0) {
        return windowIsCurrent(recap.period, periodStart) ? "nothing-yet" : "empty";
      }

      // Every PR without a completed walkthrough gets its diff compacted into
      // a digest, so the agent session scales with many PRs without holding
      // every raw diff.
      const client = yield* Effect.cached(repoClient(repositoryId));
      const digests = yield* Effect.forEach(
        [...windowed, ...openPrs].filter((row) => row.walkthrough === null),
        (row) =>
          Effect.map(
            Effect.flatMap(client, (c) => loadDiff(row.pr, repoFullName, c)),
            (diff) => [row.pr.id, buildDigestForRecapPr(row.pr, diff)] as const,
          ),
        { concurrency: 3 },
      );

      return attachRecapDigests(
        buildSourceBundle(
          repoFullName,
          { repoId: repositoryId, period: recap.period, periodStart, periodEnd },
          windowed,
          openPrs,
        ),
        new Map<string, RecapSourcePrDigest>(digests),
      );
    });

  const windowIsSilent = (
    repoId: string,
    window: RecapWindowBounds,
  ): Effect.Effect<boolean, DbError> =>
    Effect.gen(function* () {
      if ((yield* archivedIn(repoId, window.periodStart, window.periodEnd)).length > 0) {
        return false;
      }
      return (yield* openAsOf(repoId, window.periodEnd)).length === 0;
    });

  return { repoClient, loadDiff, assemble, windowIsSilent };
}
