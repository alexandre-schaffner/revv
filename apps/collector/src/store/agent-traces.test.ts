import { expect, it } from "bun:test";
import { retentionFromEnv } from "../retention";
import { TelemetryStore } from "./index";

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const span = (
  traceId: string,
  spanId: string,
  name: string,
  startMs: number,
  durationMs: number,
  attributes: ReturnType<typeof attr>[],
  parentSpanId?: string,
) => ({
  traceId,
  spanId,
  name,
  startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
  endTimeUnixNano: String(BigInt(startMs + durationMs) * 1_000_000n),
  attributes,
  ...(parentSpanId ? { parentSpanId } : {}),
});

it("round-trips native spans and joins only the matching ACP session and turn", async () => {
  const store = await TelemetryStore.open(":memory:");
  try {
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr("service.name", "revv-agent-claude-code"),
              attr("deployment.environment.name", "dev"),
            ],
          },
          scopeSpans: [
            {
              spans: [
                span("app", "prompt", "Acp.prompt", 1000, 1000, [
                  attr("gen_ai.conversation.id", "session-1"),
                ]),
                span("native", "turn", "claude_code.interaction", 1010, 900, [
                  attr("session.id", "session-1"),
                ]),
                span(
                  "native",
                  "model",
                  "claude_code.llm_request",
                  1020,
                  500,
                  [
                    attr("session.id", "session-1"),
                    attr("gen_ai.provider.name", "anthropic"),
                    attr("gen_ai.usage.input_tokens", "12"),
                  ],
                  "turn",
                ),
                span("other", "wrong-session", "claude_code.interaction", 1010, 900, [
                  attr("session.id", "session-2"),
                ]),
                span("later", "wrong-turn", "claude_code.interaction", 3000, 900, [
                  attr("session.id", "session-1"),
                ]),
              ],
            },
          ],
        },
      ],
    };
    await store.ingestOtlp(payload);
    await store.ingestOtlp(payload); // delivery retries must not duplicate spans
    const linked = await store.traceSpans("app");
    expect(linked.map((s) => s.spanId)).toEqual(["prompt", "turn", "model"]);
    expect(linked[1]).toMatchObject({ traceId: "native", parentSpanId: "prompt" });
    expect(linked[1]?.attributes["deployment.environment.name"]).toBe("dev");
    expect(linked[2]).toMatchObject({
      parentSpanId: "turn",
      provider: "anthropic",
      inputTokens: 12,
    });
    // Correlation changes only the query result, not the stored trace topology.
    expect((await store.traceSpans("native"))[0]?.parentSpanId).toBeNull();
  } finally {
    store.close();
  }
});

it("keeps two weekly windows and rejects invalid retention limits", () => {
  expect(retentionFromEnv({})).toEqual({ maxAgeMs: 14 * 86400000, maxRows: 1000000 });
  expect(
    retentionFromEnv({ COLLECTOR_RETENTION_DAYS: "30", COLLECTOR_MAX_SPANS: "2000000" }),
  ).toEqual({ maxAgeMs: 30 * 86400000, maxRows: 2000000 });
  expect(retentionFromEnv({ COLLECTOR_RETENTION_DAYS: "-1", COLLECTOR_MAX_SPANS: "NaN" })).toEqual(
    retentionFromEnv({}),
  );
});

it("honors Grafana's historical start and end times across dashboard queries", async () => {
  const store = await TelemetryStore.open(":memory:");
  try {
    await store.ingestOtlp({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span("early", "early", "other", 500, 10, []),
                {
                  ...span("selected", "selected", "WalkthroughJobs.generate", 1500, 10, []),
                  status: { code: 2 },
                },
                span("late", "late", "other", 2500, 10, []),
              ],
            },
          ],
        },
      ],
    });
    const range = { sinceMs: 1000, untilMs: 2000 };
    expect((await store.kpis(range)).spanCount).toBe(1);
    expect((await store.kpis(range)).windowMs).toBe(1000);
    expect((await store.services(range))[0]?.count).toBe(1);
    expect((await store.categories(range))[0]?.count).toBe(1);
    expect((await store.operationSummary(range))[0]?.count).toBe(1);
    expect((await store.timeseries({ ...range, bucketMs: 1000 }))[0]?.count).toBe(1);
    expect((await store.serviceTimeseries({ ...range, bucketMs: 1000 }))[0]?.count).toBe(1);
    expect(await store.recentTraces({ ...range, limit: 10 })).toHaveLength(1);
    expect(await store.generations({ ...range, limit: 10 })).toHaveLength(1);
    expect(await store.generations({ ...range, limit: 10, service: "other-service" })).toHaveLength(
      0,
    );
    expect(await store.slowestSpans({ ...range, limit: 10 })).toHaveLength(1);
    expect(await store.errorSpans({ ...range, limit: 10 })).toHaveLength(1);
  } finally {
    store.close();
  }
});

it("commits concurrent exporter batches while dashboard queries and pruning run", async () => {
  const store = await TelemetryStore.open(":memory:");
  const start = Date.now();
  try {
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        await store.ingestOtlp({
          resourceSpans: [
            {
              scopeSpans: [
                { spans: [span("parallel", `span-${index}`, "claude_code.tool", start, 10, [])] },
              ],
            },
          ],
        });
        await store.kpis({ sinceMs: start - 1 });
        await store.prune();
      }),
    );
    expect(await store.traceSpans("parallel")).toHaveLength(20);
    expect((await store.kpis({ sinceMs: start - 1 })).spanCount).toBe(20);
  } finally {
    store.close();
  }
});

it("keeps identically named operations from different services separate", async () => {
  const store = await TelemetryStore.open(":memory:");
  try {
    await store.ingestOtlp({
      resourceSpans: ["server", "agent"].map((service) => ({
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            spans: [
              span(service, service, "same.name", Date.now(), service === "server" ? 20 : 200, []),
            ],
          },
        ],
      })),
    });
    const summary = await store.operationSummary({ sinceMs: Date.now() - 1000 });
    expect(summary).toHaveLength(2);
    expect(summary.find((row) => row.serviceName === "server")?.p95).toBe(20);
    expect(summary.find((row) => row.serviceName === "agent")?.p95).toBe(200);
  } finally {
    store.close();
  }
});
