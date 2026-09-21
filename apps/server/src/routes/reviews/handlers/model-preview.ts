import { AUTO_MODEL_SENTINEL, type RiskLevel } from "@revv/shared";
import { Effect } from "effect";
import { resolveJobStartAnswers, routeFromAnswers } from "../../../ai/jev/job-start";
import { AppRuntime } from "../../../runtime";
import { DiffCacheService } from "../../../services/DiffCache";
import { PrContextService } from "../../../services/PrContext";
import { SettingsService } from "../../../services/Settings";

type ModelPreview =
  /** Auto isn't in play — the configured model stands and needs no preview. */
  | { readonly status: "off" }
  /** Auto is on, but the diff isn't cached yet, so there is nothing to size. */
  | { readonly status: "pending" }
  | {
      readonly status: "ready";
      /** Model this PR would launch with. Null = the agent's own default. */
      readonly model: string | null;
      readonly riskLevel: RiskLevel;
    };

/**
 * GET /api/reviews/:id/walkthrough/model-preview
 *
 * Sizes the PR *before* generation starts, so the model selector can name
 * what "Auto" will pick rather than leaving it blank until a run finishes.
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
export function getModelPreviewHandler(prId: string, userId: string): Promise<ModelPreview> {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const settings = yield* settingsSvc.getSettings().pipe(Effect.orElseSucceed(() => null));
      if (
        settings === null ||
        !settings.jev.enabled ||
        !settings.jev.autoModel ||
        settings.aiModel !== AUTO_MODEL_SENTINEL
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
        autoModel: true,
      });
      return {
        status: "ready" as const,
        model: override?.model ?? null,
        riskLevel: answers.riskLevel,
      };
    }).pipe(Effect.catchAll(() => Effect.succeed({ status: "pending" as const }))),
  );
}
