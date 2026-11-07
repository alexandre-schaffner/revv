import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { STORAGE_KEYS } from "$lib/stores/persisted.svelte";
import {
  getHeldSessions,
  type HeldSession,
  heldToken,
  holdSession,
  releaseSession,
} from "./held-sessions";

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

function session(userId: string, token: string): HeldSession {
  return { userId, token, name: userId, email: `${userId}@example.com` };
}

describe("held sessions", () => {
  test("a user's newer session replaces the one held before", () => {
    holdSession(session("ada", "t1"));
    holdSession(session("bob", "t2"));
    holdSession(session("ada", "t3"));
    expect(getHeldSessions().map((s) => [s.userId, s.token])).toEqual([
      ["bob", "t2"],
      ["ada", "t3"],
    ]);
    expect(heldToken("ada")).toBe("t3");
    expect(heldToken("eve")).toBeNull();
  });

  test("releases by user or by token", () => {
    holdSession(session("ada", "t1"));
    holdSession(session("bob", "t2"));
    releaseSession({ token: "t1" });
    expect(heldToken("ada")).toBeNull();
    releaseSession({ userId: "bob" });
    expect(getHeldSessions()).toEqual([]);
  });

  test("reads what another window wrote since", () => {
    holdSession(session("ada", "t1"));
    // Another window holds a session of its own.
    const theirs = [...getHeldSessions(), session("bob", "t2")];
    store.set(STORAGE_KEYS.heldSessions, JSON.stringify(theirs));
    holdSession(session("cy", "t3"));
    expect(getHeldSessions().map((s) => s.userId)).toEqual(["ada", "bob", "cy"]);
  });

  test("drops malformed rows instead of the whole list", () => {
    store.set(
      STORAGE_KEYS.heldSessions,
      JSON.stringify([session("ada", "t1"), { userId: "bob" }, "junk"]),
    );
    expect(getHeldSessions().map((s) => s.userId)).toEqual(["ada"]);
  });

  test("reads a row an older version wrote with its avatar, and drops the avatar", () => {
    store.set(
      STORAGE_KEYS.heldSessions,
      JSON.stringify([{ ...session("ada", "t1"), image: "data:image/png;base64,AAAA" }]),
    );
    expect(getHeldSessions()).toEqual([session("ada", "t1")]);
  });
});
