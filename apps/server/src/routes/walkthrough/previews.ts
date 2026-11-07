// The previews the review page asks for before generation: the PR's sizing
// and its first pass. Both read the cached diff only, never GitHub, so a
// preview can't become a rate-limit risk, and answer `pending` until the diff
// lands, which `DiffCacheService` announces as `diff:cached`. Both share the
// cached job-start answer the walkthrough itself uses — one TypeSafe call,
// made by whoever asks first.

import type { HunkScanEnsureResult, WalkthroughSizing } from "@revv/shared";
import { Effect } from "effect";
import { resolveJobStartAnswers } from "../../ai/jev/job-start";
import type { AppServices } from "../../runtime";
import { DiffCacheService, toGitHubFileShape } from "../../services/DiffCache";
import { HunkScanService } from "../../services/hunk-scan/HunkScan";
import { JevService } from "../../services/Jev";
import { PrContextService } from "../../services/PrContext";
import { SettingsService } from "../../services/Settings";
import { buildJobStartPlan, launchFor } from "../../services/walkthrough/launch-plan";

/** The PR, its head, and its cached diff, or null until the diff lands. */
function loadCachedPrDiff(prId: string) {
  return Effect.gen(function* () {
    const prContext = yield* PrContextService;
    const { pr } = yield* prContext.forPr(prId);
    if (!pr.headSha) return null;
    const diffCache = yield* DiffCacheService;
    const cached = yield* diffCache.getCachedFiles(pr.id);
    if (cached === null) return null;
    return { pr, headSha: pr.headSha, files: toGitHubFileShape(cached) };
  });
}

/** The cached job-start answer for the PR's head, projected as the launch would. */
function jobStartPlanFor(diff: NonNullable<Effect.Success<ReturnType<typeof loadCachedPrDiff>>>) {
  return Effect.gen(function* () {
    const answers = yield* resolveJobStartAnswers(diff.pr.id, diff.headSha, {
      pr: diff.pr,
      files: diff.files,
    });
    const settingsService = yield* SettingsService;
    const settings = yield* settingsService.getSettings();
    const agent = yield* settingsService.resolveAgent();
    const plan = buildJobStartPlan({ settings, agent, files: diff.files, answers });
    return { answers, plan, launch: launchFor(settings, agent, plan.launchOverride) };
  });
}

/** Risk tier for the review page, and what "Auto" would pick for the model. */
export function walkthroughSizing(
  prId: string,
): Effect.Effect<WalkthroughSizing, unknown, AppServices> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) return { status: "off" as const };

    const diff = yield* loadCachedPrDiff(prId);
    if (diff === null) return { status: "pending" as const };

    const { answers, plan, launch } = yield* jobStartPlanFor(diff);
    if (answers === null) return { status: "pending" as const };
    // What the launch runs with, for the halves the judgment sized.
    const sized = plan.launchOverride;
    return {
      status: "ready" as const,
      riskLevel: plan.assignedRisk,
      model: sized?.model !== undefined ? launch.model : null,
      thinkingEffort: sized?.thinkingEffort !== undefined ? launch.thinkingEffort : null,
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
): Effect.Effect<HunkScanEnsureResult, unknown, AppServices> {
  return Effect.gen(function* () {
    const jev = yield* JevService;
    if (!(yield* jev.isAvailable())) return { status: "off" as const };

    const diff = yield* loadCachedPrDiff(prId);
    if (diff === null) return { status: "pending" as const };
    const { pr, headSha, files } = diff;

    const { plan } = yield* jobStartPlanFor(diff);
    const hunkScan = yield* HunkScanService;
    yield* hunkScan.start({ prId: pr.id, headSha, files, filePriorities: plan.filePriorities });
    return { status: "ready" as const, scan: yield* hunkScan.snapshot(pr.id, headSha) };
  });
}
