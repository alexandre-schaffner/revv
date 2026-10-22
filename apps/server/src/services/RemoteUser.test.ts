import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb } from "../db/index";
import { DbService } from "./Db";
import { RemoteUserService, RemoteUserServiceLive } from "./RemoteUser";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function countAvatarFetches(): string[] {
  const fetched: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  return fetched;
}

const run = <A>(effect: Effect.Effect<A, never, RemoteUserService>) => {
  const db = createDb(":memory:");
  const layer = RemoteUserServiceLive.pipe(Layer.provide(Layer.succeed(DbService, { db })));
  return Effect.runPromise(Effect.provide(effect, layer));
};

const upsert = (avatarUrl: string) =>
  Effect.flatMap(RemoteUserService, (users) =>
    users.upsert({ provider: "github", providerUserId: "", login: "octo", avatarUrl }),
  );

describe("RemoteUserService.upsert", () => {
  it("fetches an avatar once, however callers spell its URL", async () => {
    const fetched = countAvatarFetches();

    await run(
      Effect.gen(function* () {
        yield* upsert("https://avatars.githubusercontent.com/u/42?u=abc123&v=4");
        yield* upsert("https://avatars.githubusercontent.com/u/42?v=4");
        yield* upsert("https://avatars.githubusercontent.com/u/42?v=4&token=fresh-signature");
      }),
    );

    expect(fetched).toHaveLength(1);
  });

  it("fetches again for a different image", async () => {
    const fetched = countAvatarFetches();

    await run(
      Effect.gen(function* () {
        yield* upsert("https://avatars.githubusercontent.com/u/42?v=4");
        yield* upsert("https://avatars.githubusercontent.com/u/43?v=4");
      }),
    );

    expect(fetched).toHaveLength(2);
  });
});
