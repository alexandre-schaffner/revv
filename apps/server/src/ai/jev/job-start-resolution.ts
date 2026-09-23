import type { AcpAgentId, UserSettings } from "@revv/shared";
import { Effect } from "effect";
import type { CacheService } from "../../services/Cache";
import type { DbService } from "../../services/Db";
import type { JevService } from "../../services/Jev";
import { type JobStartAnswers, resolveJobStartAnswers } from "./job-start";
import { buildJobStartPlan, type JobStartPlan, shouldResolveJobStart } from "./job-start-plan";
import type { JobStartStateInput } from "./state";

/** Resolve the optional cached judgment and project it into launch inputs. */
export function resolveJobStart(input: {
  readonly prId: string;
  readonly headSha: string;
  readonly state: JobStartStateInput;
  readonly settings: Pick<UserSettings, "aiModel" | "aiThinkingEffort" | "jev">;
  readonly agent: AcpAgentId;
  readonly trigger: "user" | "resume" | "review_requested";
  readonly cacheProbe: Effect.Effect<boolean>;
}): Effect.Effect<
  JobStartPlan & { readonly answers: JobStartAnswers | null },
  never,
  JevService | CacheService | DbService
> {
  return Effect.gen(function* () {
    const cacheWillHit = yield* input.cacheProbe;
    const answers = shouldResolveJobStart({
      settings: input.settings,
      trigger: input.trigger,
      cacheWillHit,
    })
      ? yield* resolveJobStartAnswers(input.prId, input.headSha, input.state)
      : null;
    return {
      ...buildJobStartPlan({
        settings: input.settings,
        agent: input.agent,
        files: input.state.files,
        answers,
      }),
      answers,
    };
  });
}
