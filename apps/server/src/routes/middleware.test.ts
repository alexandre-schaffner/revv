import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { NotFoundError } from "../domain/errors";
import { runRoute } from "./middleware";

describe("runRoute", () => {
  it("answers a rejected runtime call with the error's status and body", async () => {
    const answer = await runRoute(async () => {
      await Effect.runPromise(Effect.fail(new NotFoundError({ resource: "thread", id: "t" })));
    });
    expect(answer).toMatchObject({
      code: 404,
      response: { error: "Thread not found", code: "NOT_FOUND" },
    });
  });

  it("answers anything else thrown as a 500", async () => {
    const answer = await runRoute(async () => {
      throw new Error("boom");
    });
    expect(answer).toMatchObject({
      code: 500,
      response: { error: "boom", code: "INTERNAL_ERROR" },
    });
  });

  it("passes a value through", async () => {
    expect(await runRoute(async () => ({ ok: true }))).toEqual({ ok: true });
  });
});
