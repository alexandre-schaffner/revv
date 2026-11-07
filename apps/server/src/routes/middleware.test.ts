import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../domain/errors";
import { errorResponse } from "./middleware";

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
