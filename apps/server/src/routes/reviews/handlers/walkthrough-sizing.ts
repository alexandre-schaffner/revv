import { AUTO_MODEL_SENTINEL, type RiskLevel } from "@revv/shared";
import { Effect } from "effect";
import { resolveJobStartAnswers, routeFromAnswers } from "../../../ai/jev/job-start";
import { AppRuntime } from "../../../runtime";
import { DiffCacheService } from "../../../services/DiffCache";
import { PrContextService } from "../../../services/PrContext";
import { SettingsService } from "../../../services/Settings";

type WalkthroughSizing =
  /** Nothing to size — neither the risk nor the auto-model hook is on. */
  | { readonly status: "off" }
  /** A hook is on, but the diff isn't cached yet, so there is nothing to size. */
  | { readonly status: "pending" }
  | {
      readonly status: "ready";
      /**
       * Tier a review of this PR would be sized to. Null when the risk hook
       * is off, in which case the agent decides its own tier mid-run and
       * showing anything here would be a guess.
       */
      readonly riskLevel: RiskLevel | null;
      /**
       * Model this PR would launch with. Null when auto-model isn't in play
       * or routing declined, in which case the configured model stands.
       */
      readonly model: string | null;
    };

/**
 * GET /api/reviews/:id/walkthrough/sizing
 *
 * Sizes the PR *before* generation starts, so the review page can show how
 * much attention it needs — and the model selector can name what "Auto"
 * will pick — without waiting for a walkthrough to exist.
 *
 * The answer is cached on `(prId, headSha)` and shared with `startJobBody`,
 * so this is not an extra API call per PR — it is the same call, moved
 * earlier. Clicking Generate afterwards hits the cache, which takes the
 * TypeSafe round trip off the one path where its latency is user-visible.
 *
 * Reads the **cached** diff only and never fetches from GitHub: a preview is
 * a nicety, and it must not turn opening a PR into a rate-limit risk. Before
 * the diff lands this reports `pending`, and the client tries again once the
 * review page has loaded its files.
 */
export function getWalkthroughSizingHandler(
  prId: string,
  userId: string,
): Promise<WalkthroughSizing> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
      // Auto-model only means anything when a model isn't pinned; the risk
      // tier is useful either way. Both read the same cached answers, so
      // either hook alone is enough to make the call worth making.
      const wantsModel =
        settings?.jev.autoModel === true && settings.aiModel === AUTO_MODEL_SENTINEL;
      const wantsRisk = settings?.jev.risk === true;
      if (settings === null || !settings.jev.enabled || (!wantsModel && !wantsRisk)) {
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

      const override = wantsModel
        ? routeFromAnswers(answers, {
            agent,
            configuredModel: settings.aiModel,
            autoModel: true,
          })
        : null;
      return {
        status: "ready" as const,
        // Only authoritative when the risk hook is on — otherwise the agent
        // sets its own tier during Phase A and this would contradict it.
        riskLevel: wantsRisk ? answers.riskLevel : null,
        model: override?.model ?? null,
      };
    }).pipe(Effect.catchAll(() => Effect.succeed({ status: "pending" as const }))),
  );
}
