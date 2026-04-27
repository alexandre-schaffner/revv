import { Effect } from "effect";
import { Elysia, t } from "elysia";
import { AppRuntime } from "../runtime";
import { WorkspaceService } from "../services/Workspace";
import { handleAppError, withAuth } from "./middleware";

export const workspaceRoutes = new Elysia({ prefix: "/api/workspaces" })
  .use(withAuth)
  .get("/detect", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(WorkspaceService, (s) => s.detectWorkspaces()),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .get("/", async (ctx) => {
    try {
      return await AppRuntime.runPromise(
        Effect.flatMap(WorkspaceService, (s) => s.listWorkspaces()),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
  })
  .post(
    "/",
    async (ctx) => {
      try {
        return await AppRuntime.runPromise(
          Effect.flatMap(WorkspaceService, (s) =>
            s.addWorkspace(ctx.body.path),
          ),
        );
      } catch (e) {
        return handleAppError(e, ctx);
      }
    },
    { body: t.Object({ path: t.String() }) },
  )
  .delete("/:id", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.flatMap(WorkspaceService, (s) =>
          s.removeWorkspace(ctx.params.id),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
    return { success: true };
  })
  .post("/:id/touch", async (ctx) => {
    try {
      await AppRuntime.runPromise(
        Effect.flatMap(WorkspaceService, (s) =>
          s.touchWorkspace(ctx.params.id),
        ),
      );
    } catch (e) {
      return handleAppError(e, ctx);
    }
    return { success: true };
  });
