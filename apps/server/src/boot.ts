// Every service's start-up work, in one sequence whose ordering is the code
// below. Built with the runtime, so it runs once the server's runtime is
// forced (after `listen`), in the runtime's scope: shutdown interrupts what is
// still running, and its finalizer stops the agent connection pool.

import { Cause, Effect, Layer } from "effect";
import { stopAllAcpConnections } from "./ai/acp/acp-connection";
import { refreshUserPath } from "./ai/acp/host";
import { logError } from "./logger";
import { withGitHubOrigin } from "./observability/github-ledger/origin";
import { RepoCloneService } from "./services/clone/RepoClone";
import { DbMaintenance } from "./services/DbMaintenance";
import { ExternalIntegrations } from "./services/ExternalIntegrations";
import { killRunningGitProcesses } from "./services/git/ops";
import { GitHubAccounts } from "./services/github/accounts";
import { PollScheduler } from "./services/PollScheduler";
import { ensureHighlighter } from "./services/pr-file-prerender";
import { ProjectRecapJobs } from "./services/recaps/ProjectRecapJobs";
import { RecapScheduler } from "./services/recaps/RecapScheduler";
import { StackBriefJobs } from "./services/stacks/StackBriefJobs";
import { StackMergeService } from "./services/stacks/StackMerge";
import { StackReviewService } from "./services/stacks/StackReview";
import { WalkthroughJobs } from "./services/walkthrough/WalkthroughJobs";
import { AgentWorktrees } from "./services/workspace/agent-worktrees";

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
    const accounts = yield* GitHubAccounts;
    const pollScheduler = yield* PollScheduler;
    const walkthroughJobs = yield* WalkthroughJobs;
    const recapJobs = yield* ProjectRecapJobs;
    const recapScheduler = yield* RecapScheduler;
    const briefJobs = yield* StackBriefJobs;
    const stackReview = yield* StackReviewService;
    const stackMerge = yield* StackMergeService;
    const repoClone = yield* RepoCloneService;
    const agentWorktrees = yield* AgentWorktrees;
    const dbMaintenance = yield* DbMaintenance;
    const externalIntegrations = yield* ExternalIntegrations;

    yield* Effect.addFinalizer(() => Effect.sync(stopAllAcpConnections));
    // Orphaned `git clone`s would fight the next lifetime for `.git/shallow.lock`
    // and write into directories it removed.
    yield* Effect.addFinalizer(() => Effect.sync(killRunningGitProcesses));

    const sequence = Effect.all(
      [
        // Plaintext GitHub tokens move into the OS secure store before the
        // first poll reads them.
        step(
          "secret-store",
          accounts.migrateLegacyTokens.pipe(
            Effect.tap((n) =>
              Effect.sync(() => {
                if (n > 0)
                  logError("secret-store", `migrated ${n} GitHub token(s) into secure storage`);
              }),
            ),
          ),
        ).pipe(Effect.andThen(step("poll-scheduler", pollScheduler.start()))),

        // Clones cut off by the last shutdown restart before walkthroughs
        // resume (a resumed run waits on its clone). The worktree sweeps run
        // after resume: they reap the agent worktrees of closed or untracked
        // PRs and the review worktrees of walkthroughs no longer generating, so
        // a resumed run's review worktree counts as generating.
        step("repo-clone", repoClone.recoverAtBoot()).pipe(
          Effect.andThen(step("walkthrough-jobs", walkthroughJobs.resumePending())),
          Effect.andThen(step("repo-clone", repoClone.sweepReviewWorktrees())),
          Effect.andThen(step("agent-worktrees", agentWorktrees.sweep())),
        ),

        // A window's `generating` recap is reused by any request for it
        // (`requestRecap`), so the scheduler can't open a second one; resuming
        // first only means it finds those runs already live.
        step("recap-jobs", recapJobs.resumePending()).pipe(
          Effect.andThen(step("recap-scheduler", recapScheduler.start())),
        ),

        step("stack-brief", briefJobs.resumePending()),
        step("stack-review", stackReview.resumePending()),
        step("stack-merge", stackMerge.expireStale()),
        step("db-maintenance", dbMaintenance.start()),
        // Installs in the coding agents' configs pick up this release's
        // bridge, guide and server URL.
        step("external-integrations", externalIntegrations.refreshInstalls()),
        // Warm, so the first agent probe doesn't block on the login shell.
        step(
          "agent-path",
          Effect.promise(() => refreshUserPath()),
        ),
        // Warm, so the first PR files request doesn't pay for it.
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
