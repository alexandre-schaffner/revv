// A standalone machine preload for an installed Revv version predating the
// profiling layer. Bundle this file; never load it alongside the native layer.
import { Effect, ManagedRuntime } from "effect";
import { ContinuousProfilingLive } from "./profiler";

const runtime = ManagedRuntime.make(ContinuousProfilingLive);
await runtime.runPromise(Effect.void);
process.once("SIGTERM", () => {
  void runtime.dispose();
});
process.once("SIGINT", () => {
  void runtime.dispose();
});
