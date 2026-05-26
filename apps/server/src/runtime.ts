import { Layer, ManagedRuntime } from "effect";
import { TracingLive } from "./observability/tracer";
import { AppLayer } from "./services/AppLayer";

export const AppRuntime = ManagedRuntime.make(Layer.mergeAll(AppLayer, TracingLive));
