import { describe, expect, it } from "bun:test";
import { ApiError, apiErrorCode, call } from "./errors";

type Result<T> =
  | { data: T; error: null }
  | { data: null; error: { status: number; value: unknown } };

const ok = <T>(data: T): Promise<Result<T>> => Promise.resolve({ data, error: null });
const refused = <T>(status: number, value: unknown): Promise<Result<T>> =>
  Promise.resolve({ data: null, error: { status, value } });

describe("call", () => {
  it("returns the success body", async () => {
    expect(await call(ok({ teams: [] }), "Failed")).toEqual({ teams: [] });
  });

  it("throws a refusal as an ApiError carrying the server's wording and code", async () => {
    const thrown = await call(
      refused(404, { error: "Pull request not found", code: "NOT_FOUND", id: "x" }),
      "Failed",
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ApiError);
    const e = thrown as ApiError;
    expect(e.message).toBe("Pull request not found");
    expect(e.status).toBe(404);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.body?.id).toBe("x");
    expect(apiErrorCode(e)).toBe("NOT_FOUND");
  });

  it("words a refusal whose body says nothing with the fallback and status", async () => {
    const e = (await call(refused(502, "Bad Gateway"), "Couldn't reach GitHub").catch(
      (err: unknown) => err,
    )) as ApiError;
    expect(e.message).toBe("Couldn't reach GitHub (HTTP 502)");
    expect(e.code).toBeNull();
    expect(e.serverMessage).toBeUndefined();
  });

  it("lets a network failure through as itself", async () => {
    const network = new TypeError("Load failed");
    expect(await call(Promise.reject(network), "Failed").catch((e: unknown) => e)).toBe(network);
    expect(apiErrorCode(network)).toBeNull();
  });
});
