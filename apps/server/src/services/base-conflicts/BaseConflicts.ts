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

import type { BaseConflictFrame, BaseConflictsCheck } from "@revv/shared";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { ResolveConflictsTask } from "../../ai/prompts/chat";
import {
  AiNotConfiguredError,
  BaseConflictsRejectedError,
  type BaseConflictsRejection,
  type DbError,
} from "../../domain/errors";
import { keyedSingleFlight } from "../../effects/keyed-single-flight";
import { logError } from "../../logger";
import { AiService } from "../Ai";
import { RepoCloneService } from "../clone/RepoClone";
import { createResolveRuns, type PushedOf } from "../conflict-resolve-run";
import { BranchPushLock, type PushTarget } from "../git/branch-push-lock";
import { assertNotFlagLike, gitTry, isAncestor } from "../git/ops";
import { lsRemoteHead } from "../git/push";
import { clearScratch, describeFiles, prepareScratch } from "../git/scratch";
import { type PrContextBasic, type PrContextError, PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { SettingsService } from "../Settings";
import { PrWorkspace } from "../workspace/PrWorkspace";
import {
  checkTips,
  deleteTipRefs,
  fetchTips,
  type OperationInput,
  pushResult,
  type SyncRepo,
  startOperation,
  verifyResolution,
} from "./git";

const CHECK_FRESH_MS = 30_000;

export type BaseConflictsError =
  | BaseConflictsRejectedError
  | AiNotConfiguredError
  | PrContextError
  | DbError;

export class BaseConflictsService extends Context.Service<
  BaseConflictsService,
  {
    readonly check: (params: {
      readonly prId: string;
      readonly force?: boolean;
    }) => Effect.Effect<BaseConflictsCheck, BaseConflictsError>;
    /**
     * Start bringing the PR up to date with its base, as long as its branch is
     * still at `expectedHeadSha`. Refusals fail before anything runs; once the
     * stream is returned, the run ends in exactly one `result` frame.
     */
    readonly resolve: (params: {
      readonly prId: string;
      readonly expectedHeadSha: string;
    }) => Effect.Effect<ReadableStream<BaseConflictFrame>, BaseConflictsError>;
    /** Stop the PR's run while its agent works; whether there was one to stop. */
    readonly stop: (prId: string) => Effect.Effect<boolean>;
  }
>()("BaseConflictsService") {}

const rejected = (reason: BaseConflictsRejection, message: string) =>
  Effect.fail(new BaseConflictsRejectedError({ reason, message }));

const gitStep = <A>(what: string, run: () => Promise<A>) =>
  gitTry(run, what).pipe(
    Effect.mapError(
      (err) => new BaseConflictsRejectedError({ reason: "failed", message: err.message }),
    ),
  );

export const BaseConflictsServiceLive = Layer.effect(
  BaseConflictsService,
  Effect.gen(function* () {
    const prCtx = yield* PrContextService;
    const settings = yield* SettingsService;
    const ai = yield* AiService;
    const pushLock = yield* BranchPushLock;
    const workspace = yield* PrWorkspace;
    const mirror = yield* PrMirror;
    const repoClone = yield* RepoCloneService;

    const checks = new Map<
      string,
      { readonly prHeadSha: string | null; readonly at: number; readonly check: BaseConflictsCheck }
    >();
    const checkOnce = keyedSingleFlight<string, BaseConflictsCheck, DbError>();
    const resolveRuns = createResolveRuns<PushedOf<BaseConflictFrame>>();

    const placeOf = (ctx: PrContextBasic) =>
      repoClone.scratchPlace(ctx.repo, ctx.client.token, (layout) =>
        layout.scratch.baseSync(ctx.repo.id, ctx.pr.externalId),
      );

    const syncRepoOf = (ctx: PrContextBasic, refs: SyncRepo["refs"]): SyncRepo | null => {
      const place = placeOf(ctx);
      return place
        ? {
            clonePath: place.clonePath,
            remoteUrl: place.remoteUrl,
            prNumber: ctx.pr.externalId,
            baseBranch: ctx.pr.targetBranch,
            refs,
          }
        : null;
    };

    const pushTarget = (ctx: PrContextBasic): PushTarget => ({
      repoId: ctx.repo.id,
      branch: ctx.pr.sourceBranch,
    });
    const isResolving = (ctx: PrContextBasic) => pushLock.holder(pushTarget(ctx)) === "base-sync";

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
      resolving: isResolving(ctx),
      reason,
      checkedAt: new Date().toISOString(),
    });

    const computeCheck = (ctx: PrContextBasic): Effect.Effect<BaseConflictsCheck, DbError> =>
      Effect.gen(function* () {
        const unpushed = yield* workspace.unpushedCount(ctx).pipe(
          Effect.catchTag("GitOperationError", (err) =>
            Effect.sync(() => {
              logError("base-conflicts", `counting agent commits (pr=${ctx.pr.id}):`, err.message);
              return 0;
            }),
          ),
        );
        const repo = syncRepoOf(ctx, "base-conflicts");
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
          resolving: isResolving(ctx),
          checkedAt: new Date().toISOString(),
        } satisfies BaseConflictsCheck;
      });

    const check: Context.Service.Shape<typeof BaseConflictsService>["check"] = (params) =>
      Effect.gen(function* () {
        const ctx = yield* prCtx.forPr(params.prId);
        const cached = checks.get(ctx.pr.id);
        const resolving = isResolving(ctx);
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

    const prepare = (
      ctx: PrContextBasic,
      expectedHeadSha: string,
      scratch: { path: string | null; repo: SyncRepo | null },
    ) =>
      Effect.gen(function* () {
        const { pr } = ctx;
        if (pr.status !== "open") {
          return yield* rejected("invalid", `#${pr.externalId} is ${pr.status}`);
        }
        const repo = syncRepoOf(ctx, "base-sync");
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
        const { baseConflictStrategy: strategy } = yield* settings.getSettings();

        const remoteHead = yield* gitStep("Couldn't read the PR's branch", () =>
          lsRemoteHead(repo.clonePath, repo.remoteUrl, pr.sourceBranch),
        );
        if (!remoteHead) {
          return yield* rejected(
            "invalid",
            `${pr.sourceBranch} isn't a branch of ${ctx.repo.fullName}; Revv can't push to a fork`,
          );
        }
        if (remoteHead !== expectedHeadSha) {
          return yield* rejected("stale", "This PR got new commits since you looked — try again");
        }
        if (strategy === "rebase") {
          const unpushed = yield* workspace
            .unpushedCount(ctx)
            .pipe(Effect.catchTag("GitOperationError", (err) => rejected("failed", err.message)));
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

        const scratchPath = placeOf(ctx)?.scratchPath;
        if (!scratchPath) {
          return yield* rejected(
            "unavailable",
            `Revv's copy of ${ctx.repo.fullName} isn't ready yet`,
          );
        }
        scratch.path = scratchPath;
        const prepared = yield* gitStep("Couldn't prepare a worktree", () =>
          prepareScratch(repo.clonePath, scratchPath, tips.headTip),
        );
        if (prepared.kind === "failed") return yield* rejected("failed", prepared.message);

        const op: OperationInput = {
          strategy,
          scratchPath,
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
        // The run outlives this request: the stream it returns closes the scope.
        const scope = yield* Scope.make();
        const scratch: { path: string | null; repo: SyncRepo | null } = { path: null, repo: null };
        const cleanup = Effect.promise(async () => {
          if (scratch.repo && scratch.path)
            await clearScratch(scratch.repo.clonePath, scratch.path);
          if (scratch.repo) await deleteTipRefs(scratch.repo);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => checks.delete(params.prId)).pipe(
              Effect.andThen(Scope.close(scope, Exit.void)),
            ),
          ),
        );

        const { ctx, repo, op, remoteHead, started } = yield* Effect.gen(function* () {
          const ctx = yield* prCtx.forPr(params.prId);
          yield* pushLock.hold([pushTarget(ctx)], "base-sync").pipe(
            Scope.provide(scope),
            Effect.catchTag("ConcurrentPushError", () =>
              rejected("busy", "Another push to this PR is already running"),
            ),
          );
          return yield* prepare(ctx, params.expectedHeadSha, scratch);
        }).pipe(Effect.onError(() => cleanup));
        const { pr } = ctx;
        const task: ResolveConflictsTask =
          op.strategy === "merge"
            ? { kind: "base-merge", baseBranch: op.baseBranch, sourceBranch: op.sourceBranch }
            : { kind: "base-rebase", baseBranch: op.baseBranch, sourceBranch: op.sourceBranch };
        const conflictFiles = started.kind === "conflict" ? started.files : [];
        const result = (frame: Extract<BaseConflictFrame, { kind: "result" }>) => frame;
        const abort = new AbortController();

        return yield* resolveRuns.start(params.prId, {
          opening: [
            {
              kind: "status",
              message:
                op.strategy === "merge"
                  ? `Merging ${op.baseBranch} into ${op.sourceBranch}…`
                  : `Rebasing ${op.sourceBranch} onto ${op.baseBranch}…`,
            },
            ...(started.kind === "conflict"
              ? [
                  { kind: "conflict-files" as const, files: conflictFiles },
                  {
                    kind: "status" as const,
                    message: `Asking the agent to resolve ${describeFiles(conflictFiles)}…`,
                  },
                ]
              : []),
          ],
          abort,
          agent:
            started.kind === "conflict"
              ? ai.resolveMergeConflict({
                  cwd: op.scratchPath,
                  task,
                  conflictFiles,
                  abortController: abort,
                })
              : null,
          finish: (offer) =>
            Effect.gen(function* () {
              const verified = yield* gitStep("Couldn't check the result", () =>
                verifyResolution({ ...op, conflictFiles }),
              );
              if (verified.kind === "failed") {
                return result({ kind: "result", status: "failed", message: verified.message });
              }

              yield* offer({ kind: "status", message: `Pushing to ${op.sourceBranch}…` });
              const pushed = yield* gitStep("git push failed", () =>
                pushResult(
                  op.scratchPath,
                  repo.remoteUrl,
                  op.sourceBranch,
                  remoteHead,
                  verified.head,
                ),
              );
              switch (pushed.kind) {
                case "moved":
                  return result({
                    kind: "result",
                    status: "remote-changed",
                    branch: op.sourceBranch,
                  });
                case "auth":
                case "rejected":
                  logError("base-conflicts", `push failed (pr=${pr.id}): ${pushed.message}`);
                  return result({ kind: "result", status: "failed", message: pushed.message });
                case "pushed":
                  break;
              }

              yield* mirror.recordPushes(ctx, [{ prNumber: pr.externalId, newTip: verified.head }]);
              return result({
                kind: "result",
                status: "pushed",
                newSha: verified.head,
                branch: op.sourceBranch,
                strategy: op.strategy,
              });
            }),
          cleanup,
        });
      });

    return { check, resolve, stop: resolveRuns.stop };
  }),
);
