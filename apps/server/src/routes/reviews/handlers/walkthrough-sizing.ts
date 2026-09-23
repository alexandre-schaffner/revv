import { AUTO_SENTINEL, type WalkthroughSizing } from "@revv/shared";
import { Effect } from "effect";
import { resolveJobStartAnswers, routeFromAnswers } from "../../../ai/jev/job-start";
import { AppRuntime } from "../../../runtime";
import { DiffCacheService } from "../../../services/DiffCache";
import { PrContextService } from "../../../services/PrContext";
import { SettingsService } from "../../../services/Settings";

/**
 * GET /api/reviews/:id/walkthrough/sizing
 *
 * Sizes the PR before generation starts: risk tier for the review page, and
 * what "Auto" would pick for the model. Cached on `(prId, headSha)` and
 * shared with `startJobBody` — same TypeSafe call, moved earlier, not an extra one.
 *
 * Reads the cached diff only, never GitHub, so a preview can't become a
 * rate-limit risk. Reports `pending` until the diff lands; client retries.
 */
export function getWalkthroughSizingHandler(
  prId: string,
  userId: string,
): Promise<WalkthroughSizing> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
      // Three independent reasons to size, any one alone justifies the call.
      // Model/effort only matter when that half isn't pinned; risk always does.
      const autoSizing = settings?.jev.autoModel === true;
      const wantsModel = autoSizing && settings?.aiModel === AUTO_SENTINEL;
      const wantsEffort = autoSizing && settings?.aiThinkingEffort === AUTO_SENTINEL;
      const wantsRisk = settings?.jev.risk === true;
      if (
        settings === null ||
        !settings.jev.enabled ||
        (!wantsModel && !wantsEffort && !wantsRisk)
      ) {
        return { status: "off" as const };
      }

      const prContext = yield* PrContextService;
      const { pr } = yield* prContext.resolveBasic(prId, userId);
      const headSha = pr.headSha;
      if (!headSha) return { status: "pending" as const };

      const diffCache = yield* DiffCacheService;
      const cachedFiles = yield* diffCache.getCachedFiles(pr.id);
      if (cachedFiles === null || cachedFiles.length === 0) {
        return { status: "pending" as const };
      }

      const answers = yield* resolveJobStartAnswers(pr.id, headSha, {
        pr,
        files: cachedFiles.map((f) => ({
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
        // Commit subjects are a sizing nicety, not load-bearing; skipping
        // them keeps this off the GitHub path.
        commits: [],
      });
      if (answers === null) return { status: "pending" as const };

      const agent = yield* settingsSvc.resolveAgent().pipe(Effect.orElseSucceed(() => null));
      if (agent === null) return { status: "pending" as const };

      const override = routeFromAnswers(answers, {
        agent,
        configuredModel: settings.aiModel,
        configuredEffort: settings.aiThinkingEffort,
        autoSizing,
      });
      return {
        status: "ready" as const,
        // Only authoritative when the risk hook is on — otherwise the agent
        // sets its own tier during Phase A and this would contradict it.
        riskLevel: wantsRisk ? answers.riskLevel : null,
        model: override?.model ?? null,
        thinkingEffort: override?.thinkingEffort ?? null,
      };
    }).pipe(Effect.catchAll(() => Effect.succeed({ status: "pending" as const }))),
  );
}
