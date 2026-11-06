// ── Proposed-changes sub-router ────────────────────────────────────────────
//
// Elysia sub-router for all /api/chat/:prId/proposed-changes/* endpoints.
// Composed into the main chatRoute via `.use()`.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { InvalidBranchNameError, ValidationError } from "../domain/errors";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import { ChatChangesPushService } from "../services/ChatChangesPush";
import { ChatSessionService } from "../services/ChatSession";
import { PROPOSED_COMMIT_RANGE_FLAGS } from "../services/GitOps";
import { PrContextService } from "../services/PrContext";
import { RepoCloneService } from "../services/RepoClone";
import { SettingsService } from "../services/Settings";
import {
  gitShowSafe,
  gitStdout,
  gitStdoutBestEffort,
  listProposedCommits,
  type ProposedCommit,
} from "./chat-helpers";
import { errorResponse, runRoute, withAuth } from "./middleware";
import { ownedBy } from "./ownership";
import { pipeToSse, runStream } from "./sse";

export const chatProposedChangesRoutes = new Elysia()
  .use(withAuth)
  .onBeforeHandle(ownedBy({ prId: "pull request" }))
  .get(
    "/api/chat/:prId/proposed-changes",
    async (ctx) => {
      return runRoute(async () => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();

            return yield* chatSessions.findLatestForPrWithBase(pr.id, agent);
          }),
        );

        if (!result) {
          return { branchName: null, baseSha: null, commits: [] };
        }

        // One resolved baseline, shared with the push/rebuild/discard paths —
        // the commits listed here are exactly the ones those paths act on.
        const { row, baseSha } = result;

        const commits = await listProposedCommits(row.worktreePath, baseSha).catch((err) => {
          logError(
            "chat",
            "listProposedCommits failed:",
            err instanceof Error ? err.message : String(err),
          );
          return [] as ProposedCommit[];
        });

        return {
          branchName: row.branchName,
          baseSha,
          commits,
        };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/diff",
    async (ctx) => {
      return runRoute(async () => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();

            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!result) {
          ctx.set.status = 404;
          return { error: "No active chat session for this PR" };
        }

        // Validate the SHA shape — defense in depth against arg injection.
        if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
          return errorResponse(new ValidationError({ message: "Invalid commit SHA" }));
        }

        const diff = await gitStdout(
          ["show", "--patch", "--pretty=format:", ctx.params.sha],
          result.worktreePath,
          15_000,
        );

        return new Response(diff, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      });
    },
    {
      params: t.Object({ prId: t.String(), sha: t.String() }),
    },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/files",
    async (ctx) => {
      return runRoute(async () => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();

            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!result) {
          ctx.set.status = 404;
          return { error: "No active chat session for this PR" };
        }

        if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
          return errorResponse(new ValidationError({ message: "Invalid commit SHA" }));
        }

        // `-z -M --name-status` outputs one record per changed file as
        // `<status>\0<path>` (or `R<sim>\0<oldPath>\0<newPath>` for renames),
        // records concatenated with no separator.
        const raw = await gitStdout(
          ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "-M", ctx.params.sha],
          result.worktreePath,
          15_000,
        );

        const tokens = raw.split("\0").filter((t) => t.length > 0);
        const fileTasks: Array<
          Promise<{
            path: string;
            oldPath: string | null;
            oldContent: string | null;
            newContent: string | null;
            status: string;
            binary: boolean;
          }>
        > = [];

        for (let i = 0; i < tokens.length; ) {
          const status = tokens[i++];
          if (status == null) break;
          const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
          const oldPath = isRenameOrCopy ? (tokens[i++] ?? null) : null;
          const path = tokens[i++];
          if (path == null) break;

          const isAdd = status === "A";
          const isDel = status === "D";
          const oldRef = isAdd ? null : (oldPath ?? path);
          const newRef = isDel ? null : path;

          fileTasks.push(
            (async () => {
              const [oldRaw, newRaw] = await Promise.all([
                oldRef
                  ? gitShowSafe(`${ctx.params.sha}^`, oldRef, result.worktreePath)
                  : Promise.resolve(null),
                newRef
                  ? gitShowSafe(ctx.params.sha, newRef, result.worktreePath)
                  : Promise.resolve(null),
              ]);
              // Cheap binary heuristic: a null byte anywhere in either
              // version. Good enough for the typical mix of text + images
              // the agent produces; binary files just render as a
              // no-content placeholder on the client.
              const binary = !!(oldRaw?.includes("\0") || newRaw?.includes("\0"));
              return {
                path,
                oldPath,
                status,
                oldContent: binary ? null : oldRaw,
                newContent: binary ? null : newRaw,
                binary,
              };
            })(),
          );
        }

        const files = await Promise.all(fileTasks);
        return { files };
      });
    },
    {
      params: t.Object({ prId: t.String(), sha: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/merge-and-push",
    async (ctx) => {
      return runRoute(async () => {
        const body = (ctx.body ?? {}) as {
          newBranchName?: unknown;
          force?: unknown;
        };
        let newBranchName: string | undefined;
        if (body.newBranchName !== undefined) {
          if (typeof body.newBranchName !== "string") {
            return errorResponse(
              new InvalidBranchNameError({ message: "newBranchName must be a string" }),
            );
          }
          const trimmed = body.newBranchName.trim();
          if (
            trimmed.length === 0 ||
            /\s/.test(trimmed) ||
            trimmed.startsWith("-") ||
            trimmed.includes("..")
          ) {
            return errorResponse(
              new InvalidBranchNameError({
                message: "newBranchName is empty or contains invalid characters",
              }),
            );
          }
          newBranchName = trimmed;
        }
        const force = typeof body.force === "boolean" ? body.force : undefined;

        const result = await AppRuntime.runPromise(
          Effect.flatMap(ChatChangesPushService, (svc) =>
            svc.attemptMergeAndPush({
              prId: ctx.params.prId,
              userId: ctx.session.user.id,
              ...(newBranchName !== undefined ? { newBranchName } : {}),
              ...(force !== undefined ? { force } : {}),
            }),
          ),
        );
        // Conflict / remote-changed / ref-exists are expected non-error
        // outcomes — surface 409 so the client can branch on the status
        // code in addition to the body.
        if (result.status === "conflict") {
          ctx.set.status = 409;
          return result;
        }
        if (result.status === "remote-changed") {
          ctx.set.status = 409;
          return result;
        }
        if (result.status === "ref-exists") {
          ctx.set.status = 409;
          return result;
        }
        return result;
      });
    },
    {
      params: t.Object({ prId: t.String() }),
      body: t.Optional(
        t.Object({
          newBranchName: t.Optional(t.String()),
          force: t.Optional(t.Boolean()),
        }),
      ),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/resolve-and-push",
    (ctx) =>
      runStream(
        Effect.flatMap(ChatChangesPushService, (svc) =>
          svc.resolveConflictsAndPush({ prId: ctx.params.prId, userId: ctx.session.user.id }),
        ).pipe(Effect.map(pipeToSse)),
      ),
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  // ── Unpushed commit management ───────────────────────────────────────────
  // Three endpoints to handle the WorktreeBlockedByUnpushedCommits scenario:
  //   DELETE …/:sha      — discard a single agent commit via rebase --onto
  //   POST …/rebase-onto — rebase all agent commits onto the new PR head
  //   POST …/advance     — advance the worktree to the new PR head (after
  //                        all commits have been handled)
  .post(
    "/api/chat/:prId/proposed-changes/cherry-pick",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { sha?: unknown };
      if (typeof body.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(body.sha)) {
        return errorResponse(
          new ValidationError({ message: "sha is required and must be a valid commit hash" }),
        );
      }
      const { sha } = body;

      return runRoute(async () => {
        const result = await AppRuntime.runPromise(
          Effect.flatMap(ChatChangesPushService, (svc) =>
            svc.cherryPickAndPush({
              prId: ctx.params.prId,
              userId: ctx.session.user.id,
              sha,
            }),
          ),
        );

        if (result.status === "pushed") {
          return {
            status: "pushed",
            newSha: result.newSha,
            pushedCommits: result.pushedCommits,
            branch: result.branch,
          };
        }
        if (result.status === "remote-changed") {
          ctx.set.status = 409;
          return { status: "remote-changed", branch: result.branch };
        }
        ctx.set.status = 500;
        return { error: "Unexpected cherry-pick result" };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/batch-cherry-pick",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { shas?: unknown };
      if (!Array.isArray(body.shas) || body.shas.length === 0) {
        return errorResponse(
          new ValidationError({ message: "shas must be a non-empty array of commit hashes" }),
        );
      }
      const shas: string[] = [];
      for (const raw of body.shas) {
        if (typeof raw !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw)) {
          return errorResponse(
            new ValidationError({ message: "shas must contain valid commit hashes" }),
          );
        }
        shas.push(raw);
      }

      return runRoute(async () => {
        const result = await AppRuntime.runPromise(
          Effect.flatMap(ChatChangesPushService, (svc) =>
            svc.batchCherryPickAndPush({
              prId: ctx.params.prId,
              userId: ctx.session.user.id,
              shas,
            }),
          ),
        );

        if (result.status === "pushed") {
          return {
            status: "pushed",
            newSha: result.newSha,
            pushedCommits: result.pushedCommits,
            branch: result.branch,
          };
        }
        if (result.status === "remote-changed") {
          ctx.set.status = 409;
          return { status: "remote-changed", branch: result.branch };
        }
        ctx.set.status = 500;
        return { error: "Unexpected cherry-pick result" };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .delete(
    "/api/chat/:prId/proposed-changes/:sha",
    async (ctx) => {
      // Validate SHA before doing anything expensive.
      if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
        return errorResponse(new ValidationError({ message: "Invalid commit SHA" }));
      }

      return runRoute(async () => {
        const row = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();
            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!row) {
          ctx.set.status = 404;
          return { error: "No chat session found for this PR" };
        }

        const { worktreePath } = row;

        // Resolve the full 40-char SHA in case a short SHA was supplied.
        const fullSha = await gitStdout(["rev-parse", ctx.params.sha], worktreePath, 5_000).catch(
          () => null,
        );
        if (!fullSha?.trim()) {
          ctx.set.status = 404;
          return { error: "Commit not found in worktree" };
        }
        const sha = fullSha.trim();

        const parentSha = await gitStdout(["rev-parse", `${sha}^`], worktreePath, 5_000).catch(
          () => null,
        );
        if (!parentSha?.trim()) {
          ctx.set.status = 422;
          return { error: "Cannot discard root commit" };
        }

        // Drop `sha` by rebasing everything above it onto its parent.
        // git rebase --onto <parent> <sha> HEAD
        try {
          await gitStdout(
            ["rebase", "--onto", parentSha.trim(), sha, "HEAD"],
            worktreePath,
            30_000,
          );
        } catch (rebaseErr) {
          await gitStdoutBestEffort(["rebase", "--abort"], worktreePath);
          ctx.set.status = 409;
          return {
            code: "REBASE_CONFLICT",
            message:
              rebaseErr instanceof Error
                ? rebaseErr.message
                : "Rebase conflict — use the agent to resolve",
          };
        }

        return { status: "discarded" };
      });
    },
    {
      params: t.Object({ prId: t.String(), sha: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/batch-discard",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { shas?: unknown };
      if (!Array.isArray(body.shas) || body.shas.length === 0) {
        return errorResponse(
          new ValidationError({ message: "shas must be a non-empty array of commit hashes" }),
        );
      }
      const rawShas: string[] = [];
      for (const raw of body.shas) {
        if (typeof raw !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw)) {
          return errorResponse(
            new ValidationError({ message: "shas must contain valid commit hashes" }),
          );
        }
        rawShas.push(raw);
      }

      return runRoute(async () => {
        const resolved = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();
            return yield* chatSessions.findLatestForPrWithBase(pr.id, agent);
          }),
        );

        if (!resolved) {
          ctx.set.status = 404;
          return { error: "No chat session found for this PR" };
        }

        // Rebuild onto the same baseline the display and push enumerations use.
        // A stale session baseline here is destructive: the rebuild detaches at
        // it and force-moves the branch, rewinding the agent branch to a PR head
        // the PR left behind. See `resolveProposedBaseSha`.
        const { worktreePath, branchName } = resolved.row;
        const baseSha = resolved.baseSha;

        // Resolve full SHAs and build the drop set.
        const dropSet = new Set<string>();
        for (const raw of rawShas) {
          const full = await gitStdout(["rev-parse", raw], worktreePath, 5_000).catch(() => null);
          if (!full?.trim()) {
            ctx.set.status = 404;
            return { error: `Commit not found in worktree: ${raw}` };
          }
          dropSet.add(full.trim());
        }

        // List all proposed commits oldest-first. Must mirror the display /
        // push enumerations (PROPOSED_COMMIT_RANGE_FLAGS): first-parent +
        // no-merges, so a `merge origin/main` in the worktree doesn't pull the
        // entire base history into the rebuild (cherry-picking hundreds of
        // unrelated commits onto the detached PR head).
        const listOut = await gitStdout(
          ["rev-list", "--reverse", ...PROPOSED_COMMIT_RANGE_FLAGS, `${baseSha}..${branchName}`],
          worktreePath,
          10_000,
        ).catch(() => null);
        if (listOut === null) {
          ctx.set.status = 500;
          return { error: "Failed to enumerate proposed commits" };
        }
        const allShas = listOut
          .trim()
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const keepShas = allShas.filter((s) => !dropSet.has(s));
        const matchedDropCount = allShas.length - keepShas.length;
        if (matchedDropCount === 0) {
          ctx.set.status = 404;
          return { error: "None of the supplied SHAs are present in the proposed commits" };
        }

        const oldAgentTip = await gitStdout(["rev-parse", branchName], worktreePath, 5_000).catch(
          () => null,
        );
        if (!oldAgentTip?.trim()) {
          ctx.set.status = 500;
          return { error: "Failed to resolve agent branch tip" };
        }
        const savedAgentTip = oldAgentTip.trim();

        // Rebuild the agent branch by checking out the resolved baseline as a detached
        // HEAD then cherry-picking each keep commit in order. On any failure
        // we abort and restore the branch ref to its prior tip.
        const restoreOnFailure = async (): Promise<void> => {
          await gitStdoutBestEffort(["cherry-pick", "--abort"], worktreePath);
          await gitStdoutBestEffort(["branch", "-f", branchName, savedAgentTip], worktreePath);
          await gitStdoutBestEffort(["checkout", branchName], worktreePath);
        };

        try {
          await gitStdout(["checkout", "--detach", baseSha], worktreePath, 15_000);
        } catch (err) {
          await restoreOnFailure();
          ctx.set.status = 500;
          return {
            error: err instanceof Error ? err.message : "Failed to detach worktree",
          };
        }

        if (keepShas.length > 0) {
          for (const sha of keepShas) {
            try {
              await gitStdout(["cherry-pick", sha], worktreePath, 60_000);
            } catch (cpErr) {
              await restoreOnFailure();
              ctx.set.status = 409;
              return {
                code: "REBASE_CONFLICT",
                message:
                  cpErr instanceof Error
                    ? cpErr.message
                    : "Rebase conflict — use the agent to resolve",
              };
            }
          }
        }

        const newTip = await gitStdout(["rev-parse", "HEAD"], worktreePath, 5_000).catch(
          () => null,
        );
        if (!newTip?.trim()) {
          await restoreOnFailure();
          ctx.set.status = 500;
          return { error: "Failed to resolve new agent tip" };
        }
        try {
          await gitStdout(["branch", "-f", branchName, newTip.trim()], worktreePath, 5_000);
          await gitStdout(["checkout", branchName], worktreePath, 10_000);
        } catch (moveErr) {
          await restoreOnFailure();
          ctx.set.status = 500;
          return {
            error: moveErr instanceof Error ? moveErr.message : "Failed to move agent branch",
          };
        }

        return { status: "discarded", discardedCount: matchedDropCount };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/rebase-onto",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { oldHeadSha?: unknown; newHeadSha?: unknown };
      if (typeof body.oldHeadSha !== "string" || typeof body.newHeadSha !== "string") {
        return errorResponse(
          new ValidationError({ message: "oldHeadSha and newHeadSha are required strings" }),
        );
      }
      const { oldHeadSha, newHeadSha } = body;

      return runRoute(async () => {
        const row = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.forPr(ctx.params.prId);
            const agent = yield* settingsService.resolveAgent();
            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!row) {
          ctx.set.status = 404;
          return { error: "No chat session found for this PR" };
        }

        const { worktreePath } = row;

        // Ensure newHeadSha is present in the local object store.
        await gitStdoutBestEffort(["fetch", "origin", newHeadSha], worktreePath);

        // Rebase agent commits onto the new PR head.
        // git rebase --onto <newHeadSha> <oldHeadSha> HEAD
        try {
          await gitStdout(
            ["rebase", "--onto", newHeadSha, oldHeadSha, "HEAD"],
            worktreePath,
            60_000,
          );
        } catch (rebaseErr) {
          await gitStdoutBestEffort(["rebase", "--abort"], worktreePath);
          ctx.set.status = 409;
          return {
            code: "REBASE_CONFLICT",
            message:
              rebaseErr instanceof Error
                ? rebaseErr.message
                : "Rebase conflict — use the agent to resolve",
          };
        }

        return { status: "rebased" };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/advance",
    async (ctx) => {
      const body = (ctx.body ?? {}) as { newHeadSha?: unknown };
      if (typeof body.newHeadSha !== "string") {
        return errorResponse(new ValidationError({ message: "newHeadSha is required" }));
      }
      const { newHeadSha } = body;

      return runRoute(async () => {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const repoClone = yield* RepoCloneService;
            const { pr, repo, client } = yield* prCtx.forPr(ctx.params.prId);
            const token = client.token;
            const agent = yield* settingsService.resolveAgent();

            const row = yield* chatSessions.findLatestForPr(pr.id, agent);
            if (!row) return;

            // Re-acquire with the new SHA. At this point all agent
            // commits have been handled, so this should succeed.
            yield* repoClone.acquirePrWorktree({
              repoId: repo.id,
              prNumber: pr.externalId,
              prHeadSha: newHeadSha,
              githubToken: token,
            });

            // Keep the session row's prHeadSha in sync.
            yield* chatSessions.updatePrHeadSha({
              chatSessionId: row.id,
              prHeadSha: newHeadSha,
            });
          }),
        );

        return { status: "advanced" };
      });
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  );
