import type {
  AcpAgentId,
  GeneratedBy,
  GenerationProviderConfig,
  ThinkingEffort,
  ThinkingEffortSetting,
} from "@revv/shared";
import { resolveThinkingEffort } from "@revv/shared";
import { eq } from "drizzle-orm";
import { resolveGenerationModel } from "../ai/acp/presets";
import type { Db } from "../db";
import { account } from "../db/schema/auth";
import { remoteUsers } from "../db/schema/remote-users";
import { repositories } from "../db/schema/repositories";

function buildWalkthroughProviderConfig(input: {
  readonly agent: AcpAgentId;
  readonly model: string;
  readonly configuredEffort: ThinkingEffortSetting;
  readonly routedEffort: ThinkingEffort | null | undefined;
  readonly maxTurns: number;
}): GenerationProviderConfig {
  return {
    provider:
      input.agent === "opencode"
        ? "opencode"
        : input.agent === "codex"
          ? "codex"
          : "claude-agent-sdk",
    model: input.model,
    thinkingEffort: resolveThinkingEffort(input.configuredEffort, input.routedEffort) ?? null,
    contextWindow: "1m",
    maxTurns: input.maxTurns,
  };
}

/** Resolve the guarded model and the immutable provider snapshot for one job. */
export function resolveWalkthroughLaunch(input: {
  readonly agent: AcpAgentId;
  readonly trigger: "user" | "resume" | "review_requested";
  readonly configuredModel: string;
  readonly routedModel: string | null | undefined;
  readonly priorModel: string | null | undefined;
  readonly configuredEffort: ThinkingEffortSetting;
  readonly routedEffort: ThinkingEffort | null | undefined;
  readonly maxTurns: number;
}): { readonly modelUsed: string; readonly providerConfig: GenerationProviderConfig } {
  const freshModel =
    resolveGenerationModel(input.agent, input.routedModel ?? input.configuredModel) ??
    (input.agent === "opencode" ? "opencode" : "claude-sonnet-4-20250514");
  const modelUsed =
    input.trigger !== "resume" && input.priorModel && input.priorModel !== "unknown"
      ? input.priorModel
      : freshModel;
  return {
    modelUsed,
    providerConfig: buildWalkthroughProviderConfig({
      agent: input.agent,
      model: modelUsed,
      configuredEffort: input.configuredEffort,
      routedEffort: input.routedEffort,
      maxTurns: input.maxTurns,
    }),
  };
}

/** Best-effort attribution for the OAuth account that owns a repository. */
export function resolveWalkthroughOwner(
  db: Db,
  repoId: string,
): { readonly accountId: string; readonly generatedBy?: GeneratedBy } {
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
