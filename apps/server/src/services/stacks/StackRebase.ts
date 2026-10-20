// ── Stack rebase service ────────────────────────────────────────────────────
//
// "Rebase stack": put every open layer back on top of the one below it, the
// bottom on the stack base's tip, the way GitHub's own button does. GitHub
// exposes no API for its server-side rebase, so Revv runs the same cascade in
// the repo's clone (`stack-rebase-git.ts`) and pushes the result.
//
// Nothing is journaled, by design: the remote only ever sees one atomic,
// leased push, so a crash anywhere leaves either the old stack or the new one,
// and the scratch worktree is cleared by the next rebase of the stack. A
// running stack merge rebases through `rebaseStack` when a layer comes back
// behind its base.

import { join } from "node:path";
import type { StackMergeRunStatus, StackRebaseResult } from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { serverEnv } from "../../config";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";
import {
  DbError,
  type GitHubError,
  NotFoundError,
  StackRebaseRejectedError,
} from "../../domain/errors";
import { logError } from "../../logger";
import { Broadcaster } from "../Broadcaster";
import type { CacheService } from "../Cache";
import { worktreeHolderPath } from "../clone-policy";
import { DbService } from "../Db";
import { GitHubGateway } from "../GitHub";
import { type PrContextBasic, PrContextService } from "../PrContext";
import type { SettingsService } from "../Settings";
import type { GitHubStack } from "./map";
import { planStackRebase } from "./rebase-plan";
import { type StackError, StackService } from "./StackService";
import { cleanupReplay, pushStack, type ReplayInput, replayStack } from "./stack-rebase-git";

const LIVE_MERGE_STATUSES: readonly StackMergeRunStatus[] = ["running", "waiting"];

export type StackRebaseError = StackError | StackRebaseRejectedError | NotFoundError;

export class StackRebaseService extends Context.Tag("StackRebaseService")<
  StackRebaseService,
  {
    /**
     * Rebase the PR's stack, as long as no layer moved since the user saw it
     * (`expectedHeads`, by PR number) and no merge of the stack is running.
     */
    readonly rebase: (
      prId: string,
      userId: string,
      accountId: string,
      expectedHeads: Readonly<Record<string, string>>,
    ) => Effect.Effect<StackRebaseResult, StackRebaseError>;
    /**
     * Rebase `stack` as just read. For a running stack merge, which has
     * already checked the heads it holds.
     */
    readonly rebaseStack: (
      ctx: PrContextBasic,
      stack: GitHubStack,
      accountId: string,
    ) => Effect.Effect<StackRebaseResult, StackRebaseRejectedError | GitHubError>;
  }
>() {}

const rejected = (
  reason: StackRebaseRejectedError["reason"],
  message: string,
  files?: readonly string[],
) =>
  Effect.fail(
    new StackRebaseRejectedError(
      files === undefined ? { message, reason } : { message, reason, files },
    ),
  );

/** Conflicting paths as a reader takes them in: the first few, then a count. */
function describeFiles(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}

export const StackRebaseServiceLive = Layer.effect(
  StackRebaseService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService | CacheService | SettingsService>();
    const { db } = Context.get(context, DbService);
    const stacks = yield* StackService;
    const github = yield* GitHubGateway;
    const prContext = yield* PrContextService;
    const broadcaster = yield* Broadcaster;

    /** Stacks this process is rebasing: two rebases of one stack would race their pushes. */
    const rebasing = new Set<string>();

    const replayInput = (ctx: PrContextBasic, stack: GitHubStack, steps: ReplayInput["steps"]) =>
      Effect.gen(function* () {
        const { repo } = ctx;
        const [owner, name] = repo.fullName.split("/");
        if (repo.cloneStatus !== "ready" || !repo.clonePath || !owner || !name) {
          return yield* rejected("invalid", `Revv's copy of ${repo.fullName} isn't ready yet`);
        }
        const host = repo.githubHost || serverEnv.githubHost;
        return {
          clonePath: repo.clonePath,
          scratchPath: join(worktreeHolderPath(owner, name), `stack-${stack.number}-rebase`),
          remoteUrl: `https://x-access-token:${ctx.token}@${host}/${repo.fullName}.git`,
          baseRefName: stack.baseRefName,
          stackNumber: stack.number,
          steps,
        } satisfies ReplayInput;
      });

    const gitStep = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new StackRebaseRejectedError({
            message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
            reason: "failed",
          }),
      });

    /** Replay and push, inside the scratch worktree's lifetime. */
    const replayAndPush = (input: ReplayInput) =>
      Effect.gen(function* () {
        const replay = yield* gitStep("Rebasing the stack failed", () => replayStack(input));
        if (replay.kind === "conflict") {
          return yield* rejected(
            "conflict",
            `#${replay.number} conflicts with ${replay.ontoLabel} in ${describeFiles(replay.files)} — ` +
              "resolve it locally (gh stack rebase)",
            replay.files,
          );
        }
        if (replay.kind === "failed") return yield* rejected("failed", replay.message);

        const moved = input.steps.flatMap((step) => {
          const to = replay.heads.get(step.number);
          return to && to !== step.tip
            ? [{ number: step.number, headRef: step.headRef, from: step.tip, to }]
            : [];
        });
        const push = yield* gitStep("Pushing the stack failed", () =>
          pushStack(input.clonePath, input.remoteUrl, moved),
        );
        if (push.kind !== "pushed") {
          return yield* rejected(push.kind === "moved" ? "moved" : "failed", push.message);
        }
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

    const rebaseStack = (ctx: PrContextBasic, stack: GitHubStack, accountId: string) =>
      Effect.gen(function* () {
        const key = `${ctx.repo.id}:${stack.number}`;
        if (rebasing.has(key))
          return yield* rejected("moved", "This stack is already being rebased");
        rebasing.add(key);
        return yield* Effect.gen(function* () {
          const planned = planStackRebase(stack);
          if (!planned.ok) return yield* rejected("invalid", planned.message);
          const { plan } = planned;

          const input = yield* replayInput(ctx, stack, plan.steps);
          const rebased = yield* replayAndPush(input);

          // The layer below merged: GitHub keeps the next one on the merged
          // branch until something points it at the base.
          const retargeted: number[] = [];
          if (plan.retarget !== null) {
            const done = yield* Effect.either(
              Effect.provide(
                github.prs.updateBase(
                  ctx.repo.fullName,
                  plan.retarget,
                  stack.baseRefName,
                  ctx.token,
                  ctx.apiBase,
                ),
                context,
              ),
            );
            if (done._tag === "Right") retargeted.push(plan.retarget);
            else logError("stack-rebase", `retargeting #${plan.retarget} failed`, done.left);
          }

          // Pushed: everything after is best-effort.
          if (rebased.length > 0 || retargeted.length > 0) {
            yield* Effect.provide(stacks.invalidate(ctx.repo.id, stack.number), context).pipe(
              Effect.catchAll(() => Effect.void),
            );
            yield* broadcaster.broadcastToAccount(accountId, {
              type: "stack:updated",
              data: { repositoryId: ctx.repo.id, stackNumber: stack.number },
            });
          }
          return { rebased, retargeted } satisfies StackRebaseResult;
        }).pipe(Effect.ensuring(Effect.sync(() => rebasing.delete(key))));
      });

    const mergeRunning = (repositoryId: string, stackNumber: number) =>
      Effect.try({
        try: () =>
          db
            .select({ id: stackMergeRuns.id })
            .from(stackMergeRuns)
            .where(
              and(
                eq(stackMergeRuns.repositoryId, repositoryId),
                eq(stackMergeRuns.stackNumber, stackNumber),
                inArray(stackMergeRuns.status, [...LIVE_MERGE_STATUSES]),
              ),
            )
            .get() !== undefined,
        catch: (cause) => new DbError({ message: "stack merge run read failed", cause }),
      });

    const rebase = (
      prId: string,
      userId: string,
      accountId: string,
      expectedHeads: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const stack = yield* stacks.fetchFresh(ctx);
        if (!stack) return yield* Effect.fail(new NotFoundError({ resource: "stack", id: prId }));
        if (!stack.viewerCanPush) {
          return yield* rejected("invalid", `You can't push to ${ctx.repo.fullName}`);
        }
        for (const layer of stack.layers) {
          if (layer.status === "merged" || layer.status === "closed") continue;
          if (expectedHeads[String(layer.number)] !== layer.headSha) {
            return yield* rejected(
              "moved",
              `#${layer.number} got new commits since you looked — review them first`,
            );
          }
        }
        if (yield* mergeRunning(ctx.repo.id, stack.number)) {
          return yield* rejected("invalid", "A merge of this stack is running");
        }
        return yield* rebaseStack(ctx, stack, accountId);
      }).pipe(Effect.provide(context));

    return { rebase, rebaseStack };
  }),
);
