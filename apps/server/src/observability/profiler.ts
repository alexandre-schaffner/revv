import { profile } from "bun:jsc";
import { Effect, Layer, Schedule } from "effect";
import { ProfilingError } from "../domain/errors";
import { foldedStacks } from "./profile-format";

// Opt-in by destination. One sampler per process, owned by the runtime's scope.
// No inspector port, detached child, filesystem archive or unbounded send queue.
export const ContinuousProfilingLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const endpoint = process.env.REVV_PYROSCOPE_ENDPOINT;
    if (!endpoint) return;
    let target: URL;
    try {
      target = new URL("/ingest", endpoint);
      if (
        target.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
      ) {
        throw new Error("Continuous profiles require a loopback HTTP Pyroscope endpoint");
      }
    } catch (error) {
      yield* Effect.logWarning("Continuous profiling disabled: invalid destination", error);
      return;
    }
    const channel = process.env.REVV_CHANNEL === "dev" ? "dev" : "installed";
    const capture = Effect.tryPromise({
      try: async (signal) => {
        const from = Date.now();
        const data = await profile(async () => {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 30_000);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }, 10_000); // 100 Hz, one 30-second buffer at a time.
        if (signal.aborted) return;
        const until = Date.now();
        const body = foldedStacks(data.stackTraces);
        if (!body) return;
        const url = new URL(target);
        url.search = new URLSearchParams({
          name: `revv-server.cpu{channel=${channel},runtime=bun}`,
          from: String(Math.floor(from / 1000)),
          until: String(Math.ceil(until / 1000)),
          format: "collapsed",
          sampleRate: "100",
          units: "samples",
          aggregationType: "sum",
          spyName: "bun-jsc",
        }).toString();
        const response = await fetch(url, {
          method: "POST",
          body,
          headers: { "content-type": "text/plain" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new Error(`Pyroscope ingestion: HTTP ${response.status}`);
      },
      catch: (cause) => new ProfilingError({ cause }),
    }).pipe(Effect.catch((error) => Effect.logWarning("Continuous profile dropped", error)));
    yield* Effect.forkScoped(capture.pipe(Effect.repeat(Schedule.spaced("1 second"))));
  }),
);
