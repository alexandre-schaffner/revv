import {
  isLiveStackMergeRun,
  LIVE_STACK_MERGE_RUN_STATUSES,
  type StackMergePlan,
  type StackMergeRun,
} from "@revv/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";
import {
  type DbError,
  type GitHubError,
  NotFoundError,
  StackRejectedError,
} from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { DbService } from "../Db";
import { GitHubAccounts } from "../github/accounts";
import { GitHubGateway } from "../github/gateway";
import type { GitHubStack } from "../github/stacks";
import { type PrContextBasic, PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { Realtime } from "../Realtime";
import { driveRun, type MergeDriverPort } from "./merge-driver";
import {
  defaultThrough,
  initialRunLayers,
  mergeModeOf,
  planLayers,
  type StackRead,
  type StartRequest,
  stackAskOrder,
  startRefusal,
} from "./merge-plan";
import { prIdsByNumber } from "./reads";
import { StackRebaseService } from "./StackRebase";
import { type StackError, StackService } from "./StackService";
import { liveRunFor, type RunRow, toRun, updateLiveRun } from "./stack-merge-runs";
import { logContradiction } from "./unverified-github";

const STALE_RUN_MS = 30 * 60_000;

export type StackMergeError = StackError | StackRejectedError | NotFoundError;

export class StackMergeService extends Context.Service<
  StackMergeService,
  {
    readonly plan: (prId: string) => Effect.Effect<StackMergePlan, StackMergeError>;
    /**
     * Persist a run and start stepping it. Refuses while another run for the
     * stack is live, and when GitHub moved since the user confirmed.
     */
    readonly start: (
      prId: string,
      request: StartRequest,
    ) => Effect.Effect<StackMergeRun, StackMergeError>;
    /** Stop a live run between steps. Anything already handed to auto-merge stays handed. */
    readonly cancel: (runId: string) => Effect.Effect<StackMergeRun, StackMergeError>;
    readonly continueRun: (runId: string) => Effect.Effect<StackMergeRun, StackMergeError>;
    /** On boot: every run a previous process left live becomes `expired`. */
    readonly expireStale: () => Effect.Effect<number, DbError>;
  }
>()("StackMergeService") {}

export const StackMergeServiceLive = Layer.effect(
  StackMergeService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const stacks = yield* StackService;
    const accounts = yield* GitHubAccounts;
    const github = yield* GitHubGateway;
    const prContext = yield* PrContextService;
    const mirror = yield* PrMirror;
    const realtime = yield* Realtime;
    const rebaser = yield* StackRebaseService;

    const driving = new Set<string>();
    const bootedAt = new Date().toISOString();

    const loadRun = (runId: string) =>
      Effect.flatMap(
        dbTry("stack merge run read", () =>
          db.select().from(stackMergeRuns).where(eq(stackMergeRuns.id, runId)).get(),
        ),
        (row) =>
          row
            ? Effect.succeed(row)
            : Effect.fail(new NotFoundError({ resource: "stack_merge_run", id: runId })),
      );

    const latestRun = (repositoryId: string, stackNumber: number) =>
      dbTry("stack merge run read", () => {
        const row = db
          .select()
          .from(stackMergeRuns)
          .where(
            and(
              eq(stackMergeRuns.repositoryId, repositoryId),
              eq(stackMergeRuns.stackNumber, stackNumber),
            ),
          )
          .orderBy(desc(stackMergeRuns.createdAt))
          .get();
        return row ? toRun(row) : null;
      });

    const prIdsFor = (repositoryId: string, numbers: readonly number[]) =>
      dbTry("stack merge PR lookup", () => prIdsByNumber(db, repositoryId, numbers));

    const announce = (accountId: string, run: StackMergeRun) =>
      realtime.toAccount(accountId, { type: "stack-merge:progress", data: run });

    /** Every merge Revv made goes through the mirror, as a single PR's merge does. */
    const markMerged = (repositoryId: string, numbers: readonly number[]) =>
      Effect.gen(function* () {
        const ids = yield* prIdsFor(repositoryId, numbers);
        const closedAt = new Date().toISOString();
        for (const id of ids.values()) {
          yield* mirror.recordMutation(id, { kind: "terminal", status: "merged", closedAt });
        }
      });

    const recordRetarget = (repositoryId: string, number: number, targetBranch: string) =>
      Effect.gen(function* () {
        const id = (yield* prIdsFor(repositoryId, [number])).get(number);
        if (id) yield* mirror.recordMutation(id, { kind: "base", targetBranch });
      });

    const readStack = (ctx: PrContextBasic, run: StackMergeRun) =>
      Effect.gen(function* () {
        let stack: GitHubStack | null = null;
        for (const layer of stackAskOrder(run.layers)) {
          const found = yield* stacks.fetchFresh(ctx, layer.number);
          if (found?.number === run.stackNumber) {
            stack = found;
            break;
          }
        }
        if (!stack) return null;
        const listed = new Set(stack.layers.map((l) => l.number));
        const mergedUnlisted = new Set<number>();
        for (const layer of run.layers) {
          if (listed.has(layer.number) || layer.state === "merged") continue;
          const state = yield* github.stacks.prState(ctx.client, ctx.repo.fullName, layer.number);
          if (state === "MERGED") mergedUnlisted.add(layer.number);
        }
        return { stack, mergedUnlisted } satisfies StackRead;
      });

    const portFor = (ctx: PrContextBasic): MergeDriverPort => {
      // A run outlives a token refresh: every step asks for the current one.
      const current = accounts.clientFor(ctx.accountId).pipe(
        Effect.catchTag("DbError", Effect.die),
        Effect.map((client): PrContextBasic => ({ ...ctx, client })),
      );
      const withCurrent = <A, E, R>(f: (c: PrContextBasic) => Effect.Effect<A, E, R>) =>
        Effect.flatMap(current, f);
      const stackError = (e: StackError): Effect.Effect<never, GitHubError> =>
        e._tag === "DbError" || e._tag === "NotFoundError" ? Effect.die(e) : Effect.fail(e);

      return {
        read: (run) => withCurrent((c) => readStack(c, run)).pipe(Effect.catch(stackError)),
        merge: (number, method, sha) =>
          withCurrent((c) => github.prs.merge(c.client, c.repo.fullName, number, method, { sha })),
        retarget: (number, base) =>
          withCurrent((c) => github.prs.updateBase(c.client, c.repo.fullName, number, base)).pipe(
            Effect.andThen(
              recordRetarget(ctx.repo.id, number, base).pipe(
                Effect.catch((err) =>
                  Effect.sync(() => logError("stack-merge", `recording #${number}'s base`, err)),
                ),
              ),
            ),
          ),
        enableAutoMerge: (nodeId, method, sha) =>
          withCurrent((c) => github.prs.enableAutoMerge(c.client, nodeId, method, sha)),
        rebase: (stack, proceed) =>
          withCurrent((c) => rebaser.rebaseStack(c, stack, proceed)).pipe(
            Effect.map((result) => result.rebased),
            Effect.mapError((e) =>
              e._tag === "StackRejectedError"
                ? e.message
                : e._tag === "GitHubAuthError"
                  ? "Couldn't rebase the stack: Revv's GitHub sign-in expired"
                  : `Couldn't rebase the stack: GitHub answered ${e._tag}`,
            ),
          ),
        save: (run, merged) =>
          Effect.gen(function* () {
            const kept = yield* dbTry("stack merge run write", () =>
              updateLiveRun(db, run.id, {
                status: run.status,
                layersBaseFirst: [...run.layers],
                error: run.error,
                updatedAt: run.updatedAt,
              }),
            );
            if (!kept) return "ended";
            yield* announce(ctx.accountId, run);
            if (merged.length > 0) {
              yield* markMerged(run.repositoryId, merged).pipe(
                Effect.catch((err) =>
                  Effect.sync(() => logError("stack-merge", "merged PR rows update failed", err)),
                ),
              );
            }
            return "live";
          }),
        isActive: (runId) =>
          dbTry("stack merge run read", () => {
            const row = db
              .select({ status: stackMergeRuns.status })
              .from(stackMergeRuns)
              .where(eq(stackMergeRuns.id, runId))
              .get();
            return row !== undefined && isLiveStackMergeRun(row.status);
          }),
        reportContradiction: (c) => Effect.sync(() => logContradiction("stack-merge", c)),
        now: () => Date.now(),
        sleep: (ms) => Effect.sleep(ms),
      };
    };

    const launch = (ctx: PrContextBasic, run: StackMergeRun) =>
      Effect.gen(function* () {
        if (driving.has(run.id)) return;
        driving.add(run.id);
        yield* Effect.forkDetach(
          driveRun(run, portFor(ctx)).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                logError("stack-merge", `run ${run.id} stopped unexpectedly:`, Cause.pretty(cause));
                const message = "Revv hit an error mid-merge — Continue to pick up where GitHub is";
                const failed = yield* dbTry("stack merge run write", () =>
                  updateLiveRun(db, run.id, {
                    status: "failed",
                    error: message,
                    updatedAt: new Date().toISOString(),
                  }),
                );
                if (failed) yield* announce(ctx.accountId, toRun(failed));
              }).pipe(Effect.catch(() => Effect.void)),
            ),
            Effect.ensuring(Effect.sync(() => driving.delete(run.id))),
            withGitHubOrigin("stack:merge"),
          ),
        );
      });

    const contextForRun = (row: RunRow) =>
      Effect.gen(function* () {
        const numbers = row.layersBaseFirst.map((l) => l.number);
        const ids = yield* prIdsFor(row.repositoryId, numbers);
        const prId = ids.values().next().value;
        if (prId === undefined) {
          return yield* Effect.fail(
            new StackRejectedError({
              message: "Revv no longer tracks any PR in this stack",
              rejection: { reason: "invalid" },
            }),
          );
        }
        return yield* prContext.forPr(prId);
      });

    const freshStack = (ctx: PrContextBasic) =>
      Effect.flatMap(stacks.fetchFresh(ctx, ctx.pr.externalId), (stack) =>
        stack
          ? Effect.succeed(stack)
          : Effect.fail(new NotFoundError({ resource: "stack", id: ctx.pr.id })),
      );

    const readPlan = (prId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.forPr(prId);
        const stack = yield* freshStack(ctx);
        const prIds = yield* prIdsFor(
          ctx.repo.id,
          stack.layers.map((l) => l.number),
        );
        return { ctx, stack, layers: planLayers(stack, prIds) };
      });

    const plan = (prId: string) =>
      Effect.gen(function* () {
        const { ctx, stack, layers } = yield* readPlan(prId);
        return {
          repositoryId: ctx.repo.id,
          stackNumber: stack.number,
          baseRefName: stack.baseRefName,
          layers,
          defaultThrough: defaultThrough(layers),
          allowedMethods: stack.allowedMethods,
          mode: mergeModeOf(stack),
          latestRun: yield* latestRun(ctx.repo.id, stack.number),
        } satisfies StackMergePlan;
      });

    const start = (prId: string, request: StartRequest) =>
      Effect.gen(function* () {
        const { ctx, stack, layers } = yield* readPlan(prId);
        const refusal = startRefusal(stack, layers, request);
        if (refusal) {
          return yield* Effect.fail(
            new StackRejectedError({
              message: refusal.message,
              rejection: { reason: refusal.reason },
            }),
          );
        }
        const now = new Date().toISOString();
        const run: StackMergeRun = {
          id: crypto.randomUUID(),
          repositoryId: ctx.repo.id,
          stackNumber: stack.number,
          throughPosition: request.throughPosition,
          method: request.method,
          mode: mergeModeOf(stack),
          status: "running",
          layers: initialRunLayers(layers, request.throughPosition),
          error: null,
          createdAt: now,
          updatedAt: now,
        };
        const inserted = yield* dbTry("stack merge run insert", () =>
          db.transaction((tx) => {
            if (liveRunFor(tx, run.repositoryId, run.stackNumber)) return false;
            tx.insert(stackMergeRuns)
              .values({
                id: run.id,
                repositoryId: run.repositoryId,
                stackNumber: run.stackNumber,
                throughPosition: run.throughPosition,
                method: run.method,
                mode: run.mode,
                status: run.status,
                layersBaseFirst: [...run.layers],
                error: null,
                accountId: ctx.accountId,
                createdAt: now,
                updatedAt: now,
              })
              .run();
            return true;
          }),
        );
        if (!inserted) {
          return yield* Effect.fail(
            new StackRejectedError({
              message: "This stack is already being merged",
              rejection: { reason: "busy" },
            }),
          );
        }
        yield* announce(ctx.accountId, run);
        yield* launch(ctx, run);
        return run;
      });

    const cancel = (runId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRun(runId);
        if (!isLiveStackMergeRun(row.status)) return toRun(row);
        const handedOver = row.layersBaseFirst.filter((l) => l.state === "auto_merge");
        const error =
          handedOver.length > 0
            ? `Cancelled. GitHub auto-merge is still on for ${handedOver.map((l) => `#${l.number}`).join(", ")}`
            : null;
        const updated = yield* dbTry("stack merge run write", () =>
          updateLiveRun(db, runId, {
            status: "cancelled",
            error,
            updatedAt: new Date().toISOString(),
          }),
        );
        const run = toRun(updated ?? (yield* loadRun(runId)));
        yield* announce(row.accountId, run);
        return run;
      });

    const continueRun = (runId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRun(runId);
        if (row.status !== "failed" && row.status !== "expired") {
          return yield* Effect.fail(
            new StackRejectedError({
              message: "Only a stopped merge can be continued",
              rejection: { reason: "busy" },
            }),
          );
        }
        const ctx = yield* contextForRun(row);
        const layers = row.layersBaseFirst.map((l) =>
          l.state === "merged" ? l : { ...l, state: "pending" as const, message: null },
        );
        const now = new Date().toISOString();
        const updated = yield* dbTry("stack merge run write", () =>
          db
            .update(stackMergeRuns)
            .set({ status: "running", error: null, layersBaseFirst: layers, updatedAt: now })
            .where(
              and(
                eq(stackMergeRuns.id, runId),
                inArray(stackMergeRuns.status, ["failed", "expired"]),
              ),
            )
            .returning()
            .get(),
        );
        if (!updated) {
          return yield* Effect.fail(
            new StackRejectedError({
              message: "This merge is already running",
              rejection: { reason: "busy" },
            }),
          );
        }
        const run = toRun(updated);
        yield* announce(ctx.accountId, run);
        yield* launch(ctx, run);
        return run;
      });

    const expireStale = () =>
      dbTry("stack merge run expiry", () => {
        const now = Date.now();
        const cutoff = new Date(now - STALE_RUN_MS).toISOString();
        return db
          .update(stackMergeRuns)
          .set({
            status: "expired",
            error: sql`case when ${stackMergeRuns.updatedAt} < ${cutoff}
              then 'This merge stopped a while ago — Continue to pick up where GitHub is'
              else 'Revv restarted mid-merge — Continue to pick up where GitHub is' end`,
            updatedAt: new Date(now).toISOString(),
          })
          .where(
            and(
              inArray(stackMergeRuns.status, [...LIVE_STACK_MERGE_RUN_STATUSES]),
              lt(stackMergeRuns.updatedAt, bootedAt),
            ),
          )
          .returning({ id: stackMergeRuns.id })
          .all().length;
      });

    return { plan, start, cancel, continueRun, expireStale };
  }),
);
