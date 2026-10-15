import { expect, spyOn, test } from "bun:test";
import { createCollectorApp } from "./app";
import { TelemetryStore } from "./store";

const validSpan = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  name: "test.write",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000010000000",
};
const payload = (spans: unknown[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const ingest = (body: unknown, origin?: string) =>
  new Request("http://localhost:45680/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

test("allows local clients and Grafana while rejecting foreign origins and DNS rebinding", async () => {
  const store = await TelemetryStore.open(":memory:");
  try {
    const app = createCollectorApp(store, "http://localhost:3000");
    for (const origin of [
      "https://attacker.example",
      "null",
      "http://localhost:5173.attacker.example",
    ]) {
      const response = await app.handle(ingest(payload([validSpan]), origin));
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).not.toBe(origin);
      expect(
        (await app.handle(new Request("http://localhost:45680/api/slow", { headers: { origin } })))
          .status,
      ).toBe(403);
    }
    expect((await app.handle(new Request("http://attacker.example:45680/api/health"))).status).toBe(
      403,
    );
    expect((await store.traceSpans(validSpan.traceId)).length).toBe(0);
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"]) {
      const response = await app.handle(ingest(payload([validSpan]), origin));
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      const preflight = await app.handle(
        new Request("http://localhost:45680/v1/traces", {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    }
    expect(
      (await app.handle(new Request("http://host.docker.internal:45680/api/health"))).status,
    ).toBe(200);
    expect((await store.traceSpans(validSpan.traceId)).length).toBe(1);
  } finally {
    store.close();
  }
});

test("preserves valid sibling spans and reports partial rejection instead of silently losing a batch", async () => {
  const store = await TelemetryStore.open(":memory:");
  try {
    const app = createCollectorApp(store, "http://localhost:3000");
    const response = await app.handle(
      ingest(
        payload([validSpan, null, { ...validSpan, spanId: "bad", startTimeUnixNano: "invalid" }]),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedSpans: "2", errorMessage: "Malformed spans were rejected" },
    });
    expect((await store.traceSpans(validSpan.traceId)).length).toBe(1);
    for (const body of [
      null,
      {},
      { resourceSpans: [null] },
      { resourceSpans: [{ scopeSpans: {} }] },
    ]) {
      expect((await app.handle(ingest(body))).status).toBe(400);
    }
  } finally {
    store.close();
  }
});

test("returns a retryable storage error and accepts an idempotent retry after recovery", async () => {
  const store = await TelemetryStore.open(":memory:");
  const app = createCollectorApp(store, "http://localhost:3000");
  const failure = spyOn(store, "ingestOtlp").mockRejectedValueOnce(new Error("disk unavailable"));
  try {
    const response = await app.handle(ingest(payload([validSpan])));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect((await store.traceSpans(validSpan.traceId)).length).toBe(0);
    failure.mockRestore();
    for (let attempt = 0; attempt < 2; attempt++) {
      const retried = await app.handle(ingest(payload([validSpan])));
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({});
    }
    expect((await store.traceSpans(validSpan.traceId)).length).toBe(1);
  } finally {
    failure.mockRestore();
    store.close();
  }
});
