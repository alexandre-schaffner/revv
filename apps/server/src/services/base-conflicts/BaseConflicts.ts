// ── BaseConflictsService ───────────────────────────────────────────────────
//
// The Conversation tab's "conflicts with the base branch" card. `check` asks
// git which files conflict (`git merge-tree` over freshly fetched tips; GitHub
// only says *whether*). `resolve` brings the PR up to date with its base the
// way Settings says — merge the base in, or rebase onto it — in a scratch
// worktree, hands any conflict to a one-shot agent run
// (`AiService.resolveMergeConflict`), checks the agent's result, and pushes it
// leased on the head the run started from.
//
// Nothing here persists: the only durable effect is the push, which is
// atomic, and a run killed mid-way leaves only the scratch worktree, which the
// next run clears before it starts.

import { join } from "node:path";
import {
  ACP_AGENT_IDS,
  type BaseConflictFrame,
  type BaseConflictStrategy,
  type BaseConflictsCheck,
} from "@revv/shared";
import { Context, Effect, Layer, Queue } from "effect";
import type { ResolveConflictsTask } from "../../ai/prompts/chat";
import { serverEnv } from "../../config";
import {
  AiNotConfiguredError,
  BaseConflictsRejectedError,
  type BaseConflictsRejection,
} from "../../domain/errors";
import { keyedSingleFlight } from "../../effects/keyed-single-flight";
import { logError } from "../../logger";
import { AiService } from "../Ai";
import { pumpAgentFrames, queueToStream } from "../agent-frame-pump";
import { Broadcaster } from "../Broadcaster";
import { ChatSessionService } from "../ChatSession";
import { worktreeHolderPath } from "../clone-policy";
import type { DbService } from "../Db";
import type { GitHubEtagCache } from "../GitHubEtagCache";
import { assertNotFlagLike, isAncestor, lsRemoteHead, proposedCommitCount } from "../GitOps";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { PrPushLockService } from "../PrPushLock";
import { PullRequestService } from "../PullRequest";
import { makePrHeadRefresh } from "../pr-head-refresh";
import { SettingsService } from "../Settings";
import {
  checkTips,
  clearScratch,
  deleteTipRefs,
  fetchTips,
  type OperationInput,
  prepareScratch,
  pushResult,
  type SyncRepo,
  startOperation,
  verifyResolution,
} from "./git";

/** A check this fresh, for the same PR head, is served from memory. */
const CHECK_FRESH_MS = 30_000;

export type BaseConflictsError = BaseConflictsRejectedError | AiNotConfiguredError | PrContextError;

export class BaseConflictsService extends Context.Service<
  BaseConflictsService,
  {
    readonly check: (params: {
      readonly prId: string;
      readonly userId: string;
      readonly accountId: string;
      readonly force?: boolean;
    }) => Effect.Effect<BaseConflictsCheck, BaseConflictsError, DbService>;
    /**
     * Start bringing the PR up to date with its base, as long as its branch is
     * still at `expectedHeadSha`. Refusals fail before anything runs; once the
     * stream is returned, the run ends in exactly one `result` frame.
     */
    readonly resolve: (params: {
      readonly prId: string;
      readonly userId: string;
      readonly accountId: string;
      readonly expectedHeadSha: string;
    }) => Effect.Effect<
      ReadableStream<BaseConflictFrame>,
      BaseConflictsError,
      DbService | GitHubEtagCache | SettingsService
    >;
  }
>()("BaseConflictsService") {}

const rejected = (reason: BaseConflictsRejection, message: string) =>
  Effect.fail(new BaseConflictsRejectedError({ reason, message }));

const gitStep = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new BaseConflictsRejectedError({
        reason: "failed",
        message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

function describeFiles(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}

export const BaseConflictsServiceLive = Layer.effect(
  BaseConflictsService,
  Effect.gen(function* () {
    const prCtx = yield* PrContextService;
    const settings = yield* SettingsService;
    const ai = yield* AiService;
    const pushLock = yield* PrPushLockService;
    const chatSessions = yield* ChatSessionService;
    const headRefresh = makePrHeadRefresh({
      prService: yield* PullRequestService,
      prCtx,
      broadcaster: yield* Broadcaster,
    });

    const checks = new Map<
      string,
      { readonly prHeadSha: string | null; readonly at: number; readonly check: BaseConflictsCheck }
    >();
    const checkOnce = keyedSingleFlight<string, BaseConflictsCheck, never>();

    const syncRepoOf = (ctx: PrContextBasic): SyncRepo | null => {
      const { pr, repo, token } = ctx;
      if (repo.cloneStatus !== "ready" || !repo.clonePath) return null;
      const host = repo.githubHost || serverEnv.githubHost;
      return {
        clonePath: repo.clonePath,
        remoteUrl: `https://x-access-token:${token}@${host}/${repo.fullName}.git`,
        prNumber: pr.externalId,
        baseBranch: pr.targetBranch,
      };
    };

    /**
     * Agent commits waiting in the PR's chat worktree. The worktree is one
     * per PR whichever agent made the session, so the first session found
     * answers for all of them.
     */
    const unpushedAgentCommits = (prId: string) =>
      Effect.gen(function* () {
        const configured = yield* settings.resolveChatAgentId();
        for (const agent of [configured, ...ACP_AGENT_IDS.filter((id) => id !== configured)]) {
          const found = yield* chatSessions.findLatestForPrWithBase(prId, agent);
          if (!found) continue;
          const { row, baseSha } = found;
          const count = yield* Effect.promise(() =>
            proposedCommitCount(row.worktreePath, `${baseSha}..${row.branchName}`).catch(() => "0"),
          );
          const n = Number.parseInt(count.trim(), 10);
          return Number.isFinite(n) ? n : 0;
        }
        return 0;
      });

    const unavailable = (
      ctx: PrContextBasic,
      reason: string,
      unpushed: number,
    ): BaseConflictsCheck => ({
      status: "unavailable",
      baseBranch: ctx.pr.targetBranch,
      headSha: ctx.pr.headSha,
      baseSha: null,
      files: [],
      behindBy: null,
      touchesWorkflows: false,
      unpushedAgentCommits: unpushed,
      resolving: pushLock.holder(ctx.pr.id) === "base-sync",
      reason,
      checkedAt: new Date().toISOString(),
    });

    const computeCheck = (ctx: PrContextBasic): Effect.Effect<BaseConflictsCheck> =>
      Effect.gen(function* () {
        const unpushed = yield* unpushedAgentCommits(ctx.pr.id);
        const repo = syncRepoOf(ctx);
        if (!repo) {
          return unavailable(ctx, `Revv's copy of ${ctx.repo.fullName} isn't ready yet`, unpushed);
        }
        const run = Effect.promise(async () => {
          try {
            const tips = await fetchTips(repo, `refs/pull/${repo.prNumber}/head`);
            if (tips.kind === "failed") return tips;
            const checked = await checkTips(repo.clonePath, tips);
            return "kind" in checked ? checked : { ...checked, tips };
          } finally {
            await deleteTipRefs(repo);
          }
        });
        const result = yield* run;
        if ("kind" in result) {
          logError("base-conflicts", `check failed (pr=${ctx.pr.id}): ${result.message}`);
          return unavailable(ctx, result.message, unpushed);
        }
        return {
          status: result.status,
          baseBranch: repo.baseBranch,
          headSha: result.tips.headTip,
          baseSha: result.tips.baseTip,
          files: result.files,
          behindBy: result.behindBy,
          touchesWorkflows: result.touchesWorkflows,
          unpushedAgentCommits: unpushed,
          resolving: pushLock.holder(ctx.pr.id) === "base-sync",
          checkedAt: new Date().toISOString(),
        } satisfies BaseConflictsCheck;
      });

    const check: Context.Service.Shape<typeof BaseConflictsService>["check"] = (params) =>
      Effect.gen(function* () {
        const ctx = yield* prCtx.resolveBasic(params.prId, params.userId, params.accountId);
        const cached = checks.get(ctx.pr.id);
        const resolving = pushLock.holder(ctx.pr.id) === "base-sync";
        // A running sync owns the fetched refs; answer from memory meanwhile.
        if (
          cached &&
          (resolving ||
            (!params.force &&
              cached.prHeadSha === ctx.pr.headSha &&
              Date.now() - cached.at < CHECK_FRESH_MS))
        ) {
          return { ...cached.check, resolving };
        }
        if (resolving) return unavailable(ctx, "Revv is bringing this branch up to date", 0);
        return yield* checkOnce(
          ctx.pr.id,
          computeCheck(ctx).pipe(
            Effect.tap((fresh) =>
              Effect.sync(() =>
                checks.set(ctx.pr.id, { prHeadSha: ctx.pr.headSha, at: Date.now(), check: fresh }),
              ),
            ),
          ),
        );
      });

    /** Everything up to the paused (or clean) operation, failing as a refusal. */
    const prepare = (
      params: Parameters<Context.Service.Shape<typeof BaseConflictsService>["resolve"]>[0],
      scratch: { path: string | null; repo: SyncRepo | null },
    ) =>
      Effect.gen(function* () {
        const ctx = yield* prCtx.resolveBasic(params.prId, params.userId, params.accountId);
        const { pr } = ctx;
        if (pr.status !== "open") {
          return yield* rejected("invalid", `#${pr.externalId} is ${pr.status}`);
        }
        const repo = syncRepoOf(ctx);
        if (!repo) {
          return yield* rejected(
            "unavailable",
            `Revv's copy of ${ctx.repo.fullName} isn't ready yet`,
          );
        }
        scratch.repo = repo;
        if (!(yield* ai.isConfigured())) return yield* Effect.fail(new AiNotConfiguredError());
        yield* Effect.try({
          try: () => {
            assertNotFlagLike(pr.sourceBranch, "sourceBranch");
            assertNotFlagLike(pr.targetBranch, "targetBranch");
          },
          catch: () =>
            new BaseConflictsRejectedError({ reason: "invalid", message: "Unusable branch name" }),
        });
        const strategy: BaseConflictStrategy =
          (yield* settings.getSettings().pipe(Effect.orElseSucceed(() => null)))
            ?.baseConflictStrategy ?? "merge";

        const remoteHead = yield* gitStep("Couldn't read the PR's branch", () =>
          lsRemoteHead(repo.clonePath, repo.remoteUrl, pr.sourceBranch),
        );
        if (!remoteHead) {
          return yield* rejected(
            "invalid",
            `${pr.sourceBranch} isn't a branch of ${ctx.repo.fullName}; Revv can't push to a fork`,
          );
        }
        if (remoteHead !== params.expectedHeadSha) {
          return yield* rejected("stale", "This PR got new commits since you looked — try again");
        }
        if (strategy === "rebase") {
          const unpushed = yield* unpushedAgentCommits(pr.id);
          if (unpushed > 0) {
            return yield* rejected(
              "invalid",
              `Push or discard the agent's ${unpushed} unpushed commit${unpushed === 1 ? "" : "s"} first — a rebase would strand them`,
            );
          }
        }

        const tips = yield* gitStep("Couldn't fetch", () =>
          fetchTips(repo, `refs/heads/${pr.sourceBranch}`),
        );
        if (tips.kind === "failed") return yield* rejected("unavailable", tips.message);
        if (tips.headTip !== remoteHead) {
          return yield* rejected("stale", "This PR got new commits since you looked — try again");
        }
        if (
          yield* gitStep("Couldn't compare", () =>
            isAncestor(repo.clonePath, tips.baseTip, tips.headTip),
          )
        ) {
          return yield* rejected(
            "invalid",
            `${pr.sourceBranch} is already up to date with ${pr.targetBranch}`,
          );
        }

        const [owner = "", name = ""] = ctx.repo.fullName.split("/");
        scratch.path = join(worktreeHolderPath(owner, name), `base-sync-pr-${pr.externalId}`);
        const prepared = yield* gitStep("Couldn't prepare a worktree", () =>
          prepareScratch(repo.clonePath, scratch.path ?? "", tips.headTip),
        );
        if (prepared.kind === "failed") return yield* rejected("failed", prepared.message);

        const op: OperationInput = {
          strategy,
          scratchPath: scratch.path,
          tips,
          baseBranch: pr.targetBranch,
          sourceBranch: pr.sourceBranch,
        };
        const started = yield* gitStep(`git ${strategy} failed`, () => startOperation(op));
        if (started.kind === "failed") return yield* rejected("failed", started.message);
        return { ctx, repo, op, remoteHead, started };
      });

    const resolve: Context.Service.Shape<typeof BaseConflictsService>["resolve"] = (params) =>
      Effect.gen(function* () {
        yield* pushLock
          .acquire(params.prId, "base-sync")
          .pipe(
            Effect.catchTag("ConcurrentPushError", () =>
              rejected("busy", "Another push to this PR is already running"),
            ),
          );
        const scratch: { path: string | null; repo: SyncRepo | null } = { path: null, repo: null };
        const cleanup = Effect.promise(async () => {
          if (scratch.repo && scratch.path)
            await clearScratch(scratch.repo.clonePath, scratch.path);
          if (scratch.repo) await deleteTipRefs(scratch.repo);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => checks.delete(params.prId)).pipe(
              Effect.andThen(pushLock.release(params.prId)),
            ),
          ),
        );

        const { ctx, repo, op, remoteHead, started } = yield* prepare(params, scratch).pipe(
          Effect.tapError(() => cleanup),
        );
        const { pr } = ctx;
        const queue = yield* Queue.unbounded<BaseConflictFrame>();
        const offer = (frame: BaseConflictFrame) => Queue.offer(queue, frame);
        const task: ResolveConflictsTask =
          op.strategy === "merge"
            ? { kind: "base-merge", baseBranch: op.baseBranch, sourceBranch: op.sourceBranch }
            : { kind: "base-rebase", baseBranch: op.baseBranch, sourceBranch: op.sourceBranch };
        const conflictFiles = started.kind === "conflict" ? started.files : [];

        const run = Effect.gen(function* () {
          yield* offer({
            kind: "status",
            message:
              op.strategy === "merge"
                ? `Merging ${op.baseBranch} into ${op.sourceBranch}…`
                : `Rebasing ${op.sourceBranch} onto ${op.baseBranch}…`,
          });
          if (started.kind === "conflict") {
            yield* offer({ kind: "conflict-files", files: conflictFiles });
            yield* offer({
              kind: "status",
              message: `Asking the agent to resolve ${describeFiles(conflictFiles)}…`,
            });
            const agentStream = yield* ai.resolveMergeConflict({
              cwd: op.scratchPath,
              task,
              conflictFiles,
              prId: pr.id,
              userId: params.userId,
            });
            yield* pumpAgentFrames(agentStream, offer);
          }

          const verified = yield* gitStep("Couldn't check the result", () =>
            verifyResolution({ ...op, conflictFiles }),
          );
          if (verified.kind === "failed") {
            return yield* offer({ kind: "result", status: "failed", message: verified.message });
          }

          yield* offer({ kind: "status", message: `Pushing to ${op.sourceBranch}…` });
          const pushed = yield* gitStep("git push failed", () =>
            pushResult(op.scratchPath, repo.remoteUrl, op.sourceBranch, remoteHead, verified.head),
          );
          switch (pushed.kind) {
            case "moved":
              return yield* offer({
                kind: "result",
                status: "remote-changed",
                branch: op.sourceBranch,
              });
            case "auth":
            case "rejected":
              logError("base-conflicts", `push failed (pr=${pr.id}): ${pushed.message}`);
              return yield* offer({ kind: "result", status: "failed", message: pushed.message });
            case "pushed":
              break;
          }

          yield* headRefresh
            .recordPushedHead({
              prId: pr.id,
              repoFullName: ctx.repo.fullName,
              prExternalId: pr.externalId,
              token: ctx.token,
              newTip: verified.head,
            })
            .pipe(Effect.catch(() => Effect.void));
          yield* headRefresh.broadcastPrsUpdated(pr.id).pipe(Effect.catch(() => Effect.void));
          yield* offer({
            kind: "result",
            status: "pushed",
            newSha: verified.head,
            branch: op.sourceBranch,
            strategy: op.strategy,
          });
        });

        yield* Effect.forkDetach(
          run.pipe(
            Effect.catch((err) =>
              offer({
                kind: "result",
                status: "failed",
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
            Effect.ensuring(cleanup.pipe(Effect.ensuring(Queue.shutdown(queue)))),
          ),
        );

        return queueToStream(queue);
      });

    return { check, resolve };
  }),
);
