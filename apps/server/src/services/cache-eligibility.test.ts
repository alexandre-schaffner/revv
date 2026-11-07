import { describe, expect, it } from "bun:test";
import { type Context, Effect, Layer } from "effect";
import { createDb } from "../db/index";
import { account, user } from "../db/schema/auth";
import { repositories } from "../db/schema/index";
import { GitHubNetworkError } from "../domain/errors";
import { CacheEligibility, CacheEligibilityLive } from "./cache-eligibility";
import { DbService } from "./Db";
import { GitHubAccounts } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";

function harness(answers: Array<Effect.Effect<"write" | "read", GitHubNetworkError>>) {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({ id: "u", name: "U", email: "u@t", createdAt: now, updatedAt: now })
    .run();
  db.insert(account)
    .values({
      id: "acc",
      accountId: "1",
      providerId: "github:github.com",
      userId: "u",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(repositories)
    .values({
      id: "repo",
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      addedAt: now.toISOString(),
      accountId: "acc",
    })
    .run();
  let asked = 0;
  const layer = CacheEligibilityLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DbService, { db }),
        Layer.succeed(GitHubAccounts, {
          profile: () => Effect.succeed({ githubLogin: "me", host: "github.com" }),
          clientFor: () => Effect.succeed({ host: "github.com", token: "t" }),
        } as unknown as Context.Service.Shape<typeof GitHubAccounts>),
        Layer.succeed(GitHubGateway, {
          repos: {
            collaboratorPermission: () =>
              Effect.suspend(() => answers[asked++] ?? Effect.succeed("read" as const)),
          },
        } as unknown as Context.Service.Shape<typeof GitHubGateway>),
      ),
    ),
  );
  return { asked: () => asked, layer };
}

describe("CacheEligibility.canPush", () => {
  it("asks again after GitHub couldn't answer, instead of caching a refusal", async () => {
    const h = harness([
      Effect.fail(new GitHubNetworkError({ cause: "reset" })),
      Effect.succeed("write"),
    ]);
    const eligibility = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CacheEligibility;
        const first = yield* Effect.result(service.canPush("repo"));
        const second = yield* service.canPush("repo");
        return { first, second };
      }).pipe(Effect.provide(h.layer)),
    );

    expect(eligibility.first._tag).toBe("Failure");
    expect(eligibility.second).toBe(true);
    expect(h.asked()).toBe(2);
  });
});
