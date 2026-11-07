import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb } from "../../db/index";
import { DbService } from "../Db";
import { AvatarCache, AvatarCacheLive } from "./avatars";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function countAvatarFetches(): string[] {
  const fetched: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(new Uint8Array([fetched.length]), {
        headers: { "content-type": "image/png" },
      });
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch;
  return fetched;
}

const run = <A>(effect: Effect.Effect<A, never, AvatarCache>) => {
  const db = createDb(":memory:");
  const layer = AvatarCacheLive.pipe(Layer.provide(Layer.succeed(DbService, { db })));
  return Effect.runPromise(Effect.provide(effect, layer));
};

const ensure = (url: string, host = "github.com") =>
  Effect.flatMap(AvatarCache, (avatars) => avatars.ensure(host, "octo", url));

describe("AvatarCache.ensure", () => {
  it("fetches an avatar once, however callers spell its URL", async () => {
    const fetched = countAvatarFetches();

    await run(
      Effect.gen(function* () {
        yield* ensure("https://avatars.githubusercontent.com/u/42?u=abc123&v=4");
        yield* ensure("https://avatars.githubusercontent.com/u/42?v=4");
        yield* ensure("https://avatars.githubusercontent.com/u/42?v=4&token=fresh-signature");
      }),
    );

    expect(fetched).toHaveLength(1);
  });

  it("fetches again for a different image", async () => {
    const fetched = countAvatarFetches();

    await run(
      Effect.gen(function* () {
        yield* ensure("https://avatars.githubusercontent.com/u/42?v=4");
        yield* ensure("https://avatars.githubusercontent.com/u/43?v=4");
      }),
    );

    expect(fetched).toHaveLength(2);
  });

  it("keeps the same login on two hosts apart", async () => {
    countAvatarFetches();

    const { publicAvatar, enterpriseAvatar } = await run(
      Effect.gen(function* () {
        const avatars = yield* AvatarCache;
        yield* ensure("https://avatars.githubusercontent.com/u/42", "github.com");
        yield* ensure("https://ghe.example.com/avatars/u/7?token=signed", "ghe.example.com");
        const publicAvatar = (yield* avatars.contents("github.com", ["octo"])).get("octo");
        const enterpriseAvatar = (yield* avatars.contents("ghe.example.com", ["octo"])).get("octo");
        return { publicAvatar, enterpriseAvatar };
      }),
    );

    expect(publicAvatar).toBeDefined();
    expect(enterpriseAvatar).toBeDefined();
    expect(publicAvatar).not.toBe(enterpriseAvatar);
  });

  it("serves the cached bytes, never the signed URL", async () => {
    countAvatarFetches();

    const cached = await run(
      Effect.gen(function* () {
        const avatars = yield* AvatarCache;
        yield* ensure("https://ghe.example.com/avatars/u/7?token=signed", "ghe.example.com");
        return (yield* avatars.contents("ghe.example.com", ["octo"])).get("octo");
      }),
    );

    expect(cached?.startsWith("data:image/png;base64,")).toBe(true);
  });
});
