import { describe, expect, it } from "bun:test";
import { compareServiceBuild } from "./service-build";

const FULL = "ddfe9b8a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";

describe("compareServiceBuild", () => {
  it("matches the app's short hash against the server's full SHA", () => {
    expect(compareServiceBuild("ddfe9b8", FULL)).toEqual({ kind: "match" });
  });

  it("flags a server on a different commit", () => {
    expect(compareServiceBuild("ddfe9b8", "d110ab2f00000000000000000000000000000000")).toEqual({
      kind: "mismatch",
      serviceCommit: "d110ab2",
    });
  });

  it("flags a server too old to report its commit", () => {
    expect(compareServiceBuild("ddfe9b8", undefined)).toEqual({
      kind: "mismatch",
      serviceCommit: null,
    });
  });

  it("stays quiet when either side can't tell", () => {
    expect(compareServiceBuild("ddfe9b8", null)).toEqual({ kind: "unknown" });
    expect(compareServiceBuild("unknown", FULL)).toEqual({ kind: "unknown" });
  });

  it("does not treat a too-short prefix as a match", () => {
    expect(compareServiceBuild("ddf", FULL).kind).toBe("mismatch");
  });
});
