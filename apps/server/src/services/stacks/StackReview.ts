import type { StackLayer, StackReviewScope, StackReviewStarted } from "@revv/shared";
import { isOpenLayer, stackKey } from "@revv/shared";
import { inArray } from "drizzle-orm";
import { Cause, Context, Duration, Effect, Layer, Ref } from "effect";
import { walkthroughs } from "../../db/schema/walkthroughs";
import { DbError, NotFoundError } from "../../domain/errors";
import { logError } from "../../logger";
import { withGitHubOrigin } from "../../observability/github-ledger/origin";
import { DbService } from "../Db";
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
      if (review.kind === "complete" && review.reviewedHeadSha === layer.headSha) continue;
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
      userId: string,
      accountId: string,
      scope: StackReviewScope,
    ) => Effect.Effect<StackReviewStarted, StackError | NotFoundError>;
  }
>()("StackReviewService") {}

export const StackReviewServiceLive = Layer.effect(
  StackReviewService,
  Effect.gen(function* () {
    const { db } = yield* DbService;
    const stacks = yield* StackService;
    const walkthroughJobs = yield* WalkthroughJobs;
    const briefJobs = yield* StackBriefJobs;

    const running = yield* Ref.make(new Map<string, readonly number[]>());

    const generatingCount = (ids: readonly string[]): Effect.Effect<number, DbError> =>
      ids.length === 0
        ? Effect.succeed(0)
        : Effect.try({
            try: () =>
              db
                .select({ status: walkthroughs.status })
                .from(walkthroughs)
                .where(inArray(walkthroughs.id, [...ids]))
                .all()
                .filter((w) => w.status === "generating").length,
            catch: (cause) => new DbError({ message: "stack review poll failed", cause }),
          });

    const waitUntil = (
      ready: Effect.Effect<boolean, DbError>,
      deadline: number,
    ): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        while (!(yield* ready)) {
          if (Date.now() >= deadline) return false;
          yield* Effect.sleep(POLL_INTERVAL);
        }
        return true;
      });

    const review = (
      plan: StackReviewPlan,
      prId: string,
      userId: string,
      accountId: string,
    ): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const deadline = Date.now() + REVIEW_BUDGET_MS;
        const started = [...plan.watching];
        for (const layer of plan.queue) {
          const free = yield* waitUntil(
            Effect.map(generatingCount(started), (n) => n < MAX_LAYERS_IN_FLIGHT),
            deadline,
          );
          if (!free) return;
          const result = yield* walkthroughJobs
            .startJob({ prId: layer.prId, userId, trigger: "stack_review" })
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
          if (result) started.push(result);
        }
        const settled = yield* waitUntil(
          Effect.map(generatingCount(started), (n) => n === 0),
          deadline,
        );
        if (!settled) {
          logError("stack-review", `gave up waiting on ${prId}'s stack; no brief written`);
          return;
        }
        yield* briefJobs
          .ensure(prId, userId, accountId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                logError("stack-review", "stack brief failed", Cause.pretty(cause)),
              ),
            ),
          );
      });

    const start = (prId: string, userId: string, accountId: string, scope: StackReviewScope) =>
      Effect.gen(function* () {
        const detail = yield* stacks.detail(prId, userId, accountId);
        if (!detail) return yield* Effect.fail(new NotFoundError({ resource: "stack", id: prId }));

        const plan = planStackReview(detail.layers, scope);
        const key = stackKey(detail.repositoryId, detail.number);
        const queued = plan.queue.map((l) => l.number);
        const joined = yield* Ref.modify(running, (map) => {
          const current = map.get(key);
          if (current) return [current, map];
          return [null, new Map(map).set(key, queued)];
        });
        if (joined) return { queued: joined, untracked: plan.untracked };

        yield* Effect.forkDetach(
          review(plan, prId, userId, accountId).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() =>
                logError("stack-review", `review of ${key} failed`, Cause.pretty(cause)),
              ),
            ),
            Effect.ensuring(
              Ref.update(running, (map) => {
                const next = new Map(map);
                next.delete(key);
                return next;
              }),
            ),
            withGitHubOrigin("stack:review"),
          ),
        );
        return { queued, untracked: plan.untracked };
      });

    return { start };
  }),
);
