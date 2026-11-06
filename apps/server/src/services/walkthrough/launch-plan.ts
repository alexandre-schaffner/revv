// ── What a walkthrough run is, decided once ──────────────────────────────────
// Every input a run of a walkthrough row needs is resolved here, when the row
// is created: the generation mode and its base, the stack and a restack carry,
// the job-start judgment (risk tier, reading order, sizing), the agent launch
// and the provider config recorded with it, and the row's owner. The launch
// half is persisted on the row (`walkthroughs.launch_plan`) so every later run
// of it — auto-continuations, resume-on-boot — launches the same way and the
// recorded model is the one that ran.

import type {
  AcpAgentId,
  RiskLevel,
  StartJobTrigger,
  UserSettings,
  WalkthroughGenerationMode,
  WalkthroughMode,
  WalkthroughStackSnapshot,
} from "@revv/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { agentLaunchFor } from "../../ai/acp/agent-launch";
import { resolveJobStart } from "../../ai/jev/job-start-resolution";
import type { GenerationLaunchOverride } from "../../ai/jev/routing";
import type { Db } from "../../db";
import { account } from "../../db/schema/auth";
import { remoteUsers } from "../../db/schema/remote-users";
import { repositories } from "../../db/schema/repositories";
import {
  type DiffFingerprint,
  type WalkthroughLaunchPlan,
  walkthroughs,
} from "../../db/schema/walkthroughs";
import type { DbError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import type { CacheService } from "../Cache";
import type { DbService } from "../Db";
import type { JevService } from "../Jev";
import type { PrContextWithDiff } from "../PrContext";
import { changedFiles, fingerprintFiles, isComparable } from "../stacks/fingerprint";
import { type RestackSource, WalkthroughService } from "../Walkthrough";
import type { GeneratedBy, GenerationProviderConfig } from "../walkthrough-cache-format";

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
    provider:
      plan.agent === "opencode"
        ? "opencode"
        : plan.agent === "codex"
          ? "codex"
          : "claude-agent-sdk",
    model: plan.model,
    thinkingEffort: plan.thinkingEffort,
    contextWindow: "1m",
    maxTurns,
  };
}

export interface WalkthroughOwner {
  /** The account that owns the repository; empty when the lookup found none. */
  readonly accountId: string;
  readonly generatedBy?: GeneratedBy;
}

/** Best-effort attribution for the OAuth account that owns a repository. */
function resolveOwner(db: Db, repoId: string): WalkthroughOwner {
  const repoRow = db
    .select({ accountId: repositories.accountId })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .get();
  if (!repoRow) return { accountId: "" };

  const owner = db
    .select({ accountId: account.accountId, githubLogin: account.githubLogin })
    .from(account)
    .where(eq(account.id, repoRow.accountId))
    .get();
  if (!owner?.githubLogin) return { accountId: repoRow.accountId };

  const parsedUserId = Number(owner.accountId);
  const avatarContent =
    db
      .select({ avatarContent: remoteUsers.avatarContent })
      .from(remoteUsers)
      .where(eq(remoteUsers.login, owner.githubLogin))
      .get()?.avatarContent ?? null;

  return {
    accountId: repoRow.accountId,
    generatedBy: {
      githubUserId: Number.isFinite(parsedUserId) ? parsedUserId : 0,
      githubLogin: owner.githubLogin,
      displayName: null,
      avatarContent,
    },
  };
}

export interface WalkthroughLaunchDecision {
  readonly generationMode: WalkthroughGenerationMode;
  readonly parentWalkthroughId: string | null;
  readonly baseHeadSha: string | null;
  readonly stack: WalkthroughStackSnapshot | null;
  readonly diffFingerprint: DiffFingerprint;
  readonly parentFingerprint: DiffFingerprint | null;
  readonly restack: RestackCarry | null;
  readonly plan: WalkthroughLaunchPlan;
  /** The plan was resolved now rather than read off the existing row. */
  readonly planIsNew: boolean;
  /** Orchestrator-assigned risk tier (invariant 2's carve-out); null when the agent judges it. */
  readonly risk: { readonly level: RiskLevel; readonly confidence: number } | null;
  readonly providerConfig: GenerationProviderConfig;
  readonly owner: WalkthroughOwner;
}

/** The row this run continues, when there is one. */
interface ExistingRow {
  readonly id: string;
  readonly parentWalkthroughId?: string | null | undefined;
  readonly baseHeadSha?: string | null | undefined;
}

export function planWalkthroughLaunch(input: {
  readonly db: Db;
  readonly resolved: PrContextWithDiff;
  readonly mode: WalkthroughMode;
  readonly requestedGenerationMode: WalkthroughGenerationMode;
  readonly existing: ExistingRow | null;
  readonly trigger: StartJobTrigger;
  readonly settings: UserSettings;
  readonly agent: AcpAgentId;
  readonly snapshotStack: Effect.Effect<WalkthroughStackSnapshot | null>;
  /** Whether the team cache holds this head; a hit skips the job-start judgment. */
  readonly cacheProbe: Effect.Effect<boolean>;
}): Effect.Effect<
  WalkthroughLaunchDecision,
  DbError,
  WalkthroughService | JevService | CacheService | DbService
> {
  return Effect.gen(function* () {
    const { db, resolved, existing, mode } = input;
    const { pr, repo, files, commits, meta } = resolved;
    const walkthroughService = yield* WalkthroughService;

    const priorArtifact =
      existing === null && input.requestedGenerationMode === "incremental"
        ? yield* walkthroughService.findLatestReviewArtifact(pr.id, mode)
        : null;
    const parentWalkthroughId = existing?.parentWalkthroughId ?? priorArtifact?.id ?? null;
    const baseHeadSha = existing?.baseHeadSha ?? priorArtifact?.prHeadSha ?? null;
    // An incremental run whose base is its own head has nothing to review, so
    // it reviews the full PR diff. Only a fresh row: an existing row's mode is
    // part of its identity.
    const emptyIncrementalRange = existing === null && baseHeadSha === meta.headSha;
    const resolvedGenerationMode: WalkthroughGenerationMode =
      input.requestedGenerationMode === "incremental" &&
      parentWalkthroughId &&
      baseHeadSha &&
      !emptyIncrementalRange
        ? "incremental"
        : "full";

    const storedInputs = (walkthroughId: string) =>
      walkthroughService.getStackInputs(walkthroughId).pipe(Effect.orElseSucceed(() => null));
    const diffFingerprint = fingerprintFiles(files);
    const stack =
      existing !== null
        ? ((yield* storedInputs(existing.id))?.stackContext ?? null)
        : yield* input.snapshotStack;
    const restack =
      stack !== null && existing === null && input.trigger !== "resume"
        ? planRestackCarry(
            yield* walkthroughService
              .findRestackSource(pr.id, meta.headSha, mode)
              .pipe(Effect.orElseSucceed(() => null)),
            input.requestedGenerationMode,
            diffFingerprint,
          )
        : null;
    const generationMode = restack?.generationMode ?? resolvedGenerationMode;
    const parentFingerprint =
      stack !== null && generationMode === "incremental" && parentWalkthroughId !== null
        ? ((yield* storedInputs(parentWalkthroughId))?.diffFingerprint ?? null)
        : null;

    const storedPlan =
      existing === null
        ? null
        : ((yield* dbTry("read launch plan", () =>
            db
              .select({ launchPlan: walkthroughs.launchPlan })
              .from(walkthroughs)
              .where(eq(walkthroughs.id, existing.id))
              .get(),
          ))?.launchPlan ?? null);

    let plan = storedPlan;
    let risk: WalkthroughLaunchDecision["risk"] = null;
    if (plan === null) {
      const start = yield* resolveJobStart({
        prId: pr.id,
        headSha: meta.headSha,
        state: { pr, files, commits },
        settings: input.settings,
        agent: input.agent,
        trigger: input.trigger,
        cacheProbe: restack !== null ? Effect.succeed(true) : input.cacheProbe,
      });
      risk =
        start.assignedRisk !== null && start.answers !== null
          ? { level: start.assignedRisk, confidence: start.answers.riskConfidence }
          : null;
      plan = {
        ...launchFor(input.settings, input.agent, start.launchOverride),
        sizing: start.launchOverride,
        filePriorities: start.filePriorities,
        splitRecommendation: start.splitRecommendation,
        adjudicateContinuations: input.settings.jev.enabled,
      };
    }

    return {
      generationMode,
      parentWalkthroughId,
      baseHeadSha,
      stack,
      diffFingerprint,
      parentFingerprint,
      restack,
      plan,
      planIsNew: storedPlan === null,
      risk,
      providerConfig: providerConfigFor(plan, input.settings.aiMaxTurns),
      owner: resolveOwner(db, repo.id),
    };
  });
}
