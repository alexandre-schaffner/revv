import type { AcpAgentId, RiskLevel, UserSettings } from "@revv/shared";
import {
  filePriorityOrder,
  type JobStartAnswers,
  routeFromAnswers,
  splitRecommendation,
} from "./job-start";
import type { GenerationLaunchOverride } from "./routing";

export interface JobStartPlan {
  readonly assignedRisk: RiskLevel | null;
  readonly filePriorities: ReadonlyArray<{
    readonly filename: string;
    readonly tier: number | null;
  }> | null;
  readonly splitRecommendation: { readonly pieces: number } | null;
  readonly launchOverride: GenerationLaunchOverride | null;
}

type JobStartSettings = Pick<UserSettings, "aiModel" | "aiThinkingEffort" | "jev">;

export function shouldResolveJobStart(input: {
  readonly settings: JobStartSettings;
  readonly trigger: "user" | "resume" | "review_requested";
  readonly cacheWillHit: boolean;
}): boolean {
  return input.settings.jev.enabled && input.trigger !== "resume" && !input.cacheWillHit;
}

/** Pure projection from one cached answer into every job-start consumer. */
export function buildJobStartPlan(input: {
  readonly settings: JobStartSettings;
  readonly agent: AcpAgentId;
  readonly files: ReadonlyArray<{ readonly filename: string }>;
  readonly answers: JobStartAnswers | null;
}): JobStartPlan {
  const { settings, answers } = input;
  if (answers === null) {
    return {
      assignedRisk: null,
      filePriorities: null,
      splitRecommendation: null,
      launchOverride: null,
    };
  }
  return {
    assignedRisk: settings.jev.enabled ? answers.riskLevel : null,
    filePriorities: settings.jev.enabled ? filePriorityOrder(answers, input.files) : null,
    splitRecommendation: splitRecommendation(answers),
    launchOverride: routeFromAnswers(answers, {
      agent: input.agent,
      configuredModel: settings.aiModel,
      configuredEffort: settings.aiThinkingEffort,
      autoSizing: settings.jev.enabled,
    }),
  };
}
