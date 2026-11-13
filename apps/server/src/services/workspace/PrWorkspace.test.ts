import { describe, expect, it } from "bun:test";
import type { PullRequest, Repository } from "@revv/shared";
import { type Context, Effect, Layer } from "effect";
import { GitHubAuthError } from "../../domain/errors";
import { AiService } from "../Ai";
import { ChatSessionService } from "../chat/ChatSession";
import { BranchPushLock } from "../git/branch-push-lock";
import { PrContextService } from "../PrContext";
import { PrMirror } from "../PrMirror";
import { SettingsService } from "../Settings";
import { AgentWorktrees } from "./agent-worktrees";
import { PrWorkspace, PrWorkspaceLive } from "./PrWorkspace";

const stub = <S extends Context.Key<unknown, unknown>>(
  tag: S,
  shape: Partial<Context.Service.Shape<S>>,
) => Layer.succeed(tag, shape as Context.Service.Shape<S>);

describe("PrWorkspace reads", () => {
  it("lists the agent's commits for an account whose token is gone", async () => {
    const located: Array<[string, number]> = [];
    const layer = PrWorkspaceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          stub(PrContextService, {
            readPr: () =>
              Effect.succeed({
                pr: { id: "pr-1", externalId: 7, headSha: "a".repeat(40) } as PullRequest,
                repo: { id: "repo-1" } as Repository,
                accountId: "acc-1",
              }),
            forPr: () => Effect.fail(new GitHubAuthError({ message: "sign in again" })),
          }),
          stub(AgentWorktrees, {
            locate: (repoId, prNumber) => {
              located.push([repoId, prNumber]);
              return null;
            },
          }),
          stub(ChatSessionService, {}),
          stub(BranchPushLock, {}),
          stub(AiService, {}),
          stub(PrMirror, {}),
          stub(SettingsService, {}),
        ),
      ),
    );

    const proposed = await Effect.runPromise(
      Effect.flatMap(PrWorkspace, (workspace) => workspace.proposed("pr-1")).pipe(
        Effect.provide(layer),
      ),
    );

    expect(proposed).toEqual({ branchName: null, baseSha: null, commits: [] });
    expect(located).toEqual([["repo-1", 7]]);
  });
});
