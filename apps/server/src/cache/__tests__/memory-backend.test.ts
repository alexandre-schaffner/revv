/**
 * Unit tests for the in-process Memory backend.
 *
 * Memory is the one backend that doesn't need DbService, so we exercise it
 * directly with a no-op Layer. The Sqlite backend is covered end-to-end by
 * the CacheLayer integration suite.
 */

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { DbService } from "../../services/Db";
import { createMemoryBackend } from "../backends/index";
import type { CacheRow } from "../types";

// Memory backend declares DbService in its Effect type for interface
// compatibility with Sqlite, but never uses it. Provide a dummy Layer so we
// can run the Effects in tests without a real DB.
const DummyDbLayer = Layer.succeed(
  DbService,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { db: {} as any },
);

const runMemory = <A, E>(eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(Effect.provide(eff, DummyDbLayer));

const row = (ns: string, key: string, value: string): CacheRow => ({
  ns,
  key,
  valueJson: JSON.stringify(value),
  etag: null,
  lastModified: null,
  tagJson: null,
  fetchedAt: new Date().toISOString(),
  expiresAt: null,
  approxBytes: value.length * 2,
});

describe("Memory backend", () => {
  test("read returns null on missing", async () => {
    const mem = createMemoryBackend();
    const result = await runMemory(mem.readOne("ns", "k"));
    expect(result).toBeNull();
  });

  test("write then read round-trips", async () => {
    const mem = createMemoryBackend();
    await runMemory(mem.writeOne(row("ns", "k", "v")));
    const result = await runMemory(mem.readOne("ns", "k"));
    expect(result).not.toBeNull();
    expect(JSON.parse(result!.valueJson)).toBe("v");
  });

  test("expires_at honored on read (lazy eviction)", async () => {
    const mem = createMemoryBackend();
    const expired: CacheRow = {
      ...row("ns", "k", "v"),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    await runMemory(mem.writeOne(expired));
    const result = await runMemory(mem.readOne("ns", "k"));
    expect(result).toBeNull();
  });

  test("deleteByPrefix removes matching keys only", async () => {
    const mem = createMemoryBackend();
    await runMemory(mem.writeOne(row("ns", "prefix:1", "a")));
    await runMemory(mem.writeOne(row("ns", "prefix:2", "b")));
    await runMemory(mem.writeOne(row("ns", "other", "c")));

    await runMemory(mem.deleteByPrefix("ns", "prefix:"));
    expect(await runMemory(mem.readOne("ns", "prefix:1"))).toBeNull();
    expect(await runMemory(mem.readOne("ns", "prefix:2"))).toBeNull();
    expect(await runMemory(mem.readOne("ns", "other"))).not.toBeNull();
  });

  test("deleteNamespace removes only that ns", async () => {
    const mem = createMemoryBackend();
    await runMemory(mem.writeOne(row("ns1", "k", "a")));
    await runMemory(mem.writeOne(row("ns2", "k", "b")));

    await runMemory(mem.deleteNamespace("ns1"));
    expect(await runMemory(mem.readOne("ns1", "k"))).toBeNull();
    expect(await runMemory(mem.readOne("ns2", "k"))).not.toBeNull();
  });

  test("countEntries and bounds per namespace", async () => {
    const mem = createMemoryBackend();
    const r1: CacheRow = {
      ...row("ns", "a", "x"),
      fetchedAt: new Date(1_000).toISOString(),
      approxBytes: 10,
    };
    const r2: CacheRow = {
      ...row("ns", "b", "y"),
      fetchedAt: new Date(5_000).toISOString(),
      approxBytes: 20,
    };
    await runMemory(mem.writeOne(r1));
    await runMemory(mem.writeOne(r2));

    const count = await runMemory(mem.countEntries("ns"));
    expect(count.entries).toBe(2);
    expect(count.approxBytes).toBe(30);

    const bounds = await runMemory(mem.bounds("ns"));
    expect(bounds.oldestAt).toBe(new Date(1_000).toISOString());
    expect(bounds.newestAt).toBe(new Date(5_000).toISOString());
  });

  test("sweepExpired drops stale rows and returns count", async () => {
    const mem = createMemoryBackend();
    const fresh: CacheRow = {
      ...row("ns", "fresh", "x"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const stale: CacheRow = {
      ...row("ns", "stale", "y"),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    await runMemory(mem.writeOne(fresh));
    await runMemory(mem.writeOne(stale));

    const swept = await runMemory(mem.sweepExpired());
    expect(swept).toBe(1);
    expect(await runMemory(mem.readOne("ns", "fresh"))).not.toBeNull();
    expect(await runMemory(mem.readOne("ns", "stale"))).toBeNull();
  });
});
