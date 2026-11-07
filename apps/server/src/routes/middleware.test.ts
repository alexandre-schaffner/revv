import { describe, expect, it } from "bun:test";
import { Elysia, t } from "elysia";
import { NotFoundError } from "../domain/errors";
import { errorResponse, requestRefusals } from "./middleware";

describe("errorResponse", () => {
  it("answers a domain error with its status and body", () => {
    expect(errorResponse(new NotFoundError({ resource: "thread", id: "t" }))).toMatchObject({
      code: 404,
      response: { error: "Thread not found", code: "NOT_FOUND" },
    });
  });

  it("answers anything else as a 500", () => {
    expect(errorResponse(new Error("boom"))).toMatchObject({
      code: 500,
      response: { error: "boom", code: "INTERNAL_ERROR" },
    });
  });
});

describe("requestRefusals", () => {
  const app = new Elysia()
    .use(requestRefusals)
    .post("/echo", ({ body }) => body, { body: t.Object({ name: t.String() }) });
  const post = (body: string) =>
    app.handle(
      new Request("http://localhost/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );

  it("answers a body that fails its schema like any other refusal", async () => {
    const res = await post(JSON.stringify({ name: 1 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("INVALID");
    expect(typeof body.error).toBe("string");
  });

  it("answers a body that isn't JSON like any other refusal", async () => {
    const res = await post("{");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID" });
  });
});
