// ── Recap source bundle assembly ──────────────────────────────────────────────
//
// Pure functions for building and annotating the RecapSourceBundle passed to
// the recap agent. No Effect services, no closures — extracted from
// ProjectRecapJobs so that file stays focused on orchestration.

import type { RecapPeriod, RecapSummaryStats } from "@revv/shared";
import type {
  RecapSourceBundle,
  RecapSourcePr,
  RecapSourcePrDiff,
  RecapSourcePrDiffFile,
  RecapSourcePrDigest,
} from "../ai/providers/recap-tools";
import type { ArchivedPrWithWalkthrough } from "./PullRequest";
import { truncatePatchToChars } from "./patch-truncate";

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
