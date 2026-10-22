import { expect, test } from "bun:test";
import { compare, type Measurement, measurement, rankCandidates, summaries } from "./model";
import { hotFrames } from "./profiles";

const operation = {
  name: "same-operation",
  serviceName: "server",
  category: "internal",
  count: 20,
  p50: 20,
  p95: 100,
  max: 150,
  avgMs: 30,
  errorCount: 0,
  errorRate: 0,
};
test("rankings preserve process identity and do not treat missing history as a regression", () => {
  const rows = rankCandidates(
    [operation, { ...operation, serviceName: "agent", avgMs: 100 }],
    [{ ...operation, p95: 50 }],
  );
  expect(rows[0]).toMatchObject({
    serviceName: "agent",
    p95ChangePercent: null,
    aggregateSpanMs: 2000,
  });
  expect(rows[1]).toMatchObject({
    serviceName: "server",
    p95ChangePercent: 100,
    reason: "tail-latency-increase",
  });
  expect(rankCandidates([{ ...operation, count: 1 }], [])).toEqual([]);
});

const baseline: Measurement = {
  version: 1,
  workload: "fixture-v1",
  fixtureHash: "fixture",
  outputHash: "result",
  batch: 20,
  warmups: 5,
  profiled: false,
  runtime: "test",
  machine: "test-machine",
  samplesMs: Array(25).fill(100),
};
test("accepts separated improvements and flags regressions", () => {
  expect(compare(baseline, { ...baseline, samplesMs: Array(25).fill(75) }).verdict).toBe(
    "improved",
  );
  expect(compare(baseline, { ...baseline, samplesMs: Array(25).fill(120) }).verdict).toBe(
    "regressed",
  );
  expect(compare(baseline, { ...baseline, samplesMs: Array(25).fill(98) }).verdict).toBe(
    "inconclusive",
  );
});
test("refuses mismatched workloads, output changes, sampler overhead and noise", () => {
  expect(() => compare(baseline, { ...baseline, fixtureHash: "different" })).toThrow("fixtureHash");
  expect(() => compare(baseline, { ...baseline, outputHash: "incorrect" })).toThrow("outputHash");
  expect(() => compare(baseline, { ...baseline, runtime: "different" })).toThrow("runtime");
  expect(() => compare(baseline, { ...baseline, profiled: true })).toThrow("unprofiled");
  expect(
    compare(baseline, { ...baseline, samplesMs: Array.from({ length: 25 }, (_, i) => i + 1) })
      .verdict,
  ).toBe("inconclusive");
  expect(() => measurement({ ...baseline, samplesMs: [1] })).toThrow("15");
  expect(() => summaries([{ ...operation, p95: Number.NaN }])).toThrow("finite");
});

test("decodes dictionary profile labels and aggregates self weights without summing parents", () => {
  const frame = {
    schema: {
      fields: [
        { name: "self" },
        { name: "label", type: "enum", config: { type: { enum: { text: ["root", "hot"] } } } },
      ],
    },
    data: {
      values: [
        [0, 20, 30],
        [0, 1, 1],
      ],
    },
  };
  expect(hotFrames({ results: { A: { frames: [frame] } } })).toEqual([
    { label: "hot", sampledSelfNs: 50 },
  ]);
  expect(hotFrames({ results: { A: { frames: [] } } })).toEqual([]);
  expect(() => hotFrames({ results: { A: { error: "profile unavailable" } } })).toThrow(
    "unavailable",
  );
});
