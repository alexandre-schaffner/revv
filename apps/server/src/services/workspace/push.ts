// Shipping the agent's commits: turning the proposed commits on the agent
// branch into commits on the PR's source branch, or on a new branch.
//
// Every flow holds the PR's workspace claim and the source branch's push lock
// for its whole run; both are taken before any git work, so an overlapping
// flow is refused up front.

import { isValidBranchName, type ResolvePushFrame } from "@revv/shared";
import { type Context, Effect, Exit, Scope } from "effect";
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
  ValidationError,
  type WorkspaceBusyError,
} from "../../domain/errors";
import { logError } from "../../logger";
import type { AiService } from "../Ai";
import { runConflictResolve } from "../conflict-resolve-run";
import type { BranchPushLock } from "../git/branch-push-lock";
import {
  abortCherryPick,
  abortMerge,
  assertNotFlagLike,
  checkoutDetached,
  cherryPick,
  fetch,
  gitTry,
  isMergeInProgress,
  merge,
  resolveRef,
  unmergedPaths,
  workingTreeIsClean,
} from "../git/ops";
import { scratchRef } from "../git/pr-refs";
import { lsRemoteHead, pushLeased, pushNewBranch, pushOutcome } from "../git/push";
import { authedRemoteUrl } from "../git/remote";
import type { PrContextBasic, PrContextError } from "../PrContext";
import type { PrMirror } from "../PrMirror";
import {
  countProposed,
  healAbandonedMerge,
  moveAgentBranch,
  proposedShas,
  replayAgentCommits,
  restoreAgentBranch,
} from "./agent-branch";
import type { AgentBranch } from "./agent-worktrees";
import type { WorkspaceClaim } from "./claims";

export type ChatPushError =
  | WorkspaceBusyError
  | ConcurrentPushError
  | DirtyWorktreeError
  | NoChangesError
  | NoChatSessionError
  | PushRejectedError
  | GitOperationError
  | InvalidBranchNameError
  | ValidationError
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

interface PushDeps {
  readonly resolve: (prId: string) => Effect.Effect<PrContextBasic, PrContextError>;
  readonly claim: (
    prId: string,
    holder: "push",
  ) => Effect.Effect<WorkspaceClaim, WorkspaceBusyError, Scope.Scope>;
  readonly pushLock: Context.Service.Shape<typeof BranchPushLock>;
  readonly agentBranchOf: (ctx: PrContextBasic) => AgentBranch | null;
  readonly baselineOf: (
    ctx: PrContextBasic,
    branch: AgentBranch,
  ) => Effect.Effect<string | null, DbError | GitOperationError>;
  readonly moveSession: (prId: string, newHeadSha: string) => Effect.Effect<void, DbError>;
  readonly validShas: (shas: readonly string[]) => Effect.Effect<void, ValidationError>;
  readonly resolveCommit: (
    branch: AgentBranch,
    sha: string,
  ) => Effect.Effect<string, NotFoundError | GitOperationError>;
  readonly ai: Context.Service.Shape<typeof AiService>;
  readonly mirror: Context.Service.Shape<typeof PrMirror>;
}

const requireOk = (attempt: { readonly ok: boolean; readonly stderr: string }, what: string) =>
  attempt.ok
    ? Effect.void
    : Effect.fail(new GitOperationError({ message: `${what}: ${attempt.stderr || "git failed"}` }));

export function makeAgentPush(deps: PushDeps) {
  const begin = (prId: string, target?: string) =>
    Effect.gen(function* () {
      const claim = yield* deps.claim(prId, "push");
      const resolved = yield* deps.resolve(prId);
      const ctx = {
        ...resolved,
        pr: { ...resolved.pr, headSha: yield* deps.mirror.headOf(resolved) },
      };
      const { pr, repo } = ctx;
      const token = ctx.client.token;
      yield* deps.pushLock.hold(
        [{ repoId: repo.id, branch: target ?? pr.sourceBranch }],
        "chat-push",
      );

      const branch = deps.agentBranchOf(ctx);
      if (!branch) return yield* Effect.fail(new NoChatSessionError({ prId: pr.id }));
      yield* Effect.try({
        try: () => {
          assertNotFlagLike(branch.branchName, "branchName");
          assertNotFlagLike(pr.sourceBranch, "sourceBranch");
        },
        catch: (err) => new ValidationError({ message: String(err) }),
      });

      const checkClean = gitTry(() => workingTreeIsClean(branch.worktreePath));
      let clean = yield* checkClean;
      if (!clean.clean && (yield* gitTry(() => healAbandonedMerge(branch)))) {
        clean = yield* checkClean;
      }
      if (!clean.clean) {
        return yield* Effect.fail(
          new DirtyWorktreeError({ message: `worktree has uncommitted changes:\n${clean.output}` }),
        );
      }

      const baseSha = yield* deps.baselineOf(ctx, branch);
      const ahead = baseSha ? yield* gitTry(() => countProposed(branch, baseSha)) : 0;
      if (!baseSha || ahead <= 0) return yield* Effect.fail(new NoChangesError({ prId: pr.id }));

      return {
        claim,
        ctx,
        branch,
        baseSha,
        ahead,
        url: authedRemoteUrl({ host: repo.githubHost, fullName: repo.fullName, token }),
      };
    });

  type Begun = Effect.Success<ReturnType<typeof begin>>;

  /**
   * The source branch's tip, fetched into Revv's own ref: an adopted clone's
   * `refs/remotes/origin/*` is the user's. Returns the lease and the ref.
   */
  const fetchSource = (run: Begun) =>
    Effect.gen(function* () {
      const { branch, ctx, url } = run;
      const source = ctx.pr.sourceBranch;
      const ref = scratchRef("chat-push", ctx.pr.externalId, "source");
      const leaseSha = yield* gitTry(() => lsRemoteHead(branch.worktreePath, url, source));
      const fetched = yield* gitTry(() =>
        fetch(branch.worktreePath, url, [`+refs/heads/${source}:${ref}`]),
      );
      yield* requireOk(fetched, `failed to fetch ${source}`);
      return { leaseSha, ref };
    });

  const pushFailed = (run: Begun, stderr: string) =>
    Effect.gen(function* () {
      logError(
        "chat-push",
        `push to ${run.ctx.pr.sourceBranch} failed (pr=${run.ctx.pr.id}): ${stderr}`,
      );
      yield* Effect.promise(() => restoreAgentBranch(run.branch));
      const outcome = pushOutcome({ ok: false, stderr });
      switch (outcome.kind) {
        case "moved":
        case "pushed":
          return { status: "remote-changed" as const, branch: run.ctx.pr.sourceBranch };
        case "auth":
          return yield* Effect.fail(new GitHubAuthError({ message: outcome.message }));
        case "rejected":
          return yield* Effect.fail(new PushRejectedError({ message: outcome.message }));
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

      yield* deps.mirror.recordPushes(ctx, [{ prNumber: ctx.pr.externalId, newTip }]);
      yield* deps.moveSession(ctx.pr.id, newTip);
      return {
        status: "pushed" as const,
        newSha: newTip,
        pushedCommits,
        branch: ctx.pr.sourceBranch,
      };
    });

  const mergeOntoSource = (run: Begun, sourceRef: string, abortOnConflict: boolean) =>
    Effect.gen(function* () {
      const { branch, ctx } = run;
      const source = ctx.pr.sourceBranch;
      const detached = yield* Effect.promise(() =>
        checkoutDetached(branch.worktreePath, sourceRef),
      );
      yield* requireOk(detached, "git checkout failed");
      const merged = yield* Effect.promise(() =>
        merge(branch.worktreePath, branch.branchName, {
          message: `Merge branch '${branch.branchName}' into ${source}`,
        }),
      );
      if (merged.ok) return { status: "merged" as const };
      const inProgress = yield* Effect.promise(() => isMergeInProgress(branch.worktreePath));
      const files = inProgress ? yield* gitTry(() => unmergedPaths(branch.worktreePath)) : [];
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

  const pushToNewBranch = (prId: string, newBranchName: string, force: boolean) =>
    Effect.gen(function* () {
      const name = newBranchName.trim();
      if (!isValidBranchName(name)) {
        return yield* Effect.fail(
          new InvalidBranchNameError({
            message: "newBranchName is empty or contains invalid characters",
          }),
        );
      }
      const run = yield* begin(prId, name);
      const { branch, url } = run;
      if (!force && (yield* gitTry(() => lsRemoteHead(branch.worktreePath, url, name)))) {
        return { status: "ref-exists" as const, branch: name };
      }
      const pushed = yield* Effect.promise(() =>
        pushNewBranch(branch.worktreePath, url, branch.branchName, name, force),
      );
      const outcome = pushOutcome(pushed);
      if (outcome.kind !== "pushed") {
        logError("chat-push", `push to new branch ${name} failed: ${pushed.stderr}`);
        switch (outcome.kind) {
          case "auth":
            return yield* Effect.fail(new GitHubAuthError({ message: outcome.message }));
          // The one refusal this path recovers from: the UI offers to overwrite.
          case "moved":
            if (!force) return { status: "ref-exists" as const, branch: name };
            return yield* Effect.fail(new PushRejectedError({ message: pushed.stderr }));
          case "rejected":
            return yield* Effect.fail(new PushRejectedError({ message: outcome.message }));
        }
      }
      const newTip = yield* Effect.promise(() =>
        resolveRef(branch.worktreePath, branch.branchName),
      );
      if (!newTip)
        return yield* Effect.fail(
          new GitOperationError({ message: "Couldn't read the pushed tip" }),
        );
      yield* deps.mirror.announce([run.ctx.accountId]);
      return { status: "pushed" as const, newSha: newTip, pushedCommits: run.ahead, branch: name };
    });

  const mergeAndPush = (params: {
    readonly prId: string;
    readonly newBranchName?: string;
    readonly force?: boolean;
  }): Effect.Effect<AttemptPushResult, ChatPushError> =>
    Effect.scoped<AttemptPushResult, ChatPushError, Scope.Scope>(
      params.newBranchName !== undefined
        ? pushToNewBranch(params.prId, params.newBranchName, params.force ?? false)
        : Effect.gen(function* () {
            const run = yield* begin(params.prId);
            const { leaseSha, ref } = yield* fetchSource(run);
            const merged = yield* mergeOntoSource(run, ref, true);
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

  const resolveAndPush = (
    prId: string,
  ): Effect.Effect<ReadableStream<ResolvePushFrame>, ChatPushError> =>
    Effect.gen(function* () {
      // The run outlives the request; the stream closes the scope.
      const scope = yield* Scope.make();
      const release = Scope.close(scope, Exit.void);
      const setup = Effect.gen(function* () {
        const run = yield* begin(prId);
        const { leaseSha, ref } = yield* fetchSource(run);
        const merged = yield* mergeOntoSource(run, ref, false);
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

      return yield* runConflictResolve<ResolvePushFrame>({
        opening: [
          { kind: "status", message: `Re-running merge into ${ctx.pr.sourceBranch}...` },
          { kind: "conflict-files", files: merged.files },
          {
            kind: "status",
            message: "Asking the agent to resolve conflicts and run git merge --continue.",
          },
        ],
        agent: Effect.succeed(agentStream),
        finish: (offer) =>
          Effect.gen(function* () {
            if (yield* Effect.promise(() => isMergeInProgress(branch.worktreePath))) {
              return yield* Effect.fail(
                new Error("Agent finished but the merge is still in conflict. Aborting."),
              );
            }
            const clean = yield* gitTry(() => workingTreeIsClean(branch.worktreePath));
            if (!clean.clean) {
              return yield* Effect.fail(
                new Error(`Worktree has uncommitted changes after agent run:\n${clean.output}`),
              );
            }
            yield* offer({ kind: "status", message: "Merge resolved. Pushing..." });
            return resultFrame(yield* pushHead(run, leaseSha, run.ahead));
          }),
        failed: (message) =>
          backOut.pipe(Effect.as<ResolvePushFrame>({ kind: "result", status: "failed", message })),
        onProgress: run.claim.touch,
        cleanup: release,
      });
    });

  /** Push the chosen proposed commits, oldest first, onto the source branch; the rest stay proposed. */
  const cherryPickAndPush = (params: {
    readonly prId: string;
    readonly shas: readonly string[];
  }): Effect.Effect<AttemptPushResult, ChatPushError> =>
    Effect.scoped(
      Effect.gen(function* () {
        if (params.shas.length === 0)
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));
        yield* deps.validShas(params.shas);

        const run = yield* begin(params.prId);
        const { branch } = run;
        const requested = new Set<string>();
        for (const sha of params.shas) requested.add(yield* deps.resolveCommit(branch, sha));
        const all = yield* gitTry(() => proposedShas(branch, run.baseSha));
        const picked = all.filter((sha) => requested.has(sha));
        if (picked.length === 0)
          return yield* Effect.fail(new NoChangesError({ prId: params.prId }));

        const { leaseSha, ref } = yield* fetchSource(run);
        const oldTip = yield* Effect.promise(() =>
          resolveRef(branch.worktreePath, branch.branchName),
        );
        if (!oldTip)
          return yield* Effect.fail(
            new GitOperationError({ message: "Couldn't read the agent branch" }),
          );
        const detached = yield* Effect.promise(() => checkoutDetached(branch.worktreePath, ref));
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
