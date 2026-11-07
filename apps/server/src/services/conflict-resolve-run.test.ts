import { describe, expect, it } from "bun:test";
import type { ResolveFrame } from "@revv/shared";
import { Deferred, Effect } from "effect";
import type { RawChatStreamFrame } from "../ai/providers/chat-types";
import { createResolveRuns } from "./conflict-resolve-run";

type Pushed = { readonly branch: string };
type Frame = ResolveFrame<Pushed>;

/** An agent that says one thing, then works until its signal is aborted. */
function agentUntilAborted(signal: AbortSignal): ReadableStream<RawChatStreamFrame> {
  return new ReadableStream<RawChatStreamFrame>({
    start(controller) {
      controller.enqueue({ kind: "text", data: "working" });
      if (signal.aborted) controller.error(signal.reason);
      else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
}

async function drain(
  stream: ReadableStream<Frame>,
  onFrame: (frame: Frame) => Promise<void> = async () => {},
): Promise<Frame[]> {
  const frames: Frame[] = [];
  const reader = stream.getReader();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    frames.push(chunk.value);
    await onFrame(chunk.value);
  }
  return frames;
}

describe("a resolve run's Stop", () => {
  it("cancels the agent, backs the run out and cleans up before it answers, ending in `stopped`", async () => {
    const runs = createResolveRuns<Pushed>();
    const abort = new AbortController();
    const log: string[] = [];
    const stream = await Effect.runPromise(
      runs.start("pr-1", {
        opening: [{ kind: "status", message: "Merging…" }],
        abort,
        agent: Effect.sync(() => agentUntilAborted(abort.signal)),
        finish: () =>
          Effect.sync(() => {
            log.push("finish");
            return { kind: "result", status: "pushed", newSha: "x", branch: "b" } as const;
          }),
        backOut: Effect.sync(() => void log.push("backOut")),
        cleanup: Effect.sync(() => void log.push("cleanup")),
      }),
    );
    let stopped = false;
    let doneWhenStopAnswered: string[] = [];
    const frames = drain(stream, async (frame) => {
      if (frame.kind !== "agent-text") return;
      stopped = await Effect.runPromise(runs.stop("pr-1"));
      doneWhenStopAnswered = [...log];
    });

    expect(await frames).toEqual([
      { kind: "status", message: "Merging…" },
      { kind: "agent-text", data: "working" },
      { kind: "result", status: "stopped" },
    ]);
    expect(stopped).toBe(true);
    expect(doneWhenStopAnswered).toEqual(["backOut", "cleanup"]);
    expect(abort.signal.aborted).toBe(true);
    expect(log).toEqual(["backOut", "cleanup"]);
    expect(await Effect.runPromise(runs.stop("pr-1"))).toBe(false);
  });

  it("no longer reaches a run that is verifying or pushing", async () => {
    const runs = createResolveRuns<Pushed>();
    const abort = new AbortController();
    const finishing = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const stream = await Effect.runPromise(
      runs.start("pr-1", {
        opening: [],
        abort,
        agent: null,
        finish: () =>
          Deferred.succeed(finishing, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({ kind: "result", status: "pushed", newSha: "x", branch: "b" } as const),
          ),
        cleanup: Effect.void,
      }),
    );
    const frames = drain(stream);
    await Effect.runPromise(Deferred.await(finishing));

    expect(await Effect.runPromise(runs.stop("pr-1"))).toBe(false);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    expect(await frames).toEqual([{ kind: "result", status: "pushed", newSha: "x", branch: "b" }]);
    expect(abort.signal.aborted).toBe(false);
  });

  it("is a no-op for a PR with no run", async () => {
    const runs = createResolveRuns<Pushed>();
    expect(await Effect.runPromise(runs.stop("pr-1"))).toBe(false);
  });
});
