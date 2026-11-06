import type { WalkthroughSizing } from "@revv/shared";
import { Effect } from "effect";
import { resolveJobStartAnswers, routeFromAnswers } from "../../../ai/jev/job-start";
import type { AppServices } from "../../../runtime";
import { JevService } from "../../../services/Jev";
import { SettingsService } from "../../../services/Settings";
import { loadCachedPrDiff } from "./cached-pr-diff";

/**
 * GET /api/reviews/:id/walkthrough/sizing
 *
 * Sizes the PR before generation starts: risk tier for the review page, and
 * what "Auto" would pick for the model. Cached on `(prId, headSha)` and
 * shared with `startJobBody` — same TypeSafe call, moved earlier, not an extra one.
 *
 * Reads the cached diff only (`loadCachedPrDiff`). Reports `pending` until
 * the diff lands; client retries.
 */
export function getWalkthroughSizingHandler(
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
