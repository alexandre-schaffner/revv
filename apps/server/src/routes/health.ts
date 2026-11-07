import type { RuntimeHealth } from "@revv/shared";
import { Elysia } from "elysia";
import { SOURCE_COMMIT } from "../build-info";
import { serverEnv } from "../config";

export const healthRoute = new Elysia().get(
  "/api/health",
  (): RuntimeHealth => ({
    status: "ok",
    channel: serverEnv.channel,
    commit: SOURCE_COMMIT,
    port: serverEnv.port,
    timestamp: new Date().toISOString(),
  }),
);
