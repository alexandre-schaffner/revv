// ── Stack merge service ─────────────────────────────────────────────────────
//
// "Merge this stack through layer N": the plan (what can merge, how far), the
// run (persisted in `stack_merge_runs`, then advanced by a daemon fiber), and
// its lifecycle (cancel, continue, expire on boot). The decisions live in
// `merge-plan.ts` and the step loop in `merge-driver.ts`; this file is their
// I/O: GitHub reads and writes, the run row, and the broadcasts.
//
// The row is the journal. A fiber's memory is never authoritative: it
// re-reads GitHub every step, and stops as soon as its row has left
// `running`/`waiting`. A run a restart cut off is never resumed by itself.

import type {
  MergeMethod,
  PullRequest,
  StackMergeMode,
  StackMergePlan,
  StackMergeRun,
  StackMergeRunLayer,
  StackMergeRunStatus,
} from "@revv/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { Cause, Context, Effect, Layer } from "effect";
import { pullRequests } from "../../db/schema/pull-requests";
import { stackMergeRuns } from "../../db/schema/stack-merge-runs";
import {
  DbError,
  type GitHubError,
  NotFoundError,
  StackMergeRejectedError,
} from "../../domain/errors";
import { logError } from "../../logger";
import { Broadcaster } from "../Broadcaster";
import type { CacheService } from "../Cache";
import { DbService } from "../Db";
import { GitHubGateway } from "../GitHub";
import { githubGraphql } from "../github-rest";
import { type PrContextBasic, PrContextService } from "../PrContext";
import { PullRequestService } from "../PullRequest";
import type { SettingsService } from "../Settings";
import type { GitHubStack } from "./map";
import { driveRun, type MergeDriverPort, type SaveEffects } from "./merge-driver";
import {
  defaultThrough,
  initialRunLayers,
  mergeModeOf,
  planLayers,
  type StackRead,
  type StartRequest,
  startRefusal,
} from "./merge-plan";
import { StackRebaseService } from "./StackRebase";
import { type StackError, StackService } from "./StackService";

/** A run this long past its last step was abandoned, not interrupted mid-step. */
const STALE_RUN_MS = 30 * 60_000;

const LIVE_STATUSES: readonly StackMergeRunStatus[] = ["running", "waiting"];
/** The plan offers these back to the user: in flight, or stopped with a Continue. */
const SHOWN_STATUSES: readonly StackMergeRunStatus[] = ["running", "waiting", "failed", "expired"];

export type StackMergeError = StackError | StackMergeRejectedError | NotFoundError;

export class StackMergeService extends Context.Tag("StackMergeService")<
  StackMergeService,
  {
    /** What can merge in this PR's stack, read fresh from GitHub. */
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
    /** Pick a failed or expired run up from wherever GitHub is now. */
    readonly continueRun: (
      runId: string,
      accountId: string,
    ) => Effect.Effect<StackMergeRun, StackMergeError>;
    /** On boot: every run a previous process left live becomes `expired`. */
    readonly expireStale: () => Effect.Effect<number, DbError>;
  }
>() {}

// ── The row ─────────────────────────────────────────────────────────────────

type RunRow = typeof stackMergeRuns.$inferSelect;

function parseLayers(json: string): StackMergeRunLayer[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StackMergeRunLayer[]) : [];
  } catch {
    return [];
  }
}

function toRun(row: RunRow): StackMergeRun {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    stackNumber: row.stackNumber,
    throughPosition: row.throughPosition,
    method: row.method as MergeMethod,
    mode: row.mode as StackMergeMode,
    status: row.status as StackMergeRunStatus,
    layers: parseLayers(row.layers),
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── GitHub: one PR's state, for a layer the stack stopped listing ───────────

const PR_STATE_QUERY = `
  query PrMergeState($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) { state }
    }
  }
`;

interface RawPrState {
  readonly repository: { readonly pullRequest: { readonly state: string } | null } | null;
}

/** The context, asking GitHub about another PR of the same repo. */
const asPr = (ctx: PrContextBasic, number: number): PrContextBasic => ({
  ...ctx,
  pr: { ...ctx.pr, externalId: number },
});

// ── Live ────────────────────────────────────────────────────────────────────

export const StackMergeServiceLive = Layer.effect(
  StackMergeService,
  Effect.gen(function* () {
    const context = yield* Effect.context<DbService | CacheService | SettingsService>();
    const { db } = Context.get(context, DbService);
    const stacks = yield* StackService;
    const github = yield* GitHubGateway;
    const prContext = yield* PrContextService;
    const prService = yield* PullRequestService;
    const broadcaster = yield* Broadcaster;
    const rebaser = yield* StackRebaseService;

    /** Runs this process is stepping, so a double Continue can't fork twice. */
    const driving = new Set<string>();
    /** Rows this process wrote are never a previous process's leftovers. */
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

    const latestShownRun = (repositoryId: string, stackNumber: number) =>
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
        return row && SHOWN_STATUSES.includes(row.status as StackMergeRunStatus)
          ? toRun(row)
          : null;
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

    /** The PR rows GitHub just merged, the way a single-PR merge updates them. */
    const markMerged = (accountId: string, repositoryId: string, numbers: readonly number[]) =>
      Effect.gen(function* () {
        const ids = yield* prIdsFor(repositoryId, numbers);
        const now = new Date().toISOString();
        const rows: PullRequest[] = [];
        for (const id of ids.values()) {
          const pr = yield* Effect.option(prService.getPr(id, accountId));
          if (pr._tag === "None" || pr.value.status === "merged") continue;
          rows.push({
            ...pr.value,
            status: "merged",
            closedAt: now,
            updatedAt: now,
            fetchedAt: now,
          });
        }
        if (rows.length === 0) return;
        yield* prService.upsertPrs(rows);
        const all = yield* prService.listPrs(accountId);
        yield* broadcaster.broadcastToAccount(accountId, { type: "prs:updated", data: all });
      });

    // ── Reading the stack for a step ──────────────────────────────────────

    /**
     * The stack, asked through its open layers from the top down: whether
     * GitHub keeps merged layers in a stack (and so whether a merged PR still
     * answers for it) is unverified, and the top of a run stays open longest.
     */
    const readStack = (ctx: PrContextBasic, run: StackMergeRun) =>
      Effect.gen(function* () {
        const order = [...run.layers].sort(
          (a, b) =>
            Number(a.state === "merged") - Number(b.state === "merged") || b.position - a.position,
        );
        let stack: GitHubStack | null = null;
        for (const layer of order) {
          const found = yield* stacks.fetchFresh(asPr(ctx, layer.number));
          if (found?.number === run.stackNumber) {
            stack = found;
            break;
          }
        }
        if (!stack) return null;
        const listed = new Set(stack.layers.map((l) => l.number));
        const mergedOutside = new Set<number>();
        const [owner, repo] = ctx.repo.fullName.split("/");
        for (const layer of run.layers) {
          if (listed.has(layer.number) || !owner || !repo) continue;
          const answer = yield* githubGraphql<RawPrState>(
            PR_STATE_QUERY,
            { owner, repo, number: layer.number },
            ctx.token,
            ctx.apiBase,
          );
          if (answer.repository?.pullRequest?.state === "MERGED") mergedOutside.add(layer.number);
        }
        return { stack, mergedOutside } satisfies StackRead;
      });

    // ── The port the step loop runs against ───────────────────────────────

    const portFor = (ctx: PrContextBasic, accountId: string): MergeDriverPort => {
      const provided = <A, E>(
        eff: Effect.Effect<A, E, DbService | CacheService | SettingsService>,
      ) => Effect.provide(eff, context);
      const stackError = (e: StackError): Effect.Effect<never, GitHubError> =>
        e._tag === "DbError" || e._tag === "NotFoundError" ? Effect.die(e) : Effect.fail(e);

      return {
        read: (run) => provided(readStack(ctx, run)).pipe(Effect.catchAll(stackError)),
        merge: (number, method, sha) =>
          provided(
            github.prs.merge(ctx.repo.fullName, number, method, ctx.token, ctx.apiBase, { sha }),
          ),
        retarget: (number, base) =>
          provided(github.prs.updateBase(ctx.repo.fullName, number, base, ctx.token, ctx.apiBase)),
        enableAutoMerge: (nodeId, method, sha) =>
          provided(github.prs.enableAutoMerge(nodeId, method, sha, ctx.token, ctx.apiBase)),
        rebase: (stack) =>
          rebaser.rebaseStack(ctx, stack, accountId).pipe(
            Effect.map((result) => result.rebased),
            Effect.mapError((e) =>
              e._tag === "StackRebaseRejectedError"
                ? e.message
                : `Couldn't rebase the stack: GitHub answered ${e._tag}`,
            ),
          ),
        save: (run, effects: SaveEffects) =>
          Effect.gen(function* () {
            // Conditional on the row still being live: a cancel committed
            // between steps must not be overwritten by the step after it.
            const kept = yield* dbTry("stack merge run write failed", () =>
              db
                .update(stackMergeRuns)
                .set({
                  status: run.status,
                  layers: JSON.stringify(run.layers),
                  error: run.error,
                  updatedAt: run.updatedAt,
                })
                .where(
                  and(
                    eq(stackMergeRuns.id, run.id),
                    inArray(stackMergeRuns.status, [...LIVE_STATUSES]),
                  ),
                )
                .returning({ id: stackMergeRuns.id })
                .all(),
            ).pipe(Effect.map((rows) => rows.length > 0));
            if (!kept) return false;
            // Commit first; everything after is best-effort.
            yield* announce(accountId, run);
            if (effects.merged.length > 0) {
              yield* provided(markMerged(accountId, run.repositoryId, effects.merged)).pipe(
                Effect.catchAll((err) =>
                  Effect.sync(() => logError("stack-merge", "merged PR rows update failed", err)),
                ),
              );
            }
            if (effects.stackMoved) {
              yield* provided(stacks.invalidate(run.repositoryId, run.stackNumber)).pipe(
                Effect.catchAll(() => Effect.void),
              );
              yield* broadcaster.broadcastToAccount(accountId, {
                type: "stack:updated",
                data: { repositoryId: run.repositoryId, stackNumber: run.stackNumber },
              });
            }
            return true;
          }),
        isActive: (runId) =>
          dbTry("stack merge run read failed", () => {
            const row = db
              .select({ status: stackMergeRuns.status })
              .from(stackMergeRuns)
              .where(eq(stackMergeRuns.id, runId))
              .get();
            return row !== undefined && LIVE_STATUSES.includes(row.status as StackMergeRunStatus);
          }),
        now: () => Date.now(),
        sleep: (ms) => Effect.sleep(ms),
      };
    };

    /** Fork the step loop for a run whose row is already live. */
    const launch = (ctx: PrContextBasic, run: StackMergeRun, accountId: string) =>
      Effect.gen(function* () {
        if (driving.has(run.id)) return;
        driving.add(run.id);
        yield* Effect.forkDaemon(
          driveRun(run, portFor(ctx, accountId)).pipe(
            Effect.catchAllCause((cause) =>
              Effect.gen(function* () {
                logError("stack-merge", `run ${run.id} stopped unexpectedly:`, Cause.pretty(cause));
                const message = "Revv hit an error mid-merge — Continue to pick up where GitHub is";
                const failed = yield* dbTry("stack merge run write failed", () =>
                  db
                    .update(stackMergeRuns)
                    .set({ status: "failed", error: message, updatedAt: new Date().toISOString() })
                    .where(
                      and(
                        eq(stackMergeRuns.id, run.id),
                        inArray(stackMergeRuns.status, [...LIVE_STATUSES]),
                      ),
                    )
                    .returning()
                    .get(),
                );
                if (failed) yield* announce(accountId, toRun(failed));
              }).pipe(Effect.catchAll(() => Effect.void)),
            ),
            Effect.ensuring(Effect.sync(() => driving.delete(run.id))),
          ),
        );
      });

    /** A PR Revv tracks in the run's stack, to borrow its repo and token. */
    const contextForRun = (row: RunRow) =>
      Effect.gen(function* () {
        const numbers = parseLayers(row.layers).map((l) => l.number);
        const ids = yield* prIdsFor(row.repositoryId, numbers);
        const prId = ids.values().next().value;
        if (prId === undefined) {
          return yield* Effect.fail(
            new StackMergeRejectedError({
              message: "Revv no longer tracks any PR in this stack",
              reason: "invalid",
            }),
          );
        }
        return yield* prContext.resolveBasic(prId, row.userId, row.accountId);
      });

    // ── Public API ────────────────────────────────────────────────────────

    const freshStack = (ctx: PrContextBasic) =>
      Effect.flatMap(stacks.fetchFresh(ctx), (stack) =>
        stack
          ? Effect.succeed(stack)
          : Effect.fail(new NotFoundError({ resource: "stack", id: ctx.pr.id })),
      );

    const plan = (prId: string, userId: string, accountId: string) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const stack = yield* freshStack(ctx);
        const prIds = yield* prIdsFor(
          ctx.repo.id,
          stack.layers.map((l) => l.number),
        );
        const layers = planLayers(stack, prIds);
        return {
          repositoryId: ctx.repo.id,
          stackNumber: stack.number,
          baseRefName: stack.baseRefName,
          layers,
          defaultThrough: defaultThrough(layers),
          allowedMethods: stack.allowedMethods,
          mode: mergeModeOf(stack),
          activeRun: yield* latestShownRun(ctx.repo.id, stack.number),
        } satisfies StackMergePlan;
      }).pipe(Effect.provide(context));

    const start = (prId: string, userId: string, accountId: string, request: StartRequest) =>
      Effect.gen(function* () {
        const ctx = yield* prContext.resolveBasic(prId, userId, accountId);
        const stack = yield* freshStack(ctx);
        const prIds = yield* prIdsFor(
          ctx.repo.id,
          stack.layers.map((l) => l.number),
        );
        const layers = planLayers(stack, prIds);
        const refusal = startRefusal(stack, layers, request);
        if (refusal) return yield* Effect.fail(new StackMergeRejectedError(refusal));
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
        // Check and insert in one transaction: two confirms racing must not
        // both start a run on the same stack.
        const inserted = yield* dbTry("stack merge run insert failed", () =>
          db.transaction((tx) => {
            const live = tx
              .select({ id: stackMergeRuns.id })
              .from(stackMergeRuns)
              .where(
                and(
                  eq(stackMergeRuns.repositoryId, run.repositoryId),
                  eq(stackMergeRuns.stackNumber, run.stackNumber),
                  inArray(stackMergeRuns.status, [...LIVE_STATUSES]),
                ),
              )
              .get();
            if (live) return false;
            tx.insert(stackMergeRuns)
              .values({
                id: run.id,
                repositoryId: run.repositoryId,
                stackNumber: run.stackNumber,
                throughPosition: run.throughPosition,
                method: run.method,
                mode: run.mode,
                status: run.status,
                layers: JSON.stringify(run.layers),
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
            new StackMergeRejectedError({
              message: "This stack is already being merged",
              reason: "conflict",
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
        if (!LIVE_STATUSES.includes(row.status as StackMergeRunStatus)) return toRun(row);
        const handedOver = parseLayers(row.layers).filter((l) => l.state === "auto_merge");
        const error =
          handedOver.length > 0
            ? `Cancelled. GitHub auto-merge is still on for ${handedOver.map((l) => `#${l.number}`).join(", ")}`
            : null;
        const updated = yield* dbTry("stack merge run write failed", () =>
          db
            .update(stackMergeRuns)
            .set({ status: "cancelled", error, updatedAt: new Date().toISOString() })
            .where(
              and(eq(stackMergeRuns.id, runId), inArray(stackMergeRuns.status, [...LIVE_STATUSES])),
            )
            .returning()
            .get(),
        );
        // A step finished the run between the read and the write.
        const run = toRun(updated ?? (yield* loadRun(runId, accountId)));
        yield* announce(accountId, run);
        return run;
      });

    const continueRun = (runId: string, accountId: string) =>
      Effect.gen(function* () {
        const row = yield* loadRun(runId, accountId);
        if (row.status !== "failed" && row.status !== "expired") {
          return yield* Effect.fail(
            new StackMergeRejectedError({
              message: "Only a stopped merge can be continued",
              reason: "conflict",
            }),
          );
        }
        const ctx = yield* contextForRun(row);
        // Failed layers go back to pending; the first step re-reads GitHub
        // and takes each from wherever it is now, heads still pinned.
        const layers = parseLayers(row.layers).map((l) =>
          l.state === "merged" ? l : { ...l, state: "pending" as const, message: null },
        );
        const now = new Date().toISOString();
        const updated = yield* dbTry("stack merge run write failed", () =>
          db
            .update(stackMergeRuns)
            .set({ status: "running", error: null, layers: JSON.stringify(layers), updatedAt: now })
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
            new StackMergeRejectedError({
              message: "This merge is already running",
              reason: "conflict",
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
        const stamp = new Date(now).toISOString();
        // Only rows a previous process left: a run started since boot, before
        // this ran, is this process's own.
        const live = and(
          inArray(stackMergeRuns.status, [...LIVE_STATUSES]),
          lt(stackMergeRuns.updatedAt, bootedAt),
        );
        const old = db
          .update(stackMergeRuns)
          .set({
            status: "expired",
            error: "This merge stopped a while ago — Continue to pick up where GitHub is",
            updatedAt: stamp,
          })
          .where(and(live, lt(stackMergeRuns.updatedAt, cutoff)))
          .returning({ id: stackMergeRuns.id })
          .all().length;
        // Younger ones were cut off by the restart itself.
        const recent = db
          .update(stackMergeRuns)
          .set({
            status: "expired",
            error: "Revv restarted mid-merge — Continue to pick up where GitHub is",
            updatedAt: stamp,
          })
          .where(live)
          .returning({ id: stackMergeRuns.id })
          .all().length;
        return old + recent;
      });

    return { plan, start, cancel, continueRun, expireStale };
  }),
);
