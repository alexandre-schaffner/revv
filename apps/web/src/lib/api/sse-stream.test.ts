import { afterEach, describe, expect, it, jest, mock } from "bun:test";
import { tokenStub } from "$lib/test-stubs";

mock.module("$lib/api/base-url", () => ({ API_BASE_URL: "http://test" }));
mock.module("$lib/session/token.svelte", tokenStub);

const { SseFrameError, SseHttpError, SseIdleError, sseError, sseErrorMessage, streamSse } =
  await import("./sse-stream");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.useRealTimers();
});

/** Lets the stream read whatever has been enqueued so far. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A response whose body yields `chunks` and then, unless `hang`, closes. */
function respondWith(chunks: string[], opts: { hang?: boolean } = {}): RequestInit[] {
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requests.push(init);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        if (!opts.hang) controller.close();
        init.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError")),
        );
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  return requests;
}

async function collect(
  opts: Partial<Parameters<typeof streamSse<unknown>>[0]> = {},
): Promise<unknown[]> {
  const events: unknown[] = [];
  await streamSse<unknown>({ path: "/s", onEvent: (e) => void events.push(e), ...opts });
  return events;
}

describe("streamSse", () => {
  it("delivers frames split across chunks and stops at [DONE]", async () => {
    respondWith(['data: {"a":1}\n\nda', 'ta: {"a":2}\n\n: keepalive\n\n', "data: [DONE]\n\n"]);
    expect(await collect()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("flushes a frame left unterminated when the stream closes", async () => {
    respondWith(['data: {"a":1}\n\ndata: {"a":2}']);
    expect(await collect()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("delivers frames ahead of an error frame, then rejects with its payload", async () => {
    respondWith([
      'data: {"a":1}\n\nevent: error\ndata: {"code":"GENERATION_ERROR","message":"boom"}\n\n',
    ]);
    const events: unknown[] = [];
    const err = await streamSse<unknown>({ path: "/s", onEvent: (e) => void events.push(e) }).catch(
      (e: unknown) => e,
    );
    expect(events).toEqual([{ a: 1 }]);
    expect(err).toBeInstanceOf(SseFrameError);
    expect(err).toMatchObject({ code: "GENERATION_ERROR", message: "boom" });
  });

  it("rejects a non-OK response with the server's message", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: "NOPE", message: "Refused" }), {
        status: 409,
      })) as unknown as typeof fetch;
    const err = await collect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SseHttpError);
    expect(err).toMatchObject({ status: 409, message: "Refused", body: { code: "NOPE" } });

    globalThis.fetch = (async () =>
      new Response("oops", { status: 502 })) as unknown as typeof fetch;
    expect(await collect().catch((e: unknown) => e)).toMatchObject({
      message: "HTTP 502",
      serverMessage: undefined,
    });
  });

  it("sends auth and a JSON body", async () => {
    const requests = respondWith(["data: [DONE]\n\n"]);
    await collect({ method: "POST", body: { x: 1 } });
    expect(requests[0]).toMatchObject({
      method: "POST",
      body: '{"x":1}',
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    });
  });

  it("times out a silent socket even when no bytes ever arrive", async () => {
    respondWith([], { hang: true });
    const err = await collect({ idleTimeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SseIdleError);
  });

  it("keeps a stream alive while heartbeats arrive", async () => {
    jest.useFakeTimers();
    const encoder = new TextEncoder();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            init.signal?.addEventListener("abort", () =>
              controller.error(new DOMException("aborted", "AbortError")),
            );
          },
        }),
      )) as unknown as typeof fetch;
    const events: unknown[] = [];
    let settled: unknown = "open";
    const done = streamSse<unknown>({
      path: "/s",
      idleTimeoutMs: 30,
      onEvent: (e) => void events.push(e),
    }).then(
      () => (settled = "resolved"),
      (e: unknown) => (settled = e),
    );
    // Five silent-but-alive stretches of 20 ms each: 100 ms in all, past the 30 ms idle limit.
    for (let beat = 0; beat < 5; beat++) {
      await settle();
      jest.advanceTimersByTime(20);
      body?.enqueue(encoder.encode(": ping\n\n"));
    }
    await settle();
    expect(settled).toBe("open");
    body?.enqueue(encoder.encode('data: {"ok":true}\n\n'));
    body?.close();
    await done;
    expect(settled).toBe("resolved");
    expect(events).toEqual([{ ok: true }]);
  });

  it("rejects with AbortError when the caller aborts", async () => {
    respondWith([], { hang: true });
    const ctrl = new AbortController();
    const pending = collect({ signal: ctrl.signal }).catch((e: unknown) => e);
    ctrl.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });
});

describe("sseError", () => {
  it("keeps a refusal's code, details and wording", () => {
    const err = new SseHttpError(409, "Conflict", {
      code: "WORKTREE_BLOCKED",
      message: "Commit first",
      commits: ["a"],
    });
    expect(sseError(err, "Refused")).toEqual({
      code: "WORKTREE_BLOCKED",
      message: "Commit first",
      commits: ["a"],
    });
  });

  it("words a bodyless refusal with the fallback and status", () => {
    expect(sseError(new SseHttpError(500, "Internal", null), "Refused")).toEqual({
      code: "UNKNOWN",
      message: "Refused (HTTP 500)",
    });
  });

  it("maps frame errors, idle timeouts and connection drops; an abort is no error", () => {
    expect(sseError(new SseFrameError("GENERATION_ERROR", "boom"), "x")).toEqual({
      code: "GENERATION_ERROR",
      message: "boom",
    });
    expect(sseError(new SseIdleError(90_000), "x")?.code).toBe("NETWORK_ERROR");
    expect(sseErrorMessage(new TypeError("Load failed"), "x")).toMatch(/^Lost connection/);
    expect(sseErrorMessage(new DOMException("aborted", "AbortError"), "x")).toBeNull();
  });
});
