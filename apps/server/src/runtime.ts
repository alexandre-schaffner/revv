import { Layer, ManagedRuntime } from "effect";
import { seedOriginFromAmbient } from "./observability/github-ledger/origin";
import { ContinuousProfilingLive } from "./observability/profiler";
import { TracingLive } from "./observability/tracer";
import { AppLayer } from "./services/AppLayer";

const managed = ManagedRuntime.make(Layer.mergeAll(AppLayer, TracingLive, ContinuousProfilingLive));

export const AppRuntime: Pick<typeof managed, "runPromise" | "runSync" | "dispose"> = {
  runPromise: (effect, options) => managed.runPromise(seedOriginFromAmbient(effect), options),
  runSync: (effect) => managed.runSync(seedOriginFromAmbient(effect)),
  dispose: () => managed.dispose(),
};
