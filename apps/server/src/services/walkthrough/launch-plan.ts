// Every input a run of a walkthrough row needs, resolved once and recorded on
// the row. When the row is created: its generation mode and base, the stack,
// and whether a restack carries a finished review into it. Before its first
// run — only once nothing could be imported into it — the job-start judgment
// (risk tier, reading order, sizing) and the agent launch with the provider
// config shown for it (`walkthroughs.launch_plan`), so every later run of it
// (auto-continuations, resume-on-boot) launches the same way.

import type {
  AcpAgentId,
  RiskLevel,
  UserSettings,
  WalkthroughGenerationMode,
  WalkthroughMode,
  WalkthroughStackSnapshot,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { agentLaunchFor } from "../../ai/acp/agent-launch";
import {
  filePriorityOrder,
  type JobStartAnswers,
  resolveJobStartAnswers,
  routeFromAnswers,
  splitRecommendation,
} from "../../ai/jev/job-start";
import type { GenerationLaunchOverride } from "../../ai/jev/routing";
import type { JobStartStateInput } from "../../ai/jev/state";
import type { Db } from "../../db";
import { account } from "../../db/schema/auth";
import { avatarOfHostLogin } from "../../db/schema/remote-users";
import { repositories } from "../../db/schema/repositories";
import type { DiffFingerprint, WalkthroughLaunchPlan } from "../../db/schema/walkthroughs";
import type { DbError } from "../../domain/errors";
import type { CacheService } from "../Cache";
import type { JevService } from "../Jev";
import { changedFiles, fingerprintFiles, isComparable } from "../stacks/fingerprint";
import type { GeneratedBy, GenerationProviderConfig } from "./cache-format";
import { type RestackSource, WalkthroughService } from "./Walkthrough";

export interface JobStartPlan {
  readonly assignedRisk: RiskLevel | null;
  readonly filePriorities: ReadonlyArray<{
    readonly filename: string;
    readonly tier: number | null;
  }> | null;
  readonly splitRecommendation: { readonly pieces: number } | null;
  readonly launchOverride: GenerationLaunchOverride | null;
}

type JobStartSettings = Pick<UserSettings, "aiModel" | "aiThinkingEffort">;

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
    assignedRisk: answers.riskLevel,
    filePriorities: filePriorityOrder(answers, input.files),
    splitRecommendation: splitRecommendation(answers),
    launchOverride: routeFromAnswers(answers, {
      agent: input.agent,
      configuredModel: settings.aiModel,
      configuredEffort: settings.aiThinkingEffort,
    }),
  };
}

export interface RestackCarry {
  readonly fromWalkthroughId: string;
  readonly generationMode: WalkthroughGenerationMode;
}

/** A restack left this layer's own changes byte-identical: carry the finished review over. */
export function planRestackCarry(
  source: RestackSource | null,
  requestedMode: WalkthroughGenerationMode,
  fingerprint: DiffFingerprint,
): RestackCarry | null {
  if (source === null || !isComparable(fingerprint)) return null;
  if (source.generationMode !== "full" && source.generationMode !== requestedMode) return null;
  if (changedFiles(source.diffFingerprint, fingerprint).length > 0) return null;
  return { fromWalkthroughId: source.id, generationMode: source.generationMode };
}

/** The agent launch for `plan`'s sizing under the current settings. */
export function launchFor(
  settings: UserSettings,
  agent: AcpAgentId,
  sizing: GenerationLaunchOverride | null,
): Pick<WalkthroughLaunchPlan, "agent" | "model" | "thinkingEffort"> {
  const launch = agentLaunchFor(settings, agent, "review", sizing);
  return { agent, model: launch.model, thinkingEffort: launch.thinkingEffort ?? null };
}

export function providerConfigFor(
  plan: WalkthroughLaunchPlan,
  maxTurns: number,
): GenerationProviderConfig {
  return {
    provider: plan.agent,
    model: plan.model,
    thinkingEffort: plan.thinkingEffort,
    contextWindow: "1m",
    maxTurns,
  };
}

/**
 * The GitHub identity a review is attributed to: the account that owns the
 * repository. Undefined when the account has no GitHub login on record.
 */
export function generatedByOf(
  db: Db,
  repo: { readonly id: string; readonly accountId: string; readonly githubHost: string },
): GeneratedBy | undefined {
  const owner = db
    .select({ accountId: account.accountId, githubLogin: account.githubLogin })
    .from(account)
    .where(eq(account.id, repo.accountId))
    .get();
  if (!owner?.githubLogin) return undefined;
  const parsedUserId = Number(owner.accountId);
  return {
    githubUserId: Number.isFinite(parsedUserId) ? parsedUserId : 0,
    githubLogin: owner.githubLogin,
    displayName: null,
    avatarContent:
      db
        .select({ avatarContent: avatarOfHostLogin(owner.githubLogin, repo.githubHost) })
        .from(repositories)
        .where(eq(repositories.id, repo.id))
        .get()?.avatarContent ?? null,
  };
}

/**
 * The fingerprint of the review an incremental stacked run builds on, so the
 * run can tell this layer's own changes from what a restack brought in.
 */
export function parentFingerprintOf(
  stack: WalkthroughStackSnapshot | null,
  generationMode: WalkthroughGenerationMode,
  parentWalkthroughId: string | null,
): Effect.Effect<DiffFingerprint | null, DbError, WalkthroughService> {
  if (stack === null || generationMode !== "incremental" || parentWalkthroughId === null) {
    return Effect.succeed(null);
  }
  return Effect.flatMap(WalkthroughService, (walkthroughs) =>
    walkthroughs.getStackInputs(parentWalkthroughId),
  ).pipe(Effect.map((inputs) => inputs?.diffFingerprint ?? null));
}

/** What a new row is, decided when it is created. */
export interface NewRowPlan {
  readonly generationMode: WalkthroughGenerationMode;
  readonly parentWalkthroughId: string | null;
  readonly baseHeadSha: string | null;
  readonly stack: WalkthroughStackSnapshot | null;
  readonly diffFingerprint: DiffFingerprint;
  /** A finished review the new row takes over instead of running an agent. */
  readonly restack: RestackCarry | null;
}

export function planNewRow(input: {
  readonly prId: string;
  readonly headSha: string;
  readonly files: JobStartStateInput["files"];
  readonly mode: WalkthroughMode;
  readonly requestedGenerationMode: WalkthroughGenerationMode;
  readonly snapshotStack: Effect.Effect<WalkthroughStackSnapshot | null>;
}): Effect.Effect<NewRowPlan, DbError, WalkthroughService> {
  return Effect.gen(function* () {
    const { prId, headSha, mode } = input;
    const walkthroughService = yield* WalkthroughService;

    const prior =
      input.requestedGenerationMode === "incremental"
        ? yield* walkthroughService.findLatestReviewArtifact(prId, mode)
        : null;
    // An incremental run whose base is its own head has nothing to review, so
    // it reviews the full PR diff.
    const resolvedGenerationMode: WalkthroughGenerationMode =
      prior !== null && prior.prHeadSha !== headSha ? "incremental" : "full";

    const diffFingerprint = fingerprintFiles(input.files);
    const stack = yield* input.snapshotStack;
    const restack =
      stack !== null
        ? planRestackCarry(
            yield* walkthroughService.findRestackSource(prId, headSha, mode),
            input.requestedGenerationMode,
            diffFingerprint,
          )
        : null;
    const generationMode = restack?.generationMode ?? resolvedGenerationMode;
    return {
      generationMode,
      parentWalkthroughId: prior?.id ?? null,
      baseHeadSha: prior?.prHeadSha ?? null,
      stack,
      diffFingerprint,
      restack,
    };
  });
}

/** How a row's runs launch, and the risk tier the orchestrator assigns it (invariant 2's carve-out). */
export interface LaunchPlan {
  readonly plan: WalkthroughLaunchPlan;
  /** Null when the agent judges the tier itself. */
  readonly risk: { readonly level: RiskLevel; readonly confidence: number } | null;
}

/**
 * The launch for a row about to run. With `state`, the job-start judgment
 * sizes it and assigns the risk tier; without, the configured launch runs
 * unsized and the agent judges the tier.
 */
export function planLaunch(input: {
  readonly prId: string;
  readonly headSha: string;
  readonly state: JobStartStateInput | null;
  readonly settings: UserSettings;
  readonly agent: AcpAgentId;
}): Effect.Effect<LaunchPlan, never, JevService | CacheService> {
  return Effect.gen(function* () {
    const answers =
      input.state === null
        ? null
        : yield* resolveJobStartAnswers(input.prId, input.headSha, input.state);
    const start = buildJobStartPlan({
      settings: input.settings,
      agent: input.agent,
      files: input.state?.files ?? [],
      answers,
    });
    return {
      plan: {
        ...launchFor(input.settings, input.agent, start.launchOverride),
        sizing: start.launchOverride,
        filePriorities: start.filePriorities,
        splitRecommendation: start.splitRecommendation,
      },
      risk:
        start.assignedRisk !== null && answers !== null
          ? { level: start.assignedRisk, confidence: answers.riskConfidence }
          : null,
    };
  });
}
