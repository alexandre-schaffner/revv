// The previews the review page asks for before generation: the PR's sizing
// and its first pass. Both read the cached diff only, never GitHub, so a
// preview can't become a rate-limit risk, and answer `pending` until the diff
// lands, which `DiffCacheService` announces as `diff:cached`. Both share the
// cached job-start answer the walkthrough itself uses — one TypeSafe call,
// made by whoever asks first.

import type { HunkScanEnsureResult, WalkthroughSizing } from "@revv/shared";
import { Effect } from "effect";
import type { AppServices } from "../../runtime";
import { DiffCacheService } from "../../services/DiffCache";
import { HunkScanService } from "../../services/hunk-scan/HunkScan";
import { JevService } from "../../services/Jev";
import { PrContextService } from "../../services/PrContext";
import { SettingsService } from "../../services/Settings";
import { launchDiff, planLaunch } from "../../services/walkthrough/launch-plan";

/** The PR, its head, and its cached diff, or null until the diff lands. */
function loadCachedPrDiff(prId: string) {
  return Effect.gen(function* () {
    const { pr } = yield* (yield* PrContextService).readPr(prId);
    if (!pr.headSha) return null;
    const cached = yield* (yield* DiffCacheService).getCachedDiff(pr.id);
    if (cached === null) return null;
    return { pr, headSha: pr.headSha, ...launchDiff(cached) };
  });
}

/** The launch a walkthrough of the PR's head would plan now, from the cached job-start answer. */
function launchPlanFor(diff: NonNullable<Effect.Success<ReturnType<typeof loadCachedPrDiff>>>) {
  return Effect.gen(function* () {
    const settingsService = yield* SettingsService;
    return yield* planLaunch({
      prId: diff.pr.id,
      headSha: diff.headSha,
      state: { pr: diff.pr, files: diff.files, commits: diff.commits },
      settings: yield* settingsService.getSettings(),
      agent: yield* settingsService.resolveAgent(),
    });
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

    const { plan, risk } = yield* launchPlanFor(diff);
    // No risk tier means no job-start answer yet.
    if (risk === null) return { status: "pending" as const };
    // What the launch runs with, for the halves the judgment sized.
    return {
      status: "ready" as const,
      riskLevel: risk.level,
      model: plan.sizing?.model !== undefined ? plan.model : null,
      thinkingEffort: plan.sizing?.thinkingEffort !== undefined ? plan.thinkingEffort : null,
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

    const { plan } = yield* launchPlanFor(diff);
    const hunkScan = yield* HunkScanService;
    yield* hunkScan.start({ prId: pr.id, headSha, files, filePriorities: plan.filePriorities });
    return { status: "ready" as const, scan: yield* hunkScan.snapshot(pr.id, headSha) };
  });
}
