import { describe, expect, it } from "bun:test";
import { Deferred, Effect } from "effect";
import { PrHeadMoves, PrHeadMovesLive } from "./pr-head-moves";

describe("PrHeadMoves", () => {
  // A publisher may hold a lock its listener needs (a walkthrough request
  // records the live head under its PR lock), so publish must not wait.
  it("returns before its listeners finish, and runs each of them", async () => {
    const heard = await Effect.runPromise(
      Effect.gen(function* () {
        const headMoves = yield* PrHeadMoves;
        const heardMove = yield* Deferred.make<string>();
        yield* headMoves.listen(() => Effect.never);
        yield* headMoves.listen((prId, headSha) =>
          Deferred.succeed(heardMove, `${prId}@${headSha}`).pipe(Effect.asVoid),
        );
        yield* headMoves.publish("pr-1", "head-2").pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.die(new Error("publish waited on a listener")),
          }),
        );
        return yield* Deferred.await(heardMove);
      }).pipe(Effect.provide(PrHeadMovesLive)),
    );
    expect(heard).toBe("pr-1@head-2");
  });
});
