import { randomUUID } from "node:crypto";
import type { StackLayer, StackReviewScope, StackReviewStarted } from "@revv/shared";
import { isOpenLayer, layerNeedsReview, stackKey } from "@revv/shared";
import { and, eq, inArray } from "drizzle-orm";
import { Cause, Context, Duration, Effect, Layer } from "effect";
import { stackReviews } from "../../db/schema/stack-reviews";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { type DbError, NotFoundError } from "../../domain/errors";
import { dbTry } from "../../effects/db-try";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { DbService } from "../Db";
import { makeStartJobMutex } from "../job-mutex";
import { WalkthroughJobs } from "../WalkthroughJobs";
import { StackBriefJobs } from "./StackBriefJobs";
import { type StackError, StackService } from "./StackService";

const MAX_LAYERS_IN_FLIGHT = 2;
const POLL_INTERVAL = Duration.seconds(3);
const REVIEW_BUDGET_MS = 2 * 60 * 60 * 1000;

export interface StackReviewPlan {
  readonly queue: ReadonlyArray<{ readonly number: number; readonly prId: string }>;
  readonly watching: readonly string[];
  readonly untracked: readonly number[];
}

export function planStackReview(
  layers: readonly StackLayer[],
  scope: StackReviewScope,
): StackReviewPlan {
  const queue: { number: number; prId: string }[] = [];
  const watching: string[] = [];
  const untracked: number[] = [];
  const open = [...layers].filter(isOpenLayer).sort((a, b) => a.position - b.position);
  for (const layer of open) {
    if (layer.prId === null) {
      untracked.push(layer.number);
      continue;
    }
    const { review } = layer;
    if (scope === "remaining") {
      if (review.kind === "generating") {
        watching.push(review.walkthroughId);
        continue;
      }
      if (!layerNeedsReview(layer)) continue;
    }
    queue.push({ number: layer.number, prId: layer.prId });
  }
  return { queue, watching, untracked };
}

export class StackReviewService extends Context.Service<
  StackReviewService,
  {
    /**
     * Start reviewing the PR's stack and return at once with what was
     * queued. A second ask while one is running for the same stack joins it.
     */
    readonly start: (
      prId: string,
      accountId: string,
      scope: StackReviewScope,
    ) => Effect.Effect<StackReviewStarted, StackError | NotFoundError | DbError>;
    /** Pick up the reviews a previous process left running. */
    readonly resumePending: () => Effect.Effect<void>;
  }
>()("StackReviewService") {}

export const StackReviewServiceLive = Layer.effect(
  StackReviewService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const stacks = yield* StackService;
    const walkthroughJobs = yield* WalkthroughJobs;
    const briefJobs = yield* StackBriefJobs;
    const scope = yield* Effect.scope;
    const stackMutex = yield* makeStartJobMutex();

    type Review = typeof stackReviews.$inferSelect;

    const read = (id: string) =>
      dbTry("stack review read", () =>
        db.select().from(stackReviews).where(eq(stackReviews.id, id)).get(),
      );
    const finish = (id: string, status: "done" | "abandoned") =>
      dbTry("stack review finish", () =>
        db.update(stackReviews).set({ status }).where(eq(stackReviews.id, id)).run(),
      );

    const generatingCount = (ids: readonly string[]): Effect.Effect<number, DbError> =>
      ids.length === 0
        ? Effect.succeed(0)
        : dbTry(
            "stack review poll",
            () =>
              db
                .select({ status: walkthroughs.status })
                .from(walkthroughs)
                .where(inArray(walkthroughs.id, [...ids]))
                .all()
                .filter((w) => w.status === "generating").length,
          );

    const startNextLayer = (review: Review): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const layer = review.layers[review.started];
        if (!layer) return;
        const walkthroughId = yield* walkthroughJobs
          .startJob({ prId: layer.prId, trigger: "stack_review" })
          .pipe(
            Effect.map((r) => r.walkthroughId),
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                logError(
                  "stack-review",
                  `layer #${layer.number} failed to start`,
                  Cause.pretty(cause),
                );
                return null;
              }),
            ),
          );
        yield* dbTry("stack review progress", () =>
          db
            .update(stackReviews)
            .set({
              started: review.started + 1,
              awaiting: walkthroughId ? [...review.awaiting, walkthroughId] : review.awaiting,
            })
            .where(eq(stackReviews.id, review.id))
            .run(),
        );
      });

    // Each step re-reads the row, so a review cut off at any point picks up
    // from the journal: a layer started but not yet recorded is started
    // again, which joins its run.
    const drive = (id: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        while (true) {
          const review = yield* read(id);
          if (review?.status !== "running") return;
          if (Date.now() >= Date.parse(review.deadlineAt)) {
            logError("stack-review", `gave up waiting on ${review.prId}'s stack; no brief written`);
            return yield* finish(id, "abandoned");
          }
          const inFlight = yield* generatingCount(review.awaiting);
          if (review.started < review.layers.length) {
            if (inFlight < MAX_LAYERS_IN_FLIGHT) {
              yield* startNextLayer(review);
              continue;
            }
          } else if (inFlight === 0) {
            // Asked before the row is closed: a restart in between asks again,
            // and `ensure` answers with the brief already there.
            yield* briefJobs
              .ensure(review.prId, review.accountId)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() =>
                    logError("stack-review", "stack brief failed", Cause.pretty(cause)),
                  ),
                ),
              );
            return yield* finish(id, "done");
          }
          yield* Effect.sleep(POLL_INTERVAL);
        }
      });

    const run = (id: string): Effect.Effect<void> =>
      Effect.asVoid(
        Effect.forkIn(
          drive(id).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                logError("stack-review", `review ${id} failed`, Cause.pretty(cause)),
              ),
            ),
            withGitHubOrigin("stack:review"),
          ),
          scope,
        ),
      );

    const start = (prId: string, accountId: string, reviewScope: StackReviewScope) =>
      Effect.gen(function* () {
        const detail = yield* stacks.detail(prId, accountId);
        if (!detail) return yield* Effect.fail(new NotFoundError({ resource: "stack", id: prId }));

        const plan = planStackReview(detail.layers, reviewScope);
        const mutex = yield* stackMutex.acquire(stackKey(detail.repositoryId, detail.number));
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* dbTry("stack review lookup", () =>
              db
                .select({ layers: stackReviews.layers })
                .from(stackReviews)
                .where(
                  and(
                    eq(stackReviews.repositoryId, detail.repositoryId),
                    eq(stackReviews.stackNumber, detail.number),
                    eq(stackReviews.status, "running"),
                  ),
                )
                .get(),
            );
            if (current) {
              return { queued: current.layers.map((l) => l.number), untracked: plan.untracked };
            }
            const id = randomUUID();
            const now = Date.now();
            yield* dbTry("stack review create", () =>
              db
                .insert(stackReviews)
                .values({
                  id,
                  repositoryId: detail.repositoryId,
                  stackNumber: detail.number,
                  prId,
                  accountId,
                  status: "running",
                  layers: [...plan.queue],
                  awaiting: [...plan.watching],
                  deadlineAt: new Date(now + REVIEW_BUDGET_MS).toISOString(),
                  createdAt: new Date(now).toISOString(),
                })
                .run(),
            );
            yield* run(id);
            return { queued: plan.queue.map((l) => l.number), untracked: plan.untracked };
          }),
        );
      });

    const resumePending = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const ids = yield* dbTry("stack review resume scan", () =>
          db
            .select({ id: stackReviews.id })
            .from(stackReviews)
            .where(eq(stackReviews.status, "running"))
            .all(),
        );
        for (const { id } of ids) yield* run(id);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => logError("stack-review", "resumePending failed", Cause.pretty(cause))),
        ),
      );

    return { start, resumePending };
  }),
);
