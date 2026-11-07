// "Rebase stack": put every open layer back on top of the one below it, the
// bottom on the stack base's tip, the way GitHub's own button does. GitHub
// exposes no API for its server-side rebase, so Revv runs the same cascade in
// the repo's clone (`stack-rebase-git.ts`) and pushes the result.

import { isOpenLayer, type StackRebaseResult } from "@revv/shared";
import { Context, Effect, Layer } from "effect";
import {
  type GitHubError,
  NotFoundError,
  StackRejectedError,
  type StackRejection,
} from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { RepoCloneService } from "../clone/RepoClone";
import { DbService } from "../Db";
import { BranchPushLock } from "../git/branch-push-lock";
import { gitTry } from "../git/ops";
import { describeFiles } from "../git/scratch";
import { GitHubGateway } from "../github/gateway";
import { type PrContextBasic, PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import type { GitHubStack } from "./map";
import { planStackRebase } from "./rebase-plan";
import { type StackError, StackService } from "./StackService";
import { liveRunFor } from "./stack-merge-runs";
import { cleanupReplay, pushStack, type ReplayInput, replayStack } from "./stack-rebase-git";
import { logContradiction, membershipAfterRetarget } from "./unverified-github";

export type StackRebaseError = StackError | StackRejectedError | NotFoundError;

export class StackRebaseService extends Context.Service<
  StackRebaseService,
  {
    /**
     * Rebase the PR's stack, as long as no layer moved since the user saw it
     * (`expectedHeads`, by PR number) and no merge of the stack is running.
     */
    readonly rebase: (
      prId: string,
      accountId: string,
      expectedHeads: Readonly<Record<string, string>>,
    ) => Effect.Effect<StackRebaseResult, StackRebaseError>;
    /**
     * Rebase `stack` as just read. For a running stack merge, which has
     * already checked the heads it holds; `proceed`, asked once the rebase is
     * replayed, can still call the push off.
     */
    readonly rebaseStack: (
      ctx: PrContextBasic,
      stack: GitHubStack,
      accountId: string,
      proceed?: Effect.Effect<boolean>,
    ) => Effect.Effect<StackRebaseResult, StackRejectedError | GitHubError>;
  }
>()("StackRebaseService") {}

const rejected = (rejection: StackRejection, message: string) =>
  Effect.fail(new StackRejectedError({ message, rejection }));

export const StackRebaseServiceLive = Layer.effect(
  StackRebaseService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const stacks = yield* StackService;
    const github = yield* GitHubGateway;
    const prContext = yield* PrContextService;
    const pushLock = yield* BranchPushLock;
    const repoClone = yield* RepoCloneService;
    const mirror = yield* PrMirror;

    const replayInput = (ctx: PrContextBasic, stack: GitHubStack, steps: ReplayInput["steps"]) => {
      const place = repoClone.scratchPlace(ctx.repo, ctx.client.token, (layout) =>
        layout.scratch.stackRebase(ctx.repo.id, stack.number),
      );
      return place
        ? Effect.succeed({
            ...place,
            baseRefName: stack.baseRefName,
            stackNumber: stack.number,
            steps,
          } satisfies ReplayInput)
        : rejected({ reason: "invalid" }, `Revv's copy of ${ctx.repo.fullName} isn't ready yet`);
    };

    const gitStep = <A>(what: string, run: () => Promise<A>) =>
      gitTry(run, what).pipe(
        Effect.mapError(
          (err) =>
            new StackRejectedError({ message: err.message, rejection: { reason: "failed" } }),
        ),
      );

    const replayAndPush = (input: ReplayInput, proceed: Effect.Effect<boolean>) =>
      Effect.gen(function* () {
        const replay = yield* gitStep("Rebasing the stack failed", () => replayStack(input));
        if (replay.kind === "conflict") {
          return yield* rejected(
            { reason: "replay-conflict", files: replay.files },
            `#${replay.number} conflicts with ${replay.ontoLabel} in ${describeFiles(replay.files)} — ` +
              "resolve it locally (gh stack rebase)",
          );
        }
        if (replay.kind === "failed") return yield* rejected({ reason: "failed" }, replay.message);
        if (!(yield* proceed)) {
          return yield* rejected(
            { reason: "invalid" },
            "The merge was cancelled before Revv pushed the rebase",
          );
        }

        const moved = input.steps.flatMap((step) => {
          const to = replay.heads.get(step.number);
          return to && to !== step.tip
            ? [{ number: step.number, headRef: step.headRef, from: step.tip, to }]
            : [];
        });
        const push = yield* gitStep("Pushing the stack failed", () =>
          pushStack(input.clonePath, input.remoteUrl, moved),
        );
        if (push.kind === "moved") {
          return yield* rejected(
            { reason: "lease-lost" },
            "A layer got new commits while Revv was rebasing — nothing was pushed, try again",
          );
        }
        if (push.kind !== "pushed") return yield* rejected({ reason: "failed" }, push.message);
        return moved.map(({ number, from, to }) => ({ number, from, to }));
      }).pipe(
        Effect.ensuring(
          Effect.promise(() =>
            cleanupReplay(input).catch((err) =>
              logError("stack-rebase", `cleanup of ${input.scratchPath} failed`, err),
            ),
          ),
        ),
      );

    const checkMembership = (ctx: PrContextBasic, stack: GitHubStack, number: number) =>
      Effect.gen(function* () {
        const reread = yield* stacks.fetchFresh(ctx, number);
        const contradicted = membershipAfterRetarget(stack, number, reread);
        if (contradicted) logContradiction("stack-rebase", contradicted);
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() =>
            logError("stack-rebase", `re-reading #${number}'s stack after retargeting failed`, err),
          ),
        ),
      );

    const rebaseStack = (
      ctx: PrContextBasic,
      stack: GitHubStack,
      accountId: string,
      proceed: Effect.Effect<boolean> = Effect.succeed(true),
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const planned = planStackRebase(stack);
          if (!planned.ok) return yield* rejected({ reason: "invalid" }, planned.message);
          const { plan } = planned;

          yield* pushLock
            .hold(
              plan.steps.map((step) => ({ repoId: ctx.repo.id, branch: step.headRef })),
              "stack-rebase",
            )
            .pipe(
              Effect.catchTag("ConcurrentPushError", (busy) =>
                rejected(
                  { reason: "busy" },
                  busy.heldBy === "stack-rebase"
                    ? "This stack is already being rebased"
                    : `Another push to ${busy.branch} is already running`,
                ),
              ),
            );
          const input = yield* replayInput(ctx, stack, plan.steps);
          const rebased = yield* replayAndPush(input, proceed);

          const retargeted: number[] = [];
          if (plan.retarget !== null) {
            const done = yield* Effect.result(
              github.prs.updateBase(
                ctx.client,
                ctx.repo.fullName,
                plan.retarget,
                stack.baseRefName,
              ),
            );
            if (done._tag === "Success") {
              retargeted.push(plan.retarget);
              yield* checkMembership(ctx, stack, plan.retarget);
            } else {
              logError("stack-rebase", `retargeting #${plan.retarget} failed`, done.failure);
            }
          }

          yield* mirror.recordPushes(
            ctx,
            rebased.map(({ number, to }) => ({ prNumber: number, newTip: to })),
          );
          if (rebased.length > 0 || retargeted.length > 0) {
            yield* stacks.moved(accountId, ctx.repo.id, stack.number);
          }
          return { rebased, retargeted } satisfies StackRebaseResult;
        }),
      );

    const mergeRunning = (repositoryId: string, stackNumber: number) =>
      dbTry("stack merge run read", () => liveRunFor(db, repositoryId, stackNumber) !== undefined);

    const rebase = (
      prId: string,
      accountId: string,
      expectedHeads: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId, accountId);
        const stack = yield* stacks.fetchFresh(ctx, ctx.pr.externalId);
        if (!stack) return yield* Effect.fail(new NotFoundError({ resource: "stack", id: prId }));
        if (!stack.viewerCanPush) {
          return yield* rejected({ reason: "invalid" }, `You can't push to ${ctx.repo.fullName}`);
        }
        for (const layer of stack.layers.filter(isOpenLayer)) {
          if (expectedHeads[String(layer.number)] !== layer.headSha) {
            return yield* rejected(
              { reason: "stale" },
              `#${layer.number} got new commits since you looked — review them first`,
            );
          }
        }
        if (yield* mergeRunning(ctx.repo.id, stack.number)) {
          return yield* rejected({ reason: "invalid" }, "A merge of this stack is running");
        }
        return yield* rebaseStack(ctx, stack, accountId);
      });

    return { rebase, rebaseStack };
  }),
);
