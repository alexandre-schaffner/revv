import { describe, expect, it } from "bun:test";
import { openSse, pipeToSse } from "./sse";

const read = (response: Response) => response.text();

describe("openSse", () => {
  it("writes data frames and ends with [DONE]", async () => {
    const { response, channel } = openSse<{ n: number }>();
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    channel.send({ n: 1 });
    channel.done();
    expect(await read(response)).toBe('data: {"n":1}\n\ndata: [DONE]\n\n');
    expect(channel.send({ n: 2 })).toBe(false);
  });

  it("ends a failed stream with an error event", async () => {
    const { response, channel } = openSse();
    channel.fail({ code: "GENERATION_ERROR", message: "boom" });
    expect(await read(response)).toBe(
      'event: error\ndata: {"code":"GENERATION_ERROR","message":"boom"}\n\n',
    );
  });

  it("runs close hooks once, from either end, and at once after close", async () => {
    const { response, channel } = openSse();
    const calls: string[] = [];
    channel.onClose(() => calls.push("first"));
    await response.body?.cancel();
    channel.close();
    channel.onClose(() => calls.push("late"));
    expect(calls).toEqual(["first", "late"]);
    expect(channel.isClosed()).toBe(true);
  });

  it("closes when the request is aborted", () => {
    const abort = new AbortController();
    const { channel } = openSse({ signal: abort.signal });
    abort.abort();
    expect(channel.isClosed()).toBe(true);
  });
});

describe("pipeToSse", () => {
  it("frames each item, then [DONE]", async () => {
    const frames = new ReadableStream<string>({
      start(c) {
        c.enqueue("a");
        c.enqueue("b");
        c.close();
      },
    });
    expect(await read(pipeToSse(frames))).toBe('data: "a"\n\ndata: "b"\n\ndata: [DONE]\n\n');
  });

  it("reports a broken source as GENERATION_ERROR", async () => {
    let pulls = 0;
    const frames = new ReadableStream<string>({
      pull(c) {
        if (pulls++ === 0) c.enqueue("a");
        else c.error(new Error("agent died"));
      },
    });
    expect(await read(pipeToSse(frames))).toBe(
      'data: "a"\n\nevent: error\ndata: {"code":"GENERATION_ERROR","message":"agent died"}\n\n',
    );
  });

  it("cancels the source when the client leaves", async () => {
    let cancelled = false;
    const frames = new ReadableStream<string>({
      cancel() {
        cancelled = true;
      },
    });
    await pipeToSse(frames).body?.cancel();
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
  });
});
