import { ManagedRuntime } from "effect";
import { AppLayer } from "./services/AppLayer";

export const AppRuntime = ManagedRuntime.make(AppLayer);
