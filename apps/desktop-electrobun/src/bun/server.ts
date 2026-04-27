import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { db } from "./db";
import { workspaceRoutes } from "./routes/workspaces";

export function createElysiaServer(port: number) {
  const app = new Elysia()
    .use(cors({ origin: /localhost/ }))
    .decorate("db", db)
    .use(workspaceRoutes)
    .get("/api/health", () => ({
      status: "ok" as const,
      timestamp: new Date().toISOString(),
    }));

  app.listen(port);
  return app;
}

export type ElysiaApp = ReturnType<typeof createElysiaServer>;
