import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, fallbackMapForWrite, serialize, type TokenPair } from "./SecretStore";

describe("SecretStore serialize/deserialize", () => {
  it("round-trips a full token pair", () => {
    const pair: TokenPair = { accessToken: "gho_abc", refreshToken: "ghr_def" };
    expect(deserialize(serialize(pair))).toEqual(pair);
  });

  it("normalizes a missing refresh token to null", () => {
    expect(deserialize(serialize({ accessToken: "a", refreshToken: null }))).toEqual({
      accessToken: "a",
      refreshToken: null,
    });
  });

  it("tolerates a legacy raw-string access token (non-JSON)", () => {
    expect(deserialize("gho_legacy")).toEqual({ accessToken: "gho_legacy", refreshToken: null });
  });
});

describe("encrypted-file fallback", () => {
  it("moves an unreadable store aside instead of overwriting it on the next write", () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-secret-store-"));
    const path = join(dir, "secret-store.enc");
    const unreadable = Buffer.from("not ciphertext");
    writeFileSync(path, unreadable);

    expect(fallbackMapForWrite(path)).toEqual({});

    expect(existsSync(path)).toBe(false);
    const aside = readdirSync(dir).filter((f) => f.startsWith("secret-store.enc.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ""))).toEqual(unreadable);
  });

  it("starts empty when there is no store yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "revv-secret-store-"));
    expect(fallbackMapForWrite(join(dir, "secret-store.enc"))).toEqual({});
    expect(readdirSync(dir)).toEqual([]);
  });
});
