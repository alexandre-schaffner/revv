import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("$lib/api/base-url", () => ({ API_BASE_URL: "http://test" }));
mock.module("$lib/session/token.svelte", () => ({
  authHeaders: () => ({ Authorization: "Bearer t" }),
}));

const { SseFrameError, SseHttpError, SseIdleError, streamSse } = await import("./sse-stream");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
    const encoder = new TextEncoder();
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      let beats = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const timer = setInterval(() => {
            beats += 1;
            if (beats < 5) return controller.enqueue(encoder.encode(": ping\n\n"));
            clearInterval(timer);
            controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
            controller.close();
          }, 10);
          init.signal?.addEventListener("abort", () => clearInterval(timer));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    expect(await collect({ idleTimeoutMs: 30 })).toEqual([{ ok: true }]);
  });

  it("rejects with AbortError when the caller aborts", async () => {
    respondWith([], { hang: true });
    const ctrl = new AbortController();
    const pending = collect({ signal: ctrl.signal, idleTimeoutMs: null }).catch((e: unknown) => e);
    ctrl.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
  });
});
