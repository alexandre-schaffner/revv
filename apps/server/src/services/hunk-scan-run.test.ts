import { describe, expect, it } from "bun:test";
import type { HunkScanEventMessage } from "@revv/shared";
import { Deferred, Effect, Fiber, Layer, TestClock, TestContext } from "effect";
import type { FileLike } from "../ai/jev/state";
import { createDb, type Db } from "../db/index";
import { JevUnavailable } from "../domain/errors";
import { BroadcasterLive } from "./Broadcaster";
import { CacheServiceLive } from "./Cache";
import { DbService } from "./Db";
import { HUNK_SCAN_JOIN_BUDGET_MS, HunkScanService, HunkScanServiceLive } from "./HunkScan";
import { planHunkScan, runHunkScan } from "./hunk-scan-run";
import { getHunkScan, loadHunkScan, recordHunkSignals } from "./hunk-scan-store";
import { JevService, type JevState } from "./Jev";

/** One file, `count` one-line hunks, each adding a distinct line. */
function fileOf(filename: string, count: number): FileLike {
  return {
    filename,
    status: "modified",
    additions: count,
    deletions: 0,
    patch: Array.from(
      { length: count },
      (_, i) =>
        `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n ctx\n+const ${filename.replace(/\W/g, "_")}_${i} = ${i};`,
    ).join("\n"),
  };
}

const FILES: FileLike[] = [fileOf("src/a.ts", 2), fileOf("src/b.ts", 1)];

const PR = "repo-1:1";

function makeDb(): Db {
  const db = createDb(":memory:");
  // Only the scan tables are under test; the PR they hang off is irrelevant.
  (db as unknown as { session: { client: { run: (sql: string) => void } } }).session.client.run(
    "PRAGMA foreign_keys = OFF",
  );
  return db;
}

interface StubOptions {
  readonly available?: boolean;
  /** Calls (1-based) that fail. */
  readonly failCalls?: ReadonlySet<number>;
  /** Fail every call past the Nth. */
  readonly failAfter?: number;
  /** Calls (1-based) that hit the rate limit. */
  readonly rateLimitCalls?: ReadonlySet<number>;
  /** Hold every call until this resolves. */
  readonly gate?: Effect.Effect<void>;
  /** A question to leave out of every answer. */
  readonly omit?: string;
  /** Per-question probability; `slop` defaults to 0.8, everything else 0.1. */
  readonly score?: (question: string, patch: string) => number;
}

/** A JevService that records what it was asked and answers (or fails) as told. */
function stubJev(opts: StubOptions = {}) {
  const asked: string[] = [];
  const questionsByPath = new Map<string, string[]>();
  const layer = Layer.succeed(JevService, {
    // `ask` is generic over the question map, which a literal can't express.
    ask: ((req: { state: JevState; questions: object }) => {
      const patch = String((req.state.hunk as { patch: string }).patch);
      asked.push(patch);
      const call = asked.length;
      questionsByPath.set(
        String((req.state.file as { path: string }).path),
        Object.keys(req.questions),
      );
      if (opts.rateLimitCalls?.has(call)) {
        return Effect.fail(new JevUnavailable({ reason: "rate_limited", retryAfterMs: 1 }));
      }
      if (opts.failCalls?.has(call) || (opts.failAfter !== undefined && call > opts.failAfter)) {
        return Effect.fail(new JevUnavailable({ reason: "timeout" }));
      }
      const score = opts.score ?? ((q: string) => (q === "slop" ? 0.8 : 0.1));
      return (opts.gate ?? Effect.void).pipe(
        Effect.as({
          model: "stub",
          usage: { input_tokens: 0, output_tokens: 0 },
          answers: Object.fromEntries(
            Object.keys(req.questions)
              .filter((key) => key !== opts.omit)
              .map((key) => [key, { type: "noul", noul: score(key, patch) }]),
          ),
        }),
      );
    }) as never,
    isAvailable: () => Effect.succeed(opts.available ?? true),
    testConnection: () => Effect.succeed({ model: "stub", latencyMs: 0 }),
  });
  return { layer, asked, questionsByPath };
}

const withDb = (db: Db) => Layer.succeed(DbService, { db });

/** `runHunkScan` as `HunkScanService` calls it, minus the service's in-flight bookkeeping. */
function runInput(
  headSha: string,
  files: readonly FileLike[],
  retry: boolean,
  emit: (event: HunkScanEventMessage) => Effect.Effect<void>,
) {
  return {
    prId: PR,
    headSha,
    selection: planHunkScan({ prId: PR, headSha, files, filePriorities: null }),
    retry,
    emit,
    withCallSlot: <A, R>(effect: Effect.Effect<A, never, R>) => effect,
  };
}

function scan(
  db: Db,
  jev: Layer.Layer<JevService>,
  headSha: string,
  files: readonly FileLike[] = FILES,
  retry = false,
) {
  const events: HunkScanEventMessage[] = [];
  const run = runHunkScan(
    runInput(headSha, files, retry, (event) => Effect.sync(() => void events.push(event))),
  ).pipe(Effect.provide(CacheServiceLive), Effect.provide(jev), Effect.provide(withDb(db)));
  return Effect.runPromise(run).then((rows) => ({ rows, events }));
}

const persisted = (db: Db, headSha: string) =>
  Effect.runPromise(loadHunkScan({ prId: PR, headSha }).pipe(Effect.provide(withDb(db))));

const QUIET = {
  vulnerability: 0,
  over_defensive: 0,
  silent_failure: 0,
  slop: 0,
  over_engineered: 0,
  hard_to_read: 0,
  unclean: 0,
  verbose_comment: 0,
  redundant_test: 0,
};

/** Seed a scan and interrupt it before any answer lands, as a kill would. */
function cutOff(db: Db, headSha: string) {
  return Effect.runPromise(
    runHunkScan(
      runInput(headSha, FILES, false, (e) =>
        e.type === "hunk-scan:started" ? Effect.interrupt : Effect.void,
      ),
    ).pipe(
      Effect.provide(CacheServiceLive),
      Effect.provide(stubJev().layer),
      Effect.provide(withDb(db)),
      Effect.exit,
    ),
  );
}

const completeOf = (events: HunkScanEventMessage[]) => {
  const last = events.at(-1);
  if (last?.type !== "hunk-scan:complete")
    throw new Error("the scan must end on hunk-scan:complete");
  return last.data;
};

describe("runHunkScan", () => {
  it("does nothing, and seeds nothing, when Jev is unavailable", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ available: false });
    const { rows, events } = await scan(db, layer, "sha-1");
    expect(rows).toEqual([]);
    expect(events).toEqual([]);
    expect(asked).toHaveLength(0);
    expect(await persisted(db, "sha-1")).toEqual({ headSha: "sha-1", status: null, rows: [] });
  });

  it("answers every hunk, committing each before it is announced", async () => {
    const db = makeDb();
    const { rows, events } = await scan(db, stubJev().layer, "sha-1");

    expect(events.map((e) => e.type)).toEqual([
      "hunk-scan:started",
      "hunk-scan:hunk",
      "hunk-scan:hunk",
      "hunk-scan:hunk",
      "hunk-scan:complete",
    ]);
    expect(completeOf(events)).toMatchObject({ status: "complete", scanned: 3, flagged: 3 });
    expect(rows.every((r) => r.signals?.slop === 0.8 && r.skipReason === null)).toBe(true);
    // The DB is the source: what the scan returned is what a reload reads.
    expect(await persisted(db, "sha-1")).toEqual({ headSha: "sha-1", status: "complete", rows });
  });

  it("has no hunk cap: a large PR is read to the last hunk", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev();
    const { rows, events } = await scan(db, layer, "sha-1", [fileOf("src/big.ts", 450)]);
    expect(asked).toHaveLength(450);
    expect(rows.every((r) => r.signals !== null)).toBe(true);
    expect(completeOf(events).status).toBe("complete");
  });

  it("retries a failed call once, so a blip doesn't cost a hunk", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ failCalls: new Set([1]) });
    const { rows, events } = await scan(db, layer, "sha-1");
    expect(asked).toHaveLength(4);
    expect(rows.every((r) => r.signals !== null)).toBe(true);
    expect(completeOf(events).status).toBe("complete");
  });

  it("stops asking once Jev is down, and ends partial with the rest unscanned", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ failAfter: 20 });
    const { rows, events } = await scan(db, layer, "sha-1", [fileOf("src/big.ts", 300)]);

    // The breaker trips within the first wave of failures instead of asking all 280 remaining hunks.
    expect(asked.length).toBeLessThan(60);
    expect(completeOf(events)).toMatchObject({ status: "partial", scanned: 20 });
    expect(rows.filter((r) => r.signals !== null)).toHaveLength(20);
    expect(rows.filter((r) => r.skipReason === "unscanned")).toHaveLength(280);
    expect((await persisted(db, "sha-1")).status).toBe("partial");
  });

  it("counts one stall that fails every call in flight as one failure, not a dead Jev", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ failCalls: new Set([1, 2, 3, 4, 5, 6, 7, 8]) });
    const { rows, events } = await scan(db, layer, "sha-1", [fileOf("src/big.ts", 20)]);
    expect(asked).toHaveLength(28);
    expect(rows.every((r) => r.signals !== null)).toBe(true);
    expect(completeOf(events).status).toBe("complete");
  });

  it("waits out a rate limit instead of counting it toward the breaker", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ rateLimitCalls: new Set([1, 2, 3, 4, 5]) });
    const { rows, events } = await scan(db, layer, "sha-1");
    expect(asked).toHaveLength(8);
    expect(rows.every((r) => r.signals !== null)).toBe(true);
    expect(completeOf(events).status).toBe("complete");
  });

  it("drops the whole pass when Jev answers nothing, as if it had never run", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev({ failAfter: 0 });
    const { rows, events } = await scan(db, layer, "sha-1", [fileOf("src/big.ts", 100)]);

    expect(asked.length).toBeLessThan(30);
    expect(rows).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(["hunk-scan:started", "hunk-scan:complete"]);
    expect(completeOf(events).status).toBe("failed");
    expect(await persisted(db, "sha-1")).toEqual({ headSha: "sha-1", status: "failed", rows: [] });
  });

  it("treats a missing answer as a failed call, not a zero", async () => {
    const db = makeDb();
    const { events } = await scan(db, stubJev({ omit: "vulnerability" }).layer, "sha-1");
    expect(completeOf(events).status).toBe("failed");
  });

  it("never reruns a scan that ended, so a walkthrough resume goes straight to the agent", async () => {
    for (const failAfter of [undefined, 1, 0]) {
      const db = makeDb();
      await scan(db, stubJev(failAfter === undefined ? {} : { failAfter }).layer, "sha-1");
      const before = await persisted(db, "sha-1");

      const { layer, asked } = stubJev();
      const { rows, events } = await scan(db, layer, "sha-1");
      expect(asked).toHaveLength(0);
      expect(events).toEqual([]);
      expect(rows).toEqual(before.rows);
      expect(await persisted(db, "sha-1")).toEqual(before);
    }
  });

  it("tries a failed scan again when asked, as the review page reopening does", async () => {
    const db = makeDb();
    await scan(db, stubJev({ failAfter: 0 }).layer, "sha-1");
    expect((await persisted(db, "sha-1")).status).toBe("failed");

    const { rows, events } = await scan(db, stubJev().layer, "sha-1", FILES, true);
    expect(completeOf(events).status).toBe("complete");
    expect(rows.every((r) => r.signals !== null)).toBe(true);
    expect(await persisted(db, "sha-1")).toEqual({ headSha: "sha-1", status: "complete", rows });
  });

  it("asks again what a partial scan left unscanned when asked, as the review page reopening does", async () => {
    const db = makeDb();
    await scan(db, stubJev({ failAfter: 1 }).layer, "sha-1");
    const before = await persisted(db, "sha-1");
    expect(before.status).toBe("partial");
    const unscanned = before.rows.filter((r) => r.skipReason === "unscanned").length;
    expect(unscanned).toBeGreaterThan(0);

    const { layer, asked } = stubJev();
    const { rows, events } = await scan(db, layer, "sha-1", FILES, true);
    // The hunk answered the first time comes from the cache.
    expect(asked).toHaveLength(unscanned);
    expect(completeOf(events).status).toBe("complete");
    expect(rows.every((r) => r.signals !== null && r.skipReason === null)).toBe(true);
  });

  it("rebuilds a scan seeded from a stale diff, keeping the answers that still apply", async () => {
    const db = makeDb();
    await scan(db, stubJev().layer, "sha-1");

    // Same head, but the first run saw an older diff of src/b.ts.
    const fixed = [fileOf("src/a.ts", 2), fileOf("src/b-renamed.ts", 1)];
    const { layer, asked } = stubJev();
    const { rows, events } = await scan(db, layer, "sha-1", fixed);
    expect(asked).toHaveLength(1);
    expect(completeOf(events).status).toBe("complete");
    expect(rows.map((r) => r.filePath).sort()).toEqual([
      "src/a.ts",
      "src/a.ts",
      "src/b-renamed.ts",
    ]);
    expect((await persisted(db, "sha-1")).rows).toEqual(rows);
  });

  it("picks up a scan cut off mid-run, asking only what it never reached", async () => {
    const db = makeDb();
    // What a `kill -9` right after the first answer leaves: seeded, `running`, one row answered.
    await cutOff(db, "sha-1");
    const cut = await persisted(db, "sha-1");
    expect(cut.status).toBe("running");
    const answered = cut.rows[0];
    if (!answered) throw new Error("seeded rows expected");
    await Effect.runPromise(
      Effect.gen(function* () {
        const cutScan = yield* getHunkScan({ prId: PR, headSha: "sha-1" });
        if (!cutScan) throw new Error("scan row expected");
        yield* recordHunkSignals(cutScan.id, answered.filePath, answered.hunkIndex, {
          ...QUIET,
          slop: 0.9,
        });
      }).pipe(Effect.provide(withDb(db))),
    );

    const { layer, asked } = stubJev();
    const { rows, events } = await scan(db, layer, "sha-1");
    expect(asked).toHaveLength(2);
    expect(events[0]?.type).toBe("hunk-scan:started");
    expect(completeOf(events).status).toBe("complete");
    const kept = rows.find(
      (r) => r.filePath === answered.filePath && r.hunkIndex === answered.hunkIndex,
    );
    expect(kept?.signals?.slop).toBe(0.9);
  });

  it("ends a cut-off scan cleanly when Jev is switched off before the resume", async () => {
    const db = makeDb();
    await cutOff(db, "sha-1");
    expect((await persisted(db, "sha-1")).status).toBe("running");

    const { layer, asked } = stubJev({ available: false });
    const { events } = await scan(db, layer, "sha-1");
    expect(asked).toHaveLength(0);
    expect(completeOf(events).status).toBe("failed");
    expect(await persisted(db, "sha-1")).toEqual({ headSha: "sha-1", status: "failed", rows: [] });
  });

  it("reads a long hunk in windows and keeps the strongest answer", async () => {
    const db = makeDb();
    const lines = Array.from({ length: 1200 }, (_, i) => `+const line_${i} = "${"x".repeat(20)}";`);
    lines[1100] = "+eval(userInput);";
    const big: FileLike = {
      filename: "src/generated-looking.ts",
      status: "added",
      additions: lines.length,
      deletions: 0,
      patch: `@@ -0,0 +1,${lines.length} @@\n${lines.join("\n")}`,
    };
    const { layer, asked } = stubJev({
      score: (q, patch) => (q === "vulnerability" && patch.includes("eval(") ? 0.95 : 0.1),
    });
    const { rows } = await scan(db, layer, "sha-1", [big]);

    expect(asked.length).toBeGreaterThan(2);
    expect(asked.every((patch) => patch.startsWith("@@ -0,0 +1,1200 @@"))).toBe(true);
    // The eval sits near the end — past what a single call could hold.
    expect(asked[0]).not.toContain("eval(");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.signals?.vulnerability).toBe(0.95);
  });

  it("serves a hunk already judged under another head from the cache", async () => {
    const db = makeDb();
    await scan(db, stubJev().layer, "sha-1");

    const { layer, asked } = stubJev();
    const { rows } = await scan(db, layer, "sha-2");
    expect(asked).toHaveLength(0);
    expect(rows.every((r) => r.signals?.slop === 0.8)).toBe(true);
  });

  it("asks about redundant tests only in test files", async () => {
    const db = makeDb();
    const { layer, questionsByPath } = stubJev();
    const { rows } = await scan(db, layer, "sha-1", [...FILES, fileOf("src/a.test.ts", 1)]);

    expect(questionsByPath.get("src/a.test.ts")).toContain("redundant_test");
    expect(questionsByPath.get("src/a.ts")).not.toContain("redundant_test");
    const byPath = (path: string) => rows.find((r) => r.filePath === path)?.signals;
    expect(byPath("src/a.test.ts")?.redundant_test).toBe(0.1);
    // Not a test, so not a redundant one — without spending a question on it.
    expect(byPath("src/a.ts")?.redundant_test).toBe(0);
  });
});

describe("HunkScanService", () => {
  it("runs one scan per head when the review page and a walkthrough ask at once", async () => {
    const db = makeDb();
    const { layer, asked } = stubJev();
    const service = HunkScanServiceLive.pipe(
      Layer.provide(Layer.mergeAll(CacheServiceLive, layer, withDb(db), BroadcasterLive)),
    );
    const input = { prId: PR, headSha: "sha-1", files: FILES, filePriorities: null };
    const [fromPage, fromJob] = await Effect.runPromise(
      Effect.gen(function* () {
        const hunkScan = yield* HunkScanService;
        yield* hunkScan.start(input);
        return yield* Effect.all([hunkScan.run(input), hunkScan.run(input)], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(service)),
    );
    expect(asked).toHaveLength(3);
    expect(fromJob).toEqual(fromPage);
    expect(fromJob?.every((r) => r.signals !== null)).toBe(true);
  });

  it("lets a walkthrough go ahead past the join budget while the scan carries on", async () => {
    const db = makeDb();
    const gate = Effect.runSync(Deferred.make<void>());
    const { layer } = stubJev({ gate: Deferred.await(gate) });
    const service = HunkScanServiceLive.pipe(
      Layer.provide(Layer.mergeAll(CacheServiceLive, layer, withDb(db), BroadcasterLive)),
    );
    const input = { prId: PR, headSha: "sha-1", files: FILES, filePriorities: null };
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const hunkScan = yield* HunkScanService;
        const joined = yield* Effect.fork(hunkScan.run(input));
        yield* TestClock.adjust(HUNK_SCAN_JOIN_BUDGET_MS);
        return yield* Fiber.join(joined);
      }).pipe(Effect.provide(service), Effect.provide(TestContext.TestContext)),
    );
    // Seeded, none answered yet: the agent gets no leads rather than waiting.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.signals === null)).toBe(true);
    expect((await persisted(db, "sha-1")).status).toBe("running");
  });
});
