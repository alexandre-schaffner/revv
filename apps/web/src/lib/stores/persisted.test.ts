import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clampedIntCodec,
  flagCodec,
  jsonCodec,
  oneOfCodec,
  readStored,
  textCodec,
  writeStored,
} from "./persisted.svelte";

const original = globalThis.localStorage;
let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
});

afterEach(() => {
  globalThis.localStorage = original;
});

describe("readStored", () => {
  test("falls back when the key is missing or the stored text is invalid", () => {
    expect(readStored("k", oneOfCodec(["a", "b"]), "a")).toBe("a");
    store.set("k", "zzz");
    expect(readStored("k", oneOfCodec(["a", "b"]), "a")).toBe("a");
    store.set("k", "b");
    expect(readStored("k", oneOfCodec(["a", "b"]), "a")).toBe("b");
  });

  test("survives malformed JSON", () => {
    store.set("k", "{not json");
    expect(
      readStored(
        "k",
        jsonCodec((v) => v as object),
        {},
      ),
    ).toEqual({});
  });

  test("clamps stored integers", () => {
    store.set("k", "9000");
    expect(readStored("k", clampedIntCodec(10, 100), 50)).toBe(100);
    store.set("k", "wide");
    expect(readStored("k", clampedIntCodec(10, 100), 50)).toBe(50);
  });
});

describe("writeStored", () => {
  test("removes the key for a false flag and blank text", () => {
    writeStored("f", flagCodec, true);
    expect(store.get("f")).toBe("1");
    writeStored("f", flagCodec, false);
    expect(store.has("f")).toBe(false);

    writeStored("t", textCodec, "/src");
    expect(store.get("t")).toBe("/src");
    writeStored("t", textCodec, "  ");
    expect(store.has("t")).toBe(false);
  });

  test("swallows a storage that refuses the write", () => {
    globalThis.localStorage = {
      ...globalThis.localStorage,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as Storage;
    expect(() => writeStored("k", textCodec, "x")).not.toThrow();
  });
});
