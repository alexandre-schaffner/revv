// ── Boot ─────────────────────────────────────────────────────────────────────
// Every service's start-up work, in one sequence whose ordering is the code
// below. Built with the runtime, so it runs once the server's runtime is
// forced (after `listen`), in the runtime's scope: shutdown interrupts what is
// still running, and its finalizer stops the agent connection pool.

import { Cause, Effect, Layer } from "effect";
import { stopAllAcpConnections } from "./ai/acp/acp-connection";
import { logError } from "./logger";
import { withGitHubOrigin } from "./observability/github-ledger/origin";
import { DbMaintenance } from "./services/DbMaintenance";
import { Identity } from "./services/Identity";
import { PollScheduler } from "./services/PollScheduler";
import { ensureHighlighter } from "./services/PrerenderCache";
import { ProjectRecapJobs } from "./services/ProjectRecapJobs";
import { RecapScheduler } from "./services/RecapScheduler";
import { RepoCloneService } from "./services/RepoClone";
import { StackBriefJobs } from "./services/stacks/StackBriefJobs";
import { StackMergeService } from "./services/stacks/StackMerge";
import { StackReviewService } from "./services/stacks/StackReview";
import { WalkthroughJobs } from "./services/WalkthroughJobs";

/** One boot step; a failure is logged and never stops the others. */
const step = <R>(
  scope: string,
  effect: Effect.Effect<unknown, unknown, R>,
): Effect.Effect<void, never, R> =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.sync(() => logError(scope, "boot step failed:", Cause.pretty(cause))),
    ),
  );

export const BootLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const identity = yield* Identity;
    const pollScheduler = yield* PollScheduler;
    const walkthroughJobs = yield* WalkthroughJobs;
    const recapJobs = yield* ProjectRecapJobs;
    const recapScheduler = yield* RecapScheduler;
    const briefJobs = yield* StackBriefJobs;
    const stackReview = yield* StackReviewService;
    const stackMerge = yield* StackMergeService;
    const repoClone = yield* RepoCloneService;
    const dbMaintenance = yield* DbMaintenance;

    yield* Effect.addFinalizer(() => Effect.sync(stopAllAcpConnections));

    const sequence = Effect.all(
      [
        // Plaintext GitHub tokens move into the OS secure store before the
        // first poll reads them.
        step(
          "secret-store",
          identity.migrateLegacyTokenSecrets.pipe(
            Effect.tap((n) =>
              Effect.sync(() => {
                if (n > 0)
                  logError("secret-store", `migrated ${n} GitHub token(s) into secure storage`);
              }),
            ),
          ),
        ).pipe(Effect.andThen(step("poll-scheduler", pollScheduler.start()))),

        // Clones cut off by the last shutdown restart before walkthroughs
        // resume (a resumed run waits on its clone), and the worktree sweep
        // runs after resume, so a resumed run's worktree is protected by
        // `pruneWorktree`'s `generating` guard.
        step("repo-clone", repoClone.resumePendingClones()).pipe(
          Effect.andThen(step("walkthrough-jobs", walkthroughJobs.resumePending())),
          Effect.andThen(step("repo-clone", repoClone.sweepStaleWorktrees())),
        ),

        // A recap cut off mid-generation finishes (or fails) before the
        // scheduler may count its window as covered or ask for it again.
        step("recap-jobs", recapJobs.resumePending()).pipe(
          Effect.andThen(step("recap-scheduler", recapScheduler.start())),
        ),

        step("stack-brief", briefJobs.resumePending()),
        step("stack-review", stackReview.resumePending()),
        step("stack-merge", stackMerge.expireStale()),
        step("db-maintenance", dbMaintenance.start()),
        // The shared highlighter every prerender uses, so the first
        // walkthrough emit hits a warm one.
        step(
          "prerender",
          Effect.tryPromise(() => ensureHighlighter()),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    );

    yield* Effect.forkScoped(sequence.pipe(withGitHubOrigin("boot", "boot")));
  }),
);
