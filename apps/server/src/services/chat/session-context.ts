// What the composer's `/` and `@` menus offer for a PR: the agent's slash
// commands and the repository's files.

import type { ChatSessionContext } from "@revv/shared";
import { Effect } from "effect";
import { resolveAgentLaunch } from "../../ai/acp/agent-launch";
import { agentSessionContext } from "../../ai/acp/run-turn";
import { logError } from "../../logger";
import { gitTry, listTrackedFiles } from "../git/ops";
import { PrContextService } from "../PrContext";
import { PrWorkspace } from "../workspace/PrWorkspace";

const EMPTY: ChatSessionContext = {
  commands: [],
  promptImage: false,
  embeddedContext: false,
  repoFiles: [],
};

/**
 * Slash commands harvested per `agent::repoId`. They belong to the agent and
 * the repository's project commands, not to a PR, so one harvest serves every
 * PR of the repo and the first `/` never waits on a cold agent. A cache: lost
 * on restart, refreshed by every warm-up.
 */
const slashCommandCache = new Map<string, ReadonlyArray<ChatSessionContext["commands"][number]>>();

/**
 * The menus for a PR. The plain read fires on every PR selection, so it
 * touches nothing: no GitHub call, no worktree, no agent spawn; it serves a
 * warm agent's commands or the cached ones. `warm` (composer focus) brings
 * the worktree up and the agent with it, and harvests the commands. Missing
 * pieces give empty menus, never an error.
 */
export const resolveChatSessionContext = (prId: string, warm: boolean) =>
  Effect.gen(function* () {
    const prCtx = yield* PrContextService;
    const workspace = yield* PrWorkspace;
    const record = yield* prCtx.readPr(prId);
    const launch = yield* resolveAgentLaunch("chat");
    const cacheKey = `${launch.agent}::${record.repo.id}`;
    const cachedCommands = slashCommandCache.get(cacheKey) ?? EMPTY.commands;

    let worktreePath = workspace.agentBranch(record)?.worktreePath ?? null;
    let headSha = record.pr.headSha;
    if (warm && (worktreePath === null || headSha === null)) {
      const ctx = yield* prCtx.forPr(prId);
      // A turn or push already working there will bring the worktree up itself.
      const opened = yield* Effect.scoped(workspace.open(ctx, "warm-up")).pipe(
        Effect.catchTag("WorkspaceBusyError", () => Effect.succeed(null)),
      );
      worktreePath = opened?.branch.worktreePath ?? worktreePath;
      headSha = opened?.headSha ?? headSha;
    }
    if (worktreePath === null || headSha === null) return { ...EMPTY, commands: cachedCommands };
    const cwd = worktreePath;

    const repoFiles = yield* gitTry(() => listTrackedFiles(cwd)).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          logError("chat-context", "listing the repository's files failed:", err.message);
          return [];
        }),
      ),
    );
    const session = yield* workspace.session({ id: record.pr.id, headSha });
    const live = yield* Effect.promise(() =>
      agentSessionContext({ launch, cwd, warm, sessionId: session?.sessionId ?? null }),
    );
    if (!live) return { ...EMPTY, commands: cachedCommands, repoFiles };
    if (live.commands.length > 0) slashCommandCache.set(cacheKey, live.commands);
    return {
      commands: live.commands.length > 0 ? live.commands : cachedCommands,
      promptImage: live.promptImage,
      embeddedContext: live.embeddedContext,
      repoFiles,
    } satisfies ChatSessionContext;
  });
