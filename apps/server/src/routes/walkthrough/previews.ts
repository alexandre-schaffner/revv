// The previews the review page asks for before generation: the PR's sizing
// and its first pass. Both read the cached diff only, never GitHub, so a
// preview can't become a rate-limit risk, and answer `pending` until the diff
// lands; the client asks again. Both share the cached job-start answer the
// walkthrough itself uses — one TypeSafe call, made by whoever asks first.

import type { HunkScanEnsureResult, WalkthroughSizing } from "@revv/shared";
import { Effect } from "effect";
import {
  filePriorityOrder,
  resolveJobStartAnswers,
  routeFromAnswers,
} from "../../ai/jev/job-start";
import type { FileLike } from "../../ai/jev/state";
import type { AppServices } from "../../runtime";
import { DiffCacheService } from "../../services/DiffCache";
import { HunkScanService } from "../../services/HunkScan";
import { JevService } from "../../services/Jev";
import { PrContextService } from "../../services/PrContext";
import { SettingsService } from "../../services/Settings";

/** The PR, its head, and its cached diff, or null until the diff lands. */
function loadCachedPrDiff(prId: string, userId: string) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const { pr } = yield* prContext.resolveBasic(prId, userId);
    if (!pr.headSha) return null;
    const diffCache = yield* DiffCacheService;
    const cached = yield* diffCache.getCachedFiles(pr.id);
    if (cached === null || cached.length === 0) return null;
    const files: FileLike[] = cached.map((f) => ({
      filename: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));
    return { pr, headSha: pr.headSha, files };
  });
}

/** Risk tier for the review page, and what "Auto" would pick for the model. */
export function walkthroughSizing(
  prId: string,
  userId: string,
): Effect.Effect<WalkthroughSizing, unknown, AppServices> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) return { status: "off" as const };

    const diff = yield* loadCachedPrDiff(prId, userId);
    if (diff === null) return { status: "pending" as const };

    const answers = yield* resolveJobStartAnswers(diff.pr.id, diff.headSha, {
      pr: diff.pr,
      files: diff.files,
      // Commit subjects are a sizing nicety, not load-bearing; skipping
      // them keeps this off the GitHub path.
      commits: [],
    });
    if (answers === null) return { status: "pending" as const };

    const settingsSvc = yield* SettingsService;
    const settings = yield* settingsSvc.getSettings();
    const override = routeFromAnswers(answers, {
      agent: yield* settingsSvc.resolveAgent(),
      configuredModel: settings.aiModel,
      configuredEffort: settings.aiThinkingEffort,
    });
    return {
      status: "ready" as const,
      riskLevel: answers.riskLevel,
      model: override?.model ?? null,
      thinkingEffort: override?.thinkingEffort ?? null,
    };
  });
}

/**
 * The first pass for the PR's current head, started unless it is running or
 * done, and returned as persisted; rows then stream in as `hunk-scan:*`
 * events. Every ask goes through `start`, which retries a `failed` or
 * `partial` scan and rebuilds one seeded from a diff that has since changed.
 * File tiers from the job-start answer skip generated files and put the
 * important ones first.
 */
export function ensureHunkScan(
  prId: string,
  userId: string,
): Effect.Effect<HunkScanEnsureResult, unknown, AppServices> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) return { status: "off" as const };

    const diff = yield* loadCachedPrDiff(prId, userId);
    if (diff === null) return { status: "pending" as const };
    const { pr, headSha, files } = diff;

    const answers = yield* resolveJobStartAnswers(pr.id, headSha, { pr, files, commits: [] });
    const hunkScan = yield* HunkScanService;
    yield* hunkScan.start({
      prId: pr.id,
      headSha,
      files,
      filePriorities: answers === null ? null : filePriorityOrder(answers, files),
    });
    return { status: "ready" as const, scan: yield* hunkScan.snapshot(pr.id, headSha) };
  });
}
