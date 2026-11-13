import { describe, expect, it } from "bun:test";
import type { PullRequest, Repository, UserSettings } from "@revv/shared";
import { type Context, Effect, Layer } from "effect";
import { GitHubAuthError, httpErrorOf } from "../../domain/errors";
import { PrContextService } from "../PrContext";
import { SettingsService } from "../Settings";
import { PrWorkspace } from "../workspace/PrWorkspace";
import { resolveChatSessionContext } from "./session-context";

const stub = <S extends Context.Key<unknown, unknown>>(
  tag: S,
  shape: Partial<Context.Service.Shape<S>>,
) => Layer.succeed(tag, shape as Context.Service.Shape<S>);

const signedOut = (located: string[] = []) =>
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
    stub(PrWorkspace, {
      agentBranch: ({ pr }) => {
        located.push(pr.id);
        return null;
      },
    }),
    stub(SettingsService, {
      getSettings: () => Effect.succeed({} as UserSettings),
      resolveAgent: () => Effect.succeed("opencode" as const),
    }),
  );

describe("resolveChatSessionContext", () => {
  it("answers the plain read for an account whose token is gone", async () => {
    const located: string[] = [];
    const layer = signedOut(located);

    const context = await Effect.runPromise(
      resolveChatSessionContext("pr-1", false).pipe(Effect.provide(layer)),
    );

    expect(context).toEqual({
      commands: [],
      promptImage: false,
      embeddedContext: false,
      repoFiles: [],
    });
    expect(located).toEqual(["pr-1"]);
  });

  it("refuses the warm read for that account with the coded auth refusal", async () => {
    const exit = await Effect.runPromise(
      Effect.flip(resolveChatSessionContext("pr-1", true)).pipe(Effect.provide(signedOut())),
    );

    expect(exit).toBeInstanceOf(GitHubAuthError);
    expect(httpErrorOf(exit)).toMatchObject({ status: 401, code: "GITHUB_AUTH_ERROR" });
  });
});
