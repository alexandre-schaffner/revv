import { describe, expect, test } from "bun:test";
import { analyze, type FindingKind } from "./analyze";
import type { GitHubCall } from "./record";

let id = 0;
function call(over: Partial<GitHubCall> & { start: number; durationMs: number }): GitHubCall {
  id++;
  return {
    id,
    ttfbMs: over.durationMs,
    method: "GET",
    host: "api.github.com",
    url: `/repos/o/r/pulls/${id}`,
    op: "GET /repos/{owner}/{repo}/pulls/{n}",
    write: false,
    key: `k${id}`,
    account: "acct",
    conditional: false,
    read: `r${id}`,
    paged: false,
    status: 200,
    bytes: 1000,
    rate: null,
    error: null,
    origin: { label: "GET /api/prs/:id", kind: "request", runId: "run1" },
    inflight: 0,
    inflightBackground: 0,
    site: null,
    ...over,
  };
}

const kinds = (calls: GitHubCall[]): FindingKind[] => analyze(calls).findings.map((f) => f.kind);

describe("analyze", () => {
  test("an identical read sent while the first is in flight", () => {
    const report = analyze([
      call({
        start: 0,
        durationMs: 400,
        key: "same",
        origin: { label: "A", kind: "request", runId: "1" },
      }),
      call({
        start: 100,
        durationMs: 400,
        key: "same",
        origin: { label: "B", kind: "request", runId: "2" },
      }),
    ]);
    const finding = report.findings.find((f) => f.kind === "duplicate-inflight");
    expect(finding?.evidence[0]).toContain("A → B");
  });

  test("an identical read repeated soon after, even when it 304s", () => {
    const report = analyze([
      call({
        start: 0,
        durationMs: 300,
        key: "same",
        origin: { label: "x", kind: "request", runId: "1" },
      }),
      call({
        start: 2000,
        durationMs: 250,
        key: "same",
        status: 304,
        origin: { label: "x", kind: "request", runId: "2" },
      }),
    ]);
    const finding = report.findings.find((f) => f.kind === "duplicate-repeat");
    expect(finding?.evidence.join(" ")).toContain("1/1 came back 304");
  });

  test("writes are never duplicates", () => {
    expect(
      kinds([
        call({ start: 0, durationMs: 300, key: "same", write: true, method: "POST" }),
        call({ start: 50, durationMs: 300, key: "same", write: true, method: "POST" }),
      ]),
    ).not.toContain("duplicate-inflight");
  });

  test("calls of one run that wait for each other", () => {
    const report = analyze([
      call({ start: 0, durationMs: 300 }),
      call({ start: 300, durationMs: 300, op: "graphql A" }),
      call({ start: 600, durationMs: 300, op: "graphql B" }),
    ]);
    const finding = report.findings.find((f) => f.kind === "waterfall");
    expect(finding?.cost).toBe(600);
    expect(finding?.evidence[0]).toContain("+600ms graphql B (300ms)");
  });

  test("the same calls concurrently are no waterfall", () => {
    expect(
      kinds([
        call({ start: 0, durationMs: 300 }),
        call({ start: 5, durationMs: 300 }),
        call({ start: 10, durationMs: 300 }),
      ]),
    ).not.toContain("waterfall");
  });

  test("REST pages read one after another", () => {
    const pages = [1, 2, 3, 4].map((page) =>
      call({
        start: (page - 1) * 200,
        durationMs: 200,
        url: `/repos/o/r/pulls/1/files?per_page=100&page=${page}`,
        op: "GET /repos/{owner}/{repo}/pulls/{n}/files",
        read: "files",
        paged: page > 1,
      }),
    );
    const finding = analyze(pages).findings.find((f) => f.kind === "serial-pagination");
    expect(finding?.title).toContain("4 pages over 1 read(s)");
    expect(finding?.cost).toBe(400);
  });

  test("GraphQL cursor pages: one read, not a fan-out or a waterfall", () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      call({
        start: i * 500,
        durationMs: 500,
        op: "graphql OpenPullRequests",
        read: "open-prs",
        paged: i > 0,
      }),
    );
    const report = analyze(pages);
    expect(report.findings.map((f) => f.kind)).toEqual(["serial-pagination"]);
    expect(report.findings[0]?.cost).toBe(2500);
    expect(report.findings[0]?.fix).toContain("updatedAt");
  });

  test("one endpoint asked for many things in a run", () => {
    const calls = Array.from({ length: 6 }, (_, i) =>
      call({
        start: i,
        durationMs: 100,
        url: `/repos/o/r/pulls/${i}/reviews`,
        op: "GET /repos/{owner}/{repo}/pulls/{n}/reviews",
      }),
    );
    expect(kinds(calls)).toContain("fan-out");
  });

  test("a slow user-facing op, and the field to blame when it's GraphQL", () => {
    const report = analyze([
      call({ start: 0, durationMs: 3000, op: "graphql PrConversation" }),
      call({
        start: 10_000,
        durationMs: 2500,
        op: "graphql PrConversation",
        origin: { label: "x", kind: "request", runId: "2" },
      }),
    ]);
    const finding = report.findings.find((f) => f.kind === "slow-op");
    expect(finding?.title).toContain("p95 3000ms");
    expect(finding?.fix).toContain("mergeStateStatus");
  });

  test("slow background work is not a slow-op", () => {
    expect(
      kinds([
        call({
          start: 0,
          durationMs: 5000,
          origin: { label: "poll", kind: "background", runId: "p" },
        }),
      ]),
    ).not.toContain("slow-op");
  });

  test("user-facing calls queued behind background sweeps", () => {
    const report = analyze([
      call({
        start: 0,
        durationMs: 200,
        ttfbMs: 200,
        origin: { label: "x", kind: "request", runId: "1" },
      }),
      call({
        start: 1000,
        durationMs: 900,
        ttfbMs: 900,
        inflightBackground: 4,
        origin: { label: "x", kind: "request", runId: "2" },
      }),
    ]);
    const finding = report.findings.find((f) => f.kind === "contention");
    expect(finding?.cost).toBe(700);
  });

  test("rate budget burned, per origin, an hour at a time", () => {
    const rate = (used: number, reset = 1000) => ({
      resource: "graphql",
      remaining: 5000 - used,
      used,
      limit: 5000,
      reset,
    });
    const report = analyze([
      call({
        start: 0,
        durationMs: 10,
        rate: rate(100),
        origin: { label: "poll", kind: "background", runId: "p" },
      }),
      call({
        start: 100,
        durationMs: 10,
        rate: rate(104),
        origin: { label: "poll", kind: "background", runId: "p" },
      }),
      call({
        start: 200,
        durationMs: 10,
        rate: rate(105),
        origin: { label: "page", kind: "request", runId: "q" },
      }),
      // A new hour: its first answer sets the baseline, the next one is charged.
      call({
        start: 300,
        durationMs: 10,
        rate: rate(2, 2000),
        origin: { label: "page", kind: "request", runId: "q" },
      }),
      call({
        start: 400,
        durationMs: 10,
        rate: rate(4, 2000),
        origin: { label: "page", kind: "request", runId: "q" },
      }),
    ]);
    expect(report.rate[0]?.used).toBe(7);
    expect(report.rate[0]?.byOrigin).toEqual([
      { label: "poll", used: 4 },
      { label: "page", used: 3 },
    ]);
  });

  test("answers arriving out of order inside one hour don't read as new hours", () => {
    const rate = (used: number) => ({
      resource: "graphql",
      remaining: 5000 - used,
      used,
      limit: 5000,
      reset: 1000,
    });
    // Concurrent pages: GitHub counted 101..106, the answers landed shuffled.
    const report = analyze(
      [103, 101, 106, 102, 105, 104].map((used, i) =>
        call({ start: i, durationMs: 10, rate: rate(used) }),
      ),
    );
    expect(report.rate[0]?.used).toBe(5);
  });

  test("REST deltas past one point a call belong to other clients on the token", () => {
    const rate = (used: number) => ({
      resource: "core",
      remaining: 5000 - used,
      used,
      limit: 5000,
      reset: 1000,
    });
    const report = analyze([
      call({ start: 0, durationMs: 10, rate: rate(10) }),
      call({ start: 100, durationMs: 10, rate: rate(11) }),
      call({ start: 200, durationMs: 10, rate: rate(60) }),
    ]);
    expect([report.rate[0]?.used, report.rate[0]?.outside]).toEqual([2, 48]);
  });

  test("findings come most costly first", () => {
    const report = analyze([
      call({ start: 0, durationMs: 3000, op: "graphql Slow" }),
      call({ start: 0, durationMs: 100, key: "dup" }),
      call({ start: 10, durationMs: 100, key: "dup" }),
    ]);
    const costs = report.findings.map((f) => f.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(report.findings[0]?.kind).toBe("slow-op");
  });
});
