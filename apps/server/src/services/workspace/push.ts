// Shipping the agent's commits: turning the proposed commits on the agent
// branch into commits on the PR's source branch, or on a new branch.
//
// The merge push detaches the worktree onto the fetched source-branch tip,
// merges the agent branch into it (a fast-forward when it can), pushes
// `HEAD:refs/heads/<source>` leased on the tip `ls-remote` read, then moves
// the agent branch to the pushed tip. A conflict either aborts back to the
// agent branch (`mergeAndPush`) or is handed to a one-shot agent run
// (`resolveAndPush`). A cherry-pick push replays chosen commits onto the
// source tip instead, then rebuilds the agent branch on the pushed tip.
//
// Every flow holds the PR's workspace claim and the source branch's push lock
// for its whole run; both are taken before any git work, so an overlapping
// flow is refused up front.

import type { AgentProgressFrame } from "@revv/shared";
import { type Context, Effect, Exit, Queue, Scope } from "effect";
import {
  type AiError,
  type CloneError,
  type CloneNotReadyError,
  type ConcurrentPushError,
  type DbError,
  DirtyWorktreeError,
  GitHubAuthError,
  type GitHubError,
  GitOperationError,
  InvalidBranchNameError,
  NoChangesError,
  NoChatSessionError,
  type NotFoundError,
  PushRejectedError,
  type RefAlreadyExistsError,
  type WorkspaceBusyError,
} from "../../domain/errors";
import { logError } from "../../logger";
import type { AiService } from "../Ai";
import { pumpAgentFrames, queueToStream } from "../agent-frame-pump";
import type { ChatSessionRow, ChatSessionService } from "../ChatSession";
import type { DbService } from "../Db";
import type { GitHubEtagCache } from "../GitHubEtagCache";
import type { BranchPushLock } from "../git/branch-push-lock";
import {
  abortCherryPick,
  abortMerge,
  assertNotFlagLike,
  checkoutDetached,
  cherryPick,
  fetch,
  isMergeInProgress,
  isValidSha,
  merge,
  resolveRef,
  unmergedPaths,
  workingTreeIsClean,
} from "../git/ops";
import {
  classifyPushFailure,
  describePushRejection,
  lsRemoteHead,
  pushLeased,
  pushNewBranch,
} from "../git/push";
import { authedRemoteUrl } from "../git/remote";
import type { PrContextBasic, PrContextError } from "../PrContext";
import type { makePrHeadRefresh } from "../pr-head-refresh";
import type { SettingsService } from "../Settings";
import {
  type AgentBranch,
  countProposed,
  healAbandonedMerge,
  moveAgentBranch,
  proposedShas,
  replayAgentCommits,
  restoreAgentBranch,
} from "./agent-branch";
import type { WorkspaceClaim } from "./claims";

export type ChatPushError =
  | WorkspaceBusyError
  | ConcurrentPushError
  | DirtyWorktreeError
  | NoChangesError
  | NoChatSessionError
  | PushRejectedError
  | GitOperationError
  | RefAlreadyExistsError
  | InvalidBranchNameError
  | NotFoundError
  | GitHubAuthError
  | GitHubError
  | PrContextError
  | CloneError
  | CloneNotReadyError
  | AiError
  | DbError;

export type AttemptPushResult =
  | {
      readonly status: "pushed";
      readonly newSha: string;
      readonly pushedCommits: number;
      readonly branch: string;
    }
  | { readonly status: "conflict"; readonly files: readonly string[]; readonly branch: string }
  | { readonly status: "remote-changed"; readonly branch: string }
  | { readonly status: "ref-exists"; readonly branch: string };

export type ResolvePushFrame =
  | { readonly kind: "status"; readonly message: string }
  | { readonly kind: "conflict-files"; readonly files: readonly string[] }
  | AgentProgressFrame
  | {
      readonly kind: "result";
      readonly status: "pushed";
      readonly newSha: string;
      readonly pushedCommits: number;
      readonly branch: string;
    }
  | { readonly kind: "result"; readonly status: "remote-changed"; readonly branch: string }
  | { readonly kind: "result"; readonly status: "failed"; readonly message: string };

type PushR = DbService | GitHubEtagCache | SettingsService;

interface PushDeps {
  readonly resolve: (
    prId: string,
    userId: string,
  ) => Effect.Effect<PrContextBasic, PrContextError, DbService>;
  readonly claim: (
    prId: string,
    holder: "push",
  ) => Effect.Effect<WorkspaceClaim, WorkspaceBusyError, Scope.Scope>;
  readonly pushLock: Context.Service.Shape<typeof BranchPushLock>;
  readonly agentBranchOf: (ctx: PrContextBasic) => AgentBranch | null;
  readonly baselineOf: (
    ctx: PrContextBasic,
    branch: AgentBranch,
  ) => Effect.Effect<string | null, DbError>;
  readonly sessionOf: (pr: {
    readonly id: string;
    readonly headSha: string | null;
  }) => Effect.Effect<ChatSessionRow | null, DbError>;
  readonly chatSessions: Context.Service.Shape<typeof ChatSessionService>;
  readonly ai: Context.Service.Shape<typeof AiService>;
  readonly headRefresh: ReturnType<typeof makePrHeadRefresh>;
}

const gitStep = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (err) =>
      new GitOperationError({
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      }),
  });

const requireOk = (attempt: { readonly ok: boolean; readonly stderr: string }, what: string) =>
  attempt.ok
    ? Effect.void
    : Effect.fail(new GitOperationError({ message: `${what}: ${attempt.stderr || "git failed"}` }));

export function makeAgentPush(deps: PushDeps) {
  /** Hold the workspace and the target branch, then check there's something clean to push. */
  const begin = (params: { readonly prId: string; readonly userId: string }, target?: string) =>
    Effect.gen(function* () {
      const claim = yield* deps.claim(params.prId, "push");
      const ctx = yield* deps.resolve(params.prId, params.userId);
      const { pr, repo, token } = ctx;
      yield* deps.pushLock.hold(
        [{ repoId: repo.id, branch: target ?? pr.sourceBranch }],
        "chat-push",
      );

      if (!pr.headSha) {
        return yield* Effect.fail(
          new GitOperationError({
            message: "PR has no head SHA recorded yet — wait for the next sync",
          }),
        );
      }
      const branch = deps.agentBranchOf(ctx);
      if (!branch) return yield* Effect.fail(new NoChatSessionError({ prId: pr.id }));
      yield* Effect.try({
        try: () => {
          assertNotFlagLike(branch.branchName, "branchName");
          assertNotFlagLike(pr.sourceBranch, "sourceBranch");
        },
        catch: (err) => new GitOperationError({ message: String(err) }),
      });

      const checkClean = gitStep(() => workingTreeIsClean(branch.worktreePath));
      let clean = yield* checkClean;
      if (!clean.clean && (yield* Effect.promise(() => healAbandonedMerge(branch)))) {
        clean = yield* checkClean;
      }
      if (!clean.clean) {
        return yield* Effect.fail(
          new DirtyWorktreeError({ message: `worktree has uncommitted changes:\n${clean.output}` }),
        );
      }

      const baseSha = yield* deps.baselineOf(ctx, branch);
      const ahead = baseSha ? yield* Effect.promise(() => countProposed(branch, baseSha)) : 0;
      if (!baseSha || ahead <= 0) return yield* Effect.fail(new NoChangesError({ prId: pr.id }));

      return {
        claim,
        ctx,
        branch,
        baseSha,
        ahead,
        session: yield* deps.sessionOf(pr),
        url: authedRemoteUrl({ host: repo.githubHost, fullName: repo.fullName, token }),
      };
    });

  type Begun = Effect.Success<ReturnType<typeof begin>>;

  /** Read the source tip (the lease) and fetch it. */
  const fetchSource = (run: Begun) =>
    Effect.gen(function* () {
      const { branch, ctx, url } = run;
      const source = ctx.pr.sourceBranch;
      const leaseSha = yield* gitStep(() => lsRemoteHead(branch.worktreePath, url, source));
      const fetched = yield* Effect.promise(() =>
        fetch(branch.worktreePath, url, [`+refs/heads/${source}:refs/remotes/origin/${source}`]),
      );
      yield* requireOk(fetched, `failed to fetch ${source}`);
      return leaseSha;
    });

  /** Record why a push failed, put the worktree back on the agent branch, and say what it means. */
  const pushFailed = (run: Begun, stderr: string) =>
    Effect.gen(function* () {
      logError(
        "chat-push",
        `push to ${run.ctx.pr.sourceBranch} failed (pr=${run.ctx.pr.id}): ${stderr}`,
      );
      yield* Effect.promise(() => restoreAgentBranch(run.branch));
      switch (classifyPushFailure(stderr)) {
        case "remote-moved":
          return { status: "remote-changed" as const, branch: run.ctx.pr.sourceBranch };
        case "auth":
          return yield* Effect.fail(
            new GitHubAuthError({
              message: "git push rejected: token expired or insufficient scope",
            }),
          );
        case "rejected":
          return yield* Effect.fail(
            new PushRejectedError({ message: describePushRejection(stderr) }),
          );
      }
    });

  /**
   * Push the detached HEAD to the source branch, then bring the agent branch
   * along: moved to the pushed tip, or (`replay`) rebuilt on it so commits that
   * weren't picked stay proposed.
   */
  const pushHead = (
    run: Begun,
    leaseSha: string | null,
    pushedCommits: number,
    replay?: { readonly oldTip: string },
  ) =>
    Effect.gen(function* () {
      const { branch, ctx } = run;
      const pushed = yield* Effect.promise(() =>
        pushLeased(branch.worktreePath, run.url, [
          { branch: ctx.pr.sourceBranch, from: leaseSha, to: "HEAD" },
        ]),
      );
      if (!pushed.ok) return yield* pushFailed(run, pushed.stderr);

      const newTip = yield* Effect.promise(() => resolveRef(branch.worktreePath, "HEAD"));
      if (!newTip)
        return yield* Effect.fail(
          new GitOperationError({ message: "Couldn't read the pushed tip" }),
        );

      // The push happened either way; a branch left behind only shows stale proposals.
      if (replay) {
        const moved = yield* Effect.promise(() =>
          replayAgentCommits(branch, {
            onto: newTip,
            upstream: run.baseSha,
            oldTip: replay.oldTip,
          }),
        );
        if (!moved.ok) {
          logError(
            "chat-push",
            `rebuilding ${branch.branchName} on the pushed tip failed; left it where it was: ${moved.message}`,
          );
        }
      } else if (!(yield* Effect.promise(() => moveAgentBranch(branch, newTip)))) {
        logError("chat-push", `moving ${branch.branchName} to the pushed tip ${newTip} failed`);
      }

      yield* deps.headRefresh.recordPushedHead({
        prId: ctx.pr.id,
        repoFullName: ctx.repo.fullName,
        prExternalId: ctx.pr.externalId,
        token: ctx.token,
        newTip,
      });
      if (run.session) {
        yield* deps.chatSessions.updatePrHeadSha({
          chatSessionId: run.session.id,
          prHeadSha: newTip,
        });
      }
      yield* deps.headRefresh.broadcastPrsUpdated(ctx.pr.id);
      return {
        status: "pushed" as const,
        newSha: newTip,
        pushedCommits,
        branch: ctx.pr.sourceBranch,
      };
    });

  /** Detach onto the fetched source tip and merge the agent branch into it. */
  const mergeOntoSource = (run: Begun, abortOnConflict: boolean) =>
    Effect.gen(function* () {
      const { branch, ctx } = run;
      const source = ctx.pr.sourceBranch;
      const detached = yield* Effect.promise(() =>
        checkoutDetached(branch.worktreePath, `refs/remotes/origin/${source}`),
      );
      yield* requireOk(detached, "git checkout failed");
      const merged = yield* Effect.promise(() =>
        merge(branch.worktreePath, branch.branchName, {
          message: `Merge branch '${branch.branchName}' into ${source}`,
        }),
      );
      if (merged.ok) return { status: "merged" as const };
      const inProgress = yield* Effect.promise(() => isMergeInProgress(branch.worktreePath));
      const files = inProgress ? yield* gitStep(() => unmergedPaths(branch.worktreePath)) : [];
      // No conflict, yet no merge commit: git or the user's signer refused it.
      if (files.length === 0) {
        if (inProgress) yield* Effect.promise(() => abortMerge(branch.worktreePath));
        yield* Effect.promise(() => restoreAgentBranch(branch));
        return yield* Effect.fail(
          new GitOperationError({
            message: `git merge failed: ${merged.stderr || "unknown error"}`,
          }),
        );
      }
      if (abortOnConflict) {
        yield* Effect.promise(() => abortMerge(branch.worktreePath));
        yield* Effect.promise(() => restoreAgentBranch(branch));
      }
      return { status: "conflict" as const, files };
    });

  const pushToNewBranch = (
    params: { readonly prId: string; readonly userId: string },
    newBranchName: string,
    force: boolean,
  ) =>
    Effect.gen(function* () {
      const name = newBranchName.trim();
      if (name.length === 0 || /\s/.test(name) || name.includes("..") || name.startsWith("-")) {
        return yield* Effect.fail(
          new InvalidBranchNameError({
            message: "newBranchName is empty or contains invalid characters",
          }),
        );
      }
      const run = yield* begin(params, name);
      const { branch, url } = run;
      if (!force && (yield* gitStep(() => lsRemoteHead(branch.worktreePath, url, name)))) {
        return { status: "ref-exists" as const, branch: name };
      }
      const pushed = yield* Effect.promise(() =>
        pushNewBranch(branch.worktreePath, url, branch.branchName, name, force),
      );
      if (!pushed.ok) {
        logError("chat-push", `push to new branch ${name} failed: ${pushed.stderr}`);
        const kind = classifyPushFailure(pushed.stderr);
        if (kind === "auth") {
          return yield* Effect.fail(
            new GitHubAuthError({
              message: "git push rejected: token expired or insufficient scope",
            }),
          );
        }
        // The one rejection this path recovers from: the UI offers to overwrite.
        if (
          !force &&
          (pushed.stderr.toLowerCase().includes("already exists") || kind === "remote-moved")
        ) {
          return { status: "ref-exists" as const, branch: name };
        }
        return yield* Effect.fail(
          new PushRejectedError({ message: describePushRejection(pushed.stderr) }),
        );
      }
      const newTip = yield* Effect.promise(() =>
        resolveRef(branch.worktreePath, branch.branchName),
      );
      if (!newTip)
        return yield* Effect.fail(
          new GitOperationError({ message: "Couldn't read the pushed tip" }),
        );
      yield* deps.headRefresh.broadcastPrsUpdated(run.ctx.pr.id);
      return { status: "pushed" as const, newSha: newTip, pushedCommits: run.ahead, branch: name };
    });

  const mergeAndPush = (params: {
    readonly prId: string;
    readonly userId: string;
    readonly newBranchName?: string;
    readonly force?: boolean;
  }): Effect.Effect<AttemptPushResult, ChatPushError, PushR> =>
    Effect.scoped<AttemptPushResult, ChatPushError, PushR | Scope.Scope>(
      params.newBranchName !== undefined
        ? pushToNewBranch(params, params.newBranchName, params.force ?? false)
        : Effect.gen(function* () {
            const run = yield* begin(params);
            const leaseSha = yield* fetchSource(run);
            const merged = yield* mergeOntoSource(run, true);
            if (merged.status === "conflict") {
              return {
                status: "conflict" as const,
                files: merged.files,
                branch: run.ctx.pr.sourceBranch,
              };
            }
            return yield* pushHead(run, leaseSha, run.ahead);
          }),
    );

  const resultFrame = (pushed: AttemptPushResult): ResolvePushFrame =>
    pushed.status === "pushed"
      ? { kind: "result", ...pushed }
      : pushed.status === "remote-changed"
        ? { kind: "result", status: "remote-changed", branch: pushed.branch }
        : { kind: "result", status: "failed", message: "Unexpected push outcome." };

  const resolveAndPush = (params: {
    readonly prId: string;
    readonly userId: string;
  }): Effect.Effect<ReadableStream<ResolvePushFrame>, ChatPushError, PushR> =>
    Effect.gen(function* () {
      // The run outlives the request; the stream closes the scope.
      const scope = yield* Scope.make();
      const release = Scope.close(scope, Exit.void);
      const setup = Effect.gen(function* () {
        const run = yield* begin(params);
        const leaseSha = yield* fetchSource(run);
        const merged = yield* mergeOntoSource(run, false);
        return { run, leaseSha, merged };
      }).pipe(
        Scope.provide(scope),
        Effect.onError(() => release),
      );
      const { run, leaseSha, merged } = yield* setup;
      const { branch, ctx } = run;

      const backOut = Effect.promise(async () => {
        await abortMerge(branch.worktreePath);
        await restoreAgentBranch(branch);
      });

      if (merged.status === "merged") {
        const pushed = yield* pushHead(run, leaseSha, run.ahead).pipe(Effect.ensuring(release));
        return new ReadableStream<ResolvePushFrame>({
          start(controller) {
            controller.enqueue(resultFrame(pushed));
            controller.close();
          },
        });
      }

      const agentStream = yield* deps.ai
        .resolveMergeConflict({
          cwd: branch.worktreePath,
          task: {
            kind: "push-merge",
            agentBranch: branch.branchName,
            sourceBranch: ctx.pr.sourceBranch,
          },
          conflictFiles: merged.files,
        })
        .pipe(Effect.onError(() => backOut.pipe(Effect.andThen(release))));

      const queue = yield* Queue.unbounded<ResolvePushFrame>();
      const offer = (frame: ResolvePushFrame) =>
        Effect.sync(() => run.claim.touch()).pipe(Effect.andThen(Queue.offer(queue, frame)));
      const fail = (message: string) =>
        backOut.pipe(Effect.andThen(offer({ kind: "result", status: "failed", message })));

      yield* Effect.forkDetach(
        Effect.gen(function* () {
          yield* offer({
            kind: "status",
            message: `Re-running merge into ${ctx.pr.sourceBranch}...`,
          });
          yield* offer({ kind: "conflict-files", files: merged.files });
          yield* offer({
            kind: "status",
            message: "Asking the agent to resolve conflicts and run git merge --continue.",
          });
          yield* pumpAgentFrames(agentStream, offer);

          if (yield* Effect.promise(() => isMergeInProgress(branch.worktreePath))) {
            return yield* fail("Agent finished but the merge is still in conflict. Aborting.");
          }
          const clean = yield* Effect.promise(() =>
            workingTreeIsClean(branch.worktreePath).catch((err) => ({
              clean: false,
              output: String(err),
            })),
          );
          if (!clean.clean) {
            return yield* fail(
              `Worktree has uncommitted changes after agent run:\n${clean.output}`,
            );
          }
          yield* offer({ kind: "status", message: "Merge resolved. Pushing..." });
          yield* offer(resultFrame(yield* pushHead(run, leaseSha, run.ahead)));
        }).pipe(
          Effect.catch((err) => fail(err instanceof Error ? err.message : String(err))),
          Effect.ensuring(
            Queue.shutdown(queue).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(release),
            ),
          ),
        ),
      );
      return queueToStream(queue);
    });

  /** Push the chosen proposed commits, oldest first, onto the source branch; the rest stay proposed. */
  const cherryPickAndPush = (params: {
    readonly prId: string;
    readonly userId: string;
    readonly shas: readonly string[];
  }): Effect.Effect<AttemptPushResult, ChatPushError, PushR> =>
    Effect.scoped(
      Effect.gen(function* () {
        if (params.shas.length === 0)
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));
        const invalid = params.shas.find((sha) => !isValidSha(sha));
        if (invalid)
          return yield* Effect.fail(new GitOperationError({ message: `Invalid SHA: ${invalid}` }));

        const run = yield* begin(params);
        const { branch } = run;
        const requested = new Set<string>();
        for (const sha of params.shas) {
          const full = yield* Effect.promise(() => resolveRef(branch.worktreePath, sha));
          if (!full)
            return yield* Effect.fail(
              new GitOperationError({ message: `Cannot resolve SHA: ${sha}` }),
            );
          requested.add(full);
        }
        const all = yield* gitStep(() => proposedShas(branch, run.baseSha));
        const picked = all.filter((sha) => requested.has(sha));
        if (picked.length === 0)
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));

        const leaseSha = yield* fetchSource(run);
        const oldTip = yield* Effect.promise(() =>
          resolveRef(branch.worktreePath, branch.branchName),
        );
        if (!oldTip)
          return yield* Effect.fail(
            new GitOperationError({ message: "Couldn't read the agent branch" }),
          );
        const detached = yield* Effect.promise(() =>
          checkoutDetached(branch.worktreePath, `refs/remotes/origin/${run.ctx.pr.sourceBranch}`),
        );
        yield* requireOk(detached, "git checkout failed");
        for (const sha of picked) {
          const result = yield* Effect.promise(() => cherryPick(branch.worktreePath, sha));
          if (!result.ok) {
            yield* Effect.promise(() => abortCherryPick(branch.worktreePath));
            yield* Effect.promise(() => restoreAgentBranch(branch));
            return yield* Effect.fail(
              new GitOperationError({
                message: `Cherry-pick failed on ${sha.slice(0, 8)}: ${result.stderr}`,
              }),
            );
          }
        }
        return yield* pushHead(run, leaseSha, picked.length, { oldTip });
      }),
    );

  return { mergeAndPush, resolveAndPush, cherryPickAndPush };
}
