// ── First pass, per PR head ──────────────────────────────────────────────────
//
// Owns when the first pass runs. It belongs to a PR head, not a walkthrough:
// the review page starts it on open (`start`), and a walkthrough job for the
// same head joins it or runs it itself (`run`). Either way one scan runs per
// PR at a time — the in-flight map below is a reconstructible cache over
// `hunk_scans.status` (invariant 1). A run lives in a daemon fiber, so a
// walkthrough Stop doesn't cut the Diff tab's first pass short; a restart
// does, and the next `start` or `run` resumes it from the journal. A run for a
// newer head interrupts the PR's older one, which stays `running` on disk and
// resumes only if that head is asked for again.

import type { HunkScanEventMessage, HunkScanRow, HunkScanSnapshot } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { pullRequests, repositories } from "../db/schema";
import { DbError } from "../domain/errors";
import { debug } from "../logger";
import { Broadcaster } from "./Broadcaster";
import type { CacheService } from "./Cache";
import { DbService } from "./Db";
import {
  type HunkScanInput,
  planHunkScan,
  runHunkScan,
  selectionFingerprint,
} from "./hunk-scan-run";
import { loadHunkScan } from "./hunk-scan-store";
import type { JevService } from "./Jev";

/**
 * Scans calling Jev at once. They share one request quota, so more would only
 * slow each other down; the rest are seeded (their progress shows) and wait.
 */
const MAX_CONCURRENT_HUNK_SCANS = 2;

/**
 * Longest a walkthrough waits for its first pass. Past it the agent starts
 * with the leads answered so far — the scan answers the most important files
 * first — and the scan carries on for the Diff tab.
 */
export const HUNK_SCAN_JOIN_BUDGET_MS = 30_000;

export class HunkScanService extends Context.Tag("HunkScanService")<
  HunkScanService,
  {
    /**
     * Run the first pass for one PR head, joining a run already in flight, and
     * return its rows — waiting at most {@link HUNK_SCAN_JOIN_BUDGET_MS}, then
     * returning what's answered so far. A scan that already ended is returned
     * as it is. Never fails; empty when it failed or never ran.
     */
    readonly run: (input: HunkScanInput) => Effect.Effect<HunkScanRow[]>;
    /**
     * Start the first pass in the background unless it is running or done.
     * A `failed` or `partial` scan is tried again: Jev may be back. Returns at once.
     */
    readonly start: (input: HunkScanInput) => Effect.Effect<void>;
    /** What's persisted for one PR head. */
    readonly snapshot: (prId: string, headSha: string) => Effect.Effect<HunkScanSnapshot>;
  }
>() {}

interface InFlight {
  readonly headSha: string;
  /** The diff the run was seeded from (`selectionFingerprint`). */
  readonly fingerprint: string;
  readonly done: Deferred.Deferred<HunkScanRow[]>;
  readonly fiber: Fiber.RuntimeFiber<unknown>;
}

export const HunkScanServiceLive = Layer.effect(
  HunkScanService,
  Effect.gen(function* () {
    const context = yield* Effect.context<JevService | CacheService | DbService>();
    const { db } = Context.get(context, DbService);
    const broadcaster = yield* Broadcaster;
    const callSlots = yield* Effect.makeSemaphore(MAX_CONCURRENT_HUNK_SCANS);

    /** By PR id: one run per PR at a time. */
    const inFlight = new Map<string, InFlight>();

    /** The account that owns the PR's repo — the SSE scope for its events. */
    const accountIdFor = (prId: string) =>
      Effect.try({
        try: () =>
          db
            .select({ accountId: repositories.accountId })
            .from(pullRequests)
            .innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
            .where(eq(pullRequests.id, prId))
            .get()?.accountId ?? null,
        catch: (cause) => new DbError({ message: "hunk-scan account lookup failed", cause }),
      });

    const snapshot = (prId: string, headSha: string) =>
      loadHunkScan({ prId, headSha }).pipe(Effect.provide(context));

    /**
     * The run for this head and diff, forked unless one is in flight. Looking
     * up, forking and registering happen uninterruptibly, so a joiner can never
     * find a run that nothing will complete. A run for the same head seeded
     * from a different diff goes after the current one rather than racing it.
     */
    const launch = (input: HunkScanInput, retry: boolean) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const selection = planHunkScan(input);
          const fingerprint = selectionFingerprint(selection);
          const current = inFlight.get(input.prId);
          if (current?.headSha === input.headSha && current.fingerprint === fingerprint) {
            return current.done;
          }
          if (current !== undefined && current.headSha !== input.headSha) {
            yield* Fiber.interruptFork(current.fiber);
          }
          const after = current?.headSha === input.headSha ? current.done : null;

          const done = yield* Deferred.make<HunkScanRow[]>();
          const body = Effect.gen(function* () {
            if (after !== null) yield* Deferred.await(after);
            const accountId = yield* accountIdFor(input.prId).pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => {
                  debug("jev", `hunk-scan events dropped: ${String(e)}`);
                  return null;
                }),
              ),
            );
            const emit = (event: HunkScanEventMessage) =>
              accountId === null ? Effect.void : broadcaster.broadcastToAccount(accountId, event);
            return yield* runHunkScan({
              prId: input.prId,
              headSha: input.headSha,
              selection,
              retry,
              emit,
              withCallSlot: callSlots.withPermits(1),
            });
          }).pipe(
            Effect.provide(context),
            // An interrupted run (shutdown, or a newer head) still releases its
            // joiners; they go ahead without leads, and the journal resumes it.
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                if (inFlight.get(input.prId)?.done === done) inFlight.delete(input.prId);
                return Deferred.succeed(done, Exit.isSuccess(exit) ? exit.value : []);
              }),
            ),
          );
          // A fork inherits the uninterruptible region; the run itself must stay interruptible.
          const fiber = yield* Effect.forkDaemon(Effect.interruptible(body));
          inFlight.set(input.prId, { headSha: input.headSha, fingerprint, done, fiber });
          return done;
        }),
      );

    return {
      run: (input) =>
        launch(input, false).pipe(
          Effect.flatMap((done) =>
            Deferred.await(done).pipe(Effect.timeoutOption(HUNK_SCAN_JOIN_BUDGET_MS)),
          ),
          Effect.flatMap(
            Option.match({
              onSome: (rows) => Effect.succeed(rows),
              onNone: () =>
                Effect.sync(() =>
                  debug(
                    "jev",
                    `hunk-scan ${input.prId}: past the join budget, going ahead with what's answered`,
                  ),
                ).pipe(
                  Effect.zipRight(snapshot(input.prId, input.headSha)),
                  Effect.map((s) => s.rows),
                ),
            }),
          ),
        ),
      start: (input) => Effect.asVoid(launch(input, true)),
      snapshot,
    };
  }),
);
