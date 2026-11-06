import { Layer, ManagedRuntime } from "effect";
import { BootLive } from "./boot";
import { seedOriginFromAmbient } from "./observability/github-ledger/origin";
import { ContinuousProfilingLive } from "./observability/profiler";
import { TracingLive } from "./observability/tracer";
import { AppLayer } from "./services/AppLayer";

const managed = ManagedRuntime.make(
  Layer.mergeAll(
    AppLayer,
    TracingLive,
    ContinuousProfilingLive,
    BootLive.pipe(Layer.provide(Layer.mergeAll(AppLayer, TracingLive))),
  ),
);

export type AppServices = ManagedRuntime.ManagedRuntime.Services<typeof managed>;

export const AppRuntime: Pick<
  typeof managed,
  "runPromise" | "runPromiseExit" | "runSync" | "dispose"
> = {
  runPromise: (effect, options) => managed.runPromise(seedOriginFromAmbient(effect), options),
  runPromiseExit: (effect, options) =>
    managed.runPromiseExit(seedOriginFromAmbient(effect), options),
  runSync: (effect) => managed.runSync(seedOriginFromAmbient(effect)),
  dispose: () => managed.dispose(),
};
