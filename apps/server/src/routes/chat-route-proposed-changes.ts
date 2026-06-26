// ── Proposed-changes sub-router ────────────────────────────────────────────
//
// Elysia sub-router for all /api/chat/:prId/proposed-changes/* endpoints.
// Composed into the main chatRoute via `.use()`.

import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { logError } from "../logger";
import { AppRuntime } from "../runtime";
import {
  ChatChangesPushService,
  ChatStreamingConflictError,
  ConcurrentPushError,
  DirtyWorktreeError,
  InvalidBranchNameError,
  NoChangesError,
  NoChatSessionError,
  PushRejectedError,
  RefAlreadyExistsError,
} from "../services/ChatChangesPush";
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
  resolvePushStreamToSSE,
} from "./chat-helpers";
import {
  handleAppError,
  jsonResponse,
  mapErrorToSSEResponse,
  unwrapEffectError,
  withAuth,
} from "./middleware";

export const chatProposedChangesRoutes = new Elysia()
  .use(withAuth)
  .get(
    "/api/chat/:prId/proposed-changes",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();

            const row = yield* chatSessions.findLatestForPr(pr.id, agent);
            if (!row) return null;
            return row;
          }),
        );

        if (!result) {
          return jsonResponse({ branchName: null, prHeadSha: null, commits: [] }, 200);
        }

        const commits = await listProposedCommits(result.worktreePath, result.prHeadSha).catch(
          (err) => {
            logError(
              "chat",
              "listProposedCommits failed:",
              err instanceof Error ? err.message : String(err),
            );
            return [] as ProposedCommit[];
          },
        );

        return jsonResponse(
          {
            branchName: result.branchName,
            prHeadSha: result.prHeadSha,
            commits,
          },
          200,
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/diff",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();

            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!result) {
          ctx.set.status = 404;
          return { error: "No active chat session for this PR" };
        }

        // Validate the SHA shape — defense in depth against arg injection.
        if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
          ctx.set.status = 400;
          return { error: "Invalid commit SHA" };
        }

        const diff = await gitStdout(
          ["show", "--patch", "--pretty=format:", ctx.params.sha],
          result.worktreePath,
          15_000,
        );

        return new Response(diff, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String(), sha: t.String() }),
    },
  )
  .get(
    "/api/chat/:prId/proposed-changes/:sha/files",
    async (ctx) => {
      try {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();

            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!result) {
          ctx.set.status = 404;
          return { error: "No active chat session for this PR" };
        }

        if (!/^[0-9a-f]{7,40}$/i.test(ctx.params.sha)) {
          ctx.set.status = 400;
          return { error: "Invalid commit SHA" };
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
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String(), sha: t.String() }),
    },
  )
  .post(
    "/api/chat/:prId/proposed-changes/merge-and-push",
    async (ctx) => {
      try {
        const body = (ctx.body ?? {}) as {
          newBranchName?: unknown;
          force?: unknown;
        };
        let newBranchName: string | undefined;
        if (body.newBranchName !== undefined) {
          if (typeof body.newBranchName !== "string") {
            ctx.set.status = 400;
            return {
              code: "INVALID_BRANCH_NAME",
              message: "newBranchName must be a string",
            };
          }
          const trimmed = body.newBranchName.trim();
          if (
            trimmed.length === 0 ||
            /\s/.test(trimmed) ||
            trimmed.startsWith("-") ||
            trimmed.includes("..")
          ) {
            ctx.set.status = 400;
            return {
              code: "INVALID_BRANCH_NAME",
              message: "newBranchName is empty or contains invalid characters",
            };
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
      } catch (e) {
        const err = unwrapEffectError(e);
        if (err instanceof ConcurrentPushError) {
          ctx.set.status = 409;
          return { code: "CONCURRENT_PUSH", message: "A push is already in progress for this PR" };
        }
        if (err instanceof ChatStreamingConflictError) {
          ctx.set.status = 409;
          return {
            code: "CHAT_STREAMING",
            message: "Wait for the chat agent to finish before pushing",
          };
        }
        if (err instanceof DirtyWorktreeError) {
          ctx.set.status = 422;
          return { code: "DIRTY_WORKTREE", message: err.message };
        }
        if (err instanceof NoChangesError) {
          ctx.set.status = 422;
          return { code: "NO_CHANGES", message: "No agent commits to push" };
        }
        if (err instanceof NoChatSessionError) {
          ctx.set.status = 422;
          return {
            code: "NO_CHAT_SESSION",
            message: "No chat session for this PR — start a chat first",
          };
        }
        if (err instanceof InvalidBranchNameError) {
          ctx.set.status = 400;
          return { code: "INVALID_BRANCH_NAME", message: err.message };
        }
        if (err instanceof RefAlreadyExistsError) {
          ctx.set.status = 409;
          return { code: "REF_EXISTS", message: `branch ${err.ref} already exists` };
        }
        if (err instanceof PushRejectedError) {
          ctx.set.status = 502;
          return { code: "PUSH_REJECTED", message: err.message };
        }
        return handleAppError(e, ctx);
      }
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
    async (ctx) => {
      try {
        const stream = await AppRuntime.runPromise(
          Effect.flatMap(ChatChangesPushService, (svc) =>
            svc.resolveConflictsAndPush({
              prId: ctx.params.prId,
              userId: ctx.session.user.id,
            }),
          ),
        );

        return new Response(resolvePushStreamToSSE(stream), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      } catch (e) {
        return mapErrorToSSEResponse(e);
      }
    },
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
        ctx.set.status = 400;
        return { error: "sha is required and must be a valid commit hash" };
      }
      const { sha } = body;

      try {
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
          return jsonResponse(
            {
              status: "pushed",
              newSha: result.newSha,
              pushedCommits: result.pushedCommits,
              branch: result.branch,
            },
            200,
          );
        }
        if (result.status === "remote-changed") {
          ctx.set.status = 409;
          return { status: "remote-changed", branch: result.branch };
        }
        ctx.set.status = 500;
        return { error: "Unexpected cherry-pick result" };
      } catch (e) {
        const err = unwrapEffectError(e);
        if (err instanceof ConcurrentPushError) {
          ctx.set.status = 409;
          return {
            code: "CONCURRENT_PUSH",
            message: "Another push is already in progress for this PR",
          };
        }
        if (err instanceof DirtyWorktreeError) {
          ctx.set.status = 409;
          return { code: "DIRTY_WORKTREE", message: err.message };
        }
        if (err instanceof NoChangesError) {
          ctx.set.status = 409;
          return { code: "NO_CHANGES", message: "No proposed commits found" };
        }
        if (err instanceof NoChatSessionError) {
          ctx.set.status = 404;
          return { code: "NO_CHAT_SESSION", message: "No chat session found for this PR" };
        }
        return handleAppError(e, ctx);
      }
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
        ctx.set.status = 400;
        return { error: "shas must be a non-empty array of commit hashes" };
      }
      const shas: string[] = [];
      for (const raw of body.shas) {
        if (typeof raw !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw)) {
          ctx.set.status = 400;
          return { error: "shas must contain valid commit hashes" };
        }
        shas.push(raw);
      }

      try {
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
          return jsonResponse(
            {
              status: "pushed",
              newSha: result.newSha,
              pushedCommits: result.pushedCommits,
              branch: result.branch,
            },
            200,
          );
        }
        if (result.status === "remote-changed") {
          ctx.set.status = 409;
          return { status: "remote-changed", branch: result.branch };
        }
        ctx.set.status = 500;
        return { error: "Unexpected cherry-pick result" };
      } catch (e) {
        const err = unwrapEffectError(e);
        if (err instanceof ConcurrentPushError) {
          ctx.set.status = 409;
          return {
            code: "CONCURRENT_PUSH",
            message: "Another push is already in progress for this PR",
          };
        }
        if (err instanceof DirtyWorktreeError) {
          ctx.set.status = 409;
          return { code: "DIRTY_WORKTREE", message: err.message };
        }
        if (err instanceof NoChangesError) {
          ctx.set.status = 409;
          return { code: "NO_CHANGES", message: "No proposed commits found" };
        }
        if (err instanceof NoChatSessionError) {
          ctx.set.status = 404;
          return { code: "NO_CHAT_SESSION", message: "No chat session found for this PR" };
        }
        return handleAppError(e, ctx);
      }
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
        ctx.set.status = 400;
        return { error: "Invalid commit SHA" };
      }

      try {
        const row = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();
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

        return jsonResponse({ status: "discarded" }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
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
        ctx.set.status = 400;
        return { error: "shas must be a non-empty array of commit hashes" };
      }
      const rawShas: string[] = [];
      for (const raw of body.shas) {
        if (typeof raw !== "string" || !/^[0-9a-f]{7,40}$/i.test(raw)) {
          ctx.set.status = 400;
          return { error: "shas must contain valid commit hashes" };
        }
        rawShas.push(raw);
      }

      try {
        const row = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();
            return yield* chatSessions.findLatestForPr(pr.id, agent);
          }),
        );

        if (!row) {
          ctx.set.status = 404;
          return { error: "No chat session found for this PR" };
        }

        const { worktreePath, branchName, prHeadSha } = row;

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
          ["rev-list", "--reverse", ...PROPOSED_COMMIT_RANGE_FLAGS, `${prHeadSha}..${branchName}`],
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

        // Rebuild the agent branch by checking out the prHeadSha as a detached
        // HEAD then cherry-picking each keep commit in order. On any failure
        // we abort and restore the branch ref to its prior tip.
        const restoreOnFailure = async (): Promise<void> => {
          await gitStdoutBestEffort(["cherry-pick", "--abort"], worktreePath);
          await gitStdoutBestEffort(["branch", "-f", branchName, savedAgentTip], worktreePath);
          await gitStdoutBestEffort(["checkout", branchName], worktreePath);
        };

        try {
          await gitStdout(["checkout", "--detach", prHeadSha], worktreePath, 15_000);
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

        return jsonResponse({ status: "discarded", discardedCount: matchedDropCount }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
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
        ctx.set.status = 400;
        return { error: "oldHeadSha and newHeadSha are required strings" };
      }
      const { oldHeadSha, newHeadSha } = body;

      try {
        const row = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const { pr } = yield* prCtx.resolveBasic(ctx.params.prId, ctx.session.user.id);
            const agent = yield* settingsService.resolveChatAgentId();
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

        return jsonResponse({ status: "rebased" }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
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
        ctx.set.status = 400;
        return { error: "newHeadSha is required" };
      }
      const { newHeadSha } = body;

      try {
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const prCtx = yield* PrContextService;
            const chatSessions = yield* ChatSessionService;
            const settingsService = yield* SettingsService;
            const repoClone = yield* RepoCloneService;
            const { pr, repo, token } = yield* prCtx.resolveBasic(
              ctx.params.prId,
              ctx.session.user.id,
            );
            const agent = yield* settingsService.resolveChatAgentId();

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

        return jsonResponse({ status: "advanced" }, 200);
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    {
      params: t.Object({ prId: t.String() }),
    },
  );
