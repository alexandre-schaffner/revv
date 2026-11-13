import { describe, expect, it } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { BranchPushLock, BranchPushLockLive } from "./branch-push-lock";

const run = <A, E>(effect: Effect.Effect<A, E, BranchPushLock>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(BranchPushLockLive)));

const feat1 = { repoId: "repo", branch: "feat-1" };
const feat2 = { repoId: "repo", branch: "feat-2" };

describe("BranchPushLock", () => {
  it("refuses a second push to a held branch, naming who holds it", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const lock = yield* BranchPushLock;
        const scope = yield* Scope.make();
        yield* lock.hold([feat1, feat2], "stack-rebase").pipe(Scope.provide(scope));
        return yield* Effect.scoped(lock.hold([feat2], "chat-push"));
      }),
    );
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("stack-rebase");
  });

  it("takes none of the branches when one is held", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const lock = yield* BranchPushLock;
        const scope = yield* Scope.make();
        yield* lock.hold([feat2], "base-sync").pipe(Scope.provide(scope));
        yield* Effect.scoped(lock.hold([feat1, feat2], "stack-rebase")).pipe(Effect.ignore);
        return lock.holder(feat1);
      }),
    );
    expect(exit).toEqual(Exit.succeed(null));
  });

  it("gives the branch back when the holder's scope closes, however it ends", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const lock = yield* BranchPushLock;
        yield* Effect.scoped(
          lock.hold([feat1], "chat-push").pipe(Effect.andThen(Effect.fail("push failed"))),
        ).pipe(Effect.ignore);
        const during = yield* Effect.scoped(
          lock.hold([feat1], "base-sync").pipe(Effect.map(() => lock.holder(feat1))),
        );
        return [during, lock.holder(feat1)];
      }),
    );
    expect(exit).toEqual(Exit.succeed(["base-sync", null]));
  });
});
