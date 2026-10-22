import type { StackMergePlan, StackMergeRun } from "@revv/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";
import { DbError, type GitHubError, NotFoundError, StackRejectedError } from "../../domain/errors";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { Broadcaster } from "../Broadcaster";
import { DbService } from "../Db";
import { GitHubGateway } from "../GitHub";
import { githubGraphql } from "../github-rest";
import { type PrContextBasic, PrContextService } from "../PrContext";
import { PullRequestService } from "../PullRequest";
import type { SettingsService } from "../Settings";
import { TokenProvider } from "../TokenProvider";
import type { GitHubStack } from "./map";
import { driveRun, type MergeDriverPort, type SaveEffects } from "./merge-driver";
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
import { PR_STATE_QUERY, type RawPrState } from "./queries";
import { StackRebaseService } from "./StackRebase";
import { type StackError, StackService } from "./StackService";
import {
  isLiveStatus,
  LIVE_RUN_STATUSES,
  liveRunFor,
  type RunRow,
  toRun,
  updateLiveRun,
} from "./stack-merge-runs";
import { logContradiction } from "./unverified-github";

const STALE_RUN_MS = 30 * 60_000;

export type StackMergeError = StackError | StackRejectedError | NotFoundError;

export class StackMergeService extends Context.Tag("StackMergeService")<
  StackMergeService,
  {
    readonly plan: (
      prId: string,
      userId: string,
      accountId: string,
    ) => Effect.Effect<StackMergePlan, StackMergeError>;
    /**
     * Persist a run and start stepping it. Refuses while another run for the
     * stack is live, and when GitHub moved since the user confirmed.
     */
    readonly start: (
      prId: string,
      userId: string,
      accountId: string,
      request: StartRequest,
    ) => Effect.Effect<StackMergeRun, StackMergeError>;
    /** Stop a live run between steps. Anything already handed to auto-merge stays handed. */
    readonly cancel: (
      runId: string,
      accountId: string,
    ) => Effect.Effect<StackMergeRun, StackMergeError>;
    readonly continueRun: (
      runId: string,
      accountId: string,
    ) => Effect.Effect<StackMergeRun, StackMergeError>;
    /** On boot: every run a previous process left live becomes `expired`. */
    readonly expireStale: () => Effect.Effect<number, DbError>;
  }
>() {}

const asPr = (ctx: PrContextBasic, number: number): PrContextBasic => ({
  ...ctx,
  pr: { ...ctx.pr, externalId: number },
});

export const StackMergeServiceLive = Layer.effect(
  StackMergeService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService | SettingsService>();
    const { db } = Context.get(context, DbService);
    const stacks = yield* StackService;
    const tokens = yield* TokenProvider;
    const github = yield* GitHubGateway;
    const prContext = yield* PrContextService;
    const prService = yield* PullRequestService;
    const broadcaster = yield* Broadcaster;
    const rebaser = yield* StackRebaseService;

    const driving = new Set<string>();
    const bootedAt = new Date().toISOString();

    const dbTry = <A>(message: string, f: () => A) =>
      Effect.try({ try: f, catch: (cause) => new DbError({ message, cause }) });

    const loadRun = (runId: string, accountId: string) =>
      Effect.flatMap(
        dbTry("stack merge run read failed", () =>
          db
            .select()
            .from(stackMergeRuns)
            .where(and(eq(stackMergeRuns.id, runId), eq(stackMergeRuns.accountId, accountId)))
            .get(),
        ),
        (row) =>
          row
            ? Effect.succeed(row)
            : Effect.fail(new NotFoundError({ resource: "stack_merge_run", id: runId })),
      );

    const latestRun = (repositoryId: string, stackNumber: number) =>
      dbTry("stack merge run read failed", () => {
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
      dbTry("stack merge PR lookup failed", () => {
        if (numbers.length === 0) return new Map<number, string>();
        const rows = db
          .select({ id: pullRequests.id, number: pullRequests.externalId })
          .from(pullRequests)
          .where(
            and(
              eq(pullRequests.repositoryId, repositoryId),
              inArray(pullRequests.externalId, [...numbers]),
            ),
          )
          .all();
        return new Map(rows.map((r) => [r.number, r.id]));
      });

    const announce = (accountId: string, run: StackMergeRun) =>
      broadcaster.broadcastToAccount(accountId, { type: "stack-merge:progress", data: run });

    const markMerged = (accountId: string, repositoryId: string, numbers: readonly number[]) =>
      Effect.gen(function* () {
        const ids = yield* prIdsFor(repositoryId, numbers);
        const closedAt = new Date().toISOString();
        const updates: Array<{ id: string; status: "merged"; closedAt: string }> = [];
        for (const id of ids.values()) {
          const pr = yield* Effect.option(prService.getPr(id, accountId));
          if (pr._tag === "None" || pr.value.status === "merged") continue;
          updates.push({ id, status: "merged", closedAt });
        }
        if (updates.length === 0) return;
        yield* prService.markPrsClosed(updates);
        const all = yield* prService.listPrs(accountId);
        yield* broadcaster.broadcastToAccount(accountId, { type: "prs:updated", data: all });
      });

    const readStack = (ctx: PrContextBasic, run: StackMergeRun) =>
      Effect.gen(function* () {
        let stack: GitHubStack | null = null;
        for (const layer of stackAskOrder(run.layers)) {
          const found = yield* stacks.fetchFresh(asPr(ctx, layer.number));
          if (found?.number === run.stackNumber) {
            stack = found;
            break;
          }
        }
        if (!stack) return null;
        const listed = new Set(stack.layers.map((l) => l.number));
        const mergedUnlisted = new Set<number>();
        const [owner, repo] = ctx.repo.fullName.split("/");
        for (const layer of run.layers) {
          if (listed.has(layer.number) || layer.state === "merged" || !owner || !repo) continue;
          const answer = yield* githubGraphql<RawPrState>(
            PR_STATE_QUERY,
            { owner, repo, number: layer.number },
            ctx.token,
            ctx.apiBase,
          );
          if (answer.repository?.pullRequest?.state === "MERGED") mergedUnlisted.add(layer.number);
        }
        return { stack, mergedUnlisted } satisfies StackRead;
      });

    const portFor = (
      ctx: PrContextBasic,
      accountId: string,
      tokenAccountId: string,
    ): MergeDriverPort => {
      const provided = <A, E>(eff: Effect.Effect<A, E, DbService | SettingsService>) =>
        Effect.provide(eff, context);
      const current = tokens
        .getTokenByAccountId(tokenAccountId)
        .pipe(Effect.map((token): PrContextBasic => ({ ...ctx, token })));
      const withCurrent = <A, E, R>(f: (c: PrContextBasic) => Effect.Effect<A, E, R>) =>
        Effect.flatMap(current, f);
      const stackError = (e: StackError): Effect.Effect<never, GitHubError> =>
        e._tag === "DbError" || e._tag === "NotFoundError" ? Effect.die(e) : Effect.fail(e);

      return {
        read: (run) =>
          provided(withCurrent((c) => readStack(c, run))).pipe(Effect.catchAll(stackError)),
        merge: (number, method, sha) =>
          provided(
            withCurrent((c) =>
              github.prs.merge(c.repo.fullName, number, method, c.token, c.apiBase, { sha }),
            ),
          ),
        retarget: (number, base) =>
          provided(
            withCurrent((c) =>
              github.prs.updateBase(c.repo.fullName, number, base, c.token, c.apiBase),
            ),
          ),
        enableAutoMerge: (nodeId, method, sha) =>
          provided(
            withCurrent((c) => github.prs.enableAutoMerge(nodeId, method, sha, c.token, c.apiBase)),
          ),
        rebase: (stack, proceed) =>
          withCurrent((c) => rebaser.rebaseStack(c, stack, accountId, proceed)).pipe(
            Effect.map((result) => result.rebased),
            Effect.mapError((e) =>
              e._tag === "StackRejectedError"
                ? e.message
                : e._tag === "GitHubAuthError"
                  ? "Couldn't rebase the stack: Revv's GitHub sign-in expired"
                  : `Couldn't rebase the stack: GitHub answered ${e._tag}`,
            ),
          ),
        save: (run, effects: SaveEffects) =>
          Effect.gen(function* () {
            const kept = yield* dbTry("stack merge run write failed", () =>
              updateLiveRun(db, run.id, {
                status: run.status,
                layersBaseFirst: [...run.layers],
                error: run.error,
                updatedAt: run.updatedAt,
              }),
            );
            if (!kept) return "ended";
            yield* announce(accountId, run);
            if (effects.merged.length > 0) {
              yield* provided(markMerged(accountId, run.repositoryId, effects.merged)).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => logError("stack-merge", "merged PR rows update failed", err)),
                ),
              );
            }
            if (effects.stackMoved) {
              yield* stacks
                .markStale(run.repositoryId, run.stackNumber)
                .pipe(Effect.catchAll(() => Effect.void));
              yield* broadcaster.broadcastToAccount(accountId, {
                type: "stack:updated",
                data: { repositoryId: run.repositoryId, stackNumber: run.stackNumber },
              });
            }
            return "live";
          }),
        isActive: (runId) =>
          dbTry("stack merge run read failed", () => {
            const row = db
              .select({ status: stackMergeRuns.status })
              .from(stackMergeRuns)
              .where(eq(stackMergeRuns.id, runId))
              .get();
            return row !== undefined && isLiveStatus(row.status);
          }),
        reportContradiction: (c) => Effect.sync(() => logContradiction("stack-merge", c)),
        now: () => Date.now(),
        sleep: (ms) => Effect.sleep(ms),
      };
    };

    const launch = (ctx: PrContextBasic, run: StackMergeRun, accountId: string) =>
      Effect.gen(function* () {
        if (driving.has(run.id)) return;
        const tokenAccountId = yield* prContext.getAccountIdForRepo(ctx.repo.id);
        driving.add(run.id);
        yield* Effect.forkDaemon(
          driveRun(run, portFor(ctx, accountId, tokenAccountId)).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                logError("stack-merge", `run ${run.id} stopped unexpectedly:`, Cause.pretty(cause));
                const message = "Revv hit an error mid-merge — Continue to pick up where GitHub is";
                const failed = yield* dbTry("stack merge run write failed", () =>
                  updateLiveRun(db, run.id, {
                    status: "failed",
                    error: message,
                    updatedAt: new Date().toISOString(),
                  }),
                );
                if (failed) yield* announce(accountId, toRun(failed));
              }).pipe(Effect.catchAll(() => Effect.void)),
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
        return yield* prContext.resolveBasic(prId, row.userId, row.accountId);
      });

    const freshStack = (ctx: PrContextBasic) =>
      Effect.flatMap(stacks.fetchFresh(ctx), (stack) =>
        stack
          ? Effect.succeed(stack)
          : Effect.fail(new NotFoundError({ resource: "stack", id: ctx.pr.id })),
      );

    const readPlan = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const stack = yield* freshStack(ctx);
        const prIds = yield* prIdsFor(
          ctx.repo.id,
          stack.layers.map((l) => l.number),
        );
        return { ctx, stack, layers: planLayers(stack, prIds) };
      });

    const plan = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const { ctx, stack, layers } = yield* readPlan(prId, userId, accountId);
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
      }).pipe(Effect.provide(context));

    const start = (prId: string, userId: string, accountId: string, request: StartRequest) =>
      Effect.gen(function* () {
        const { ctx, stack, layers } = yield* readPlan(prId, userId, accountId);
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
        const inserted = yield* dbTry("stack merge run insert failed", () =>
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
                accountId,
                userId,
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
        yield* announce(accountId, run);
        yield* launch(ctx, run, accountId);
        return run;
      }).pipe(Effect.provide(context));

    const cancel = (runId: string, accountId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRun(runId, accountId);
        if (!isLiveStatus(row.status)) return toRun(row);
        const handedOver = row.layersBaseFirst.filter((l) => l.state === "auto_merge");
        const error =
          handedOver.length > 0
            ? `Cancelled. GitHub auto-merge is still on for ${handedOver.map((l) => `#${l.number}`).join(", ")}`
            : null;
        const updated = yield* dbTry("stack merge run write failed", () =>
          updateLiveRun(db, runId, {
            status: "cancelled",
            error,
            updatedAt: new Date().toISOString(),
          }),
        );
        const run = toRun(updated ?? (yield* loadRun(runId, accountId)));
        yield* announce(accountId, run);
        return run;
      });

    const continueRun = (runId: string, accountId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRun(runId, accountId);
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
        const updated = yield* dbTry("stack merge run write failed", () =>
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
        yield* announce(accountId, run);
        yield* launch(ctx, run, accountId);
        return run;
      }).pipe(Effect.provide(context));

    const expireStale = () =>
      dbTry("stack merge run expiry failed", () => {
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
              inArray(stackMergeRuns.status, [...LIVE_RUN_STATUSES]),
              lt(stackMergeRuns.updatedAt, bootedAt),
            ),
          )
          .returning({ id: stackMergeRuns.id })
          .all().length;
      });

    return { plan, start, cancel, continueRun, expireStale };
  }),
);
