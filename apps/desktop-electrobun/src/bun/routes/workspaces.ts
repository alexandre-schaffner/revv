import { eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../db";
import { workspaceTable } from "../db/schema";
import { getGitBranch, getWorktreeCount } from "../lib/git";

export const workspaceRoutes = new Elysia({ prefix: "/api/workspaces" })
  .get("/", async () => {
    return db.select().from(workspaceTable).all();
  })
  .post(
    "/",
    async ({ body }) => {
      const [workspace] = await db
        .insert(workspaceTable)
        .values(body)
        .returning();
      return workspace;
    },
    {
      body: t.Object({
        id: t.String(),
        name: t.String(),
        path: t.String(),
        branch: t.Optional(t.Nullable(t.String())),
        worktreeCount: t.Optional(t.Nullable(t.Number())),
      }),
    },
  )
  .delete("/:id", async ({ params }) => {
    await db.delete(workspaceTable).where(eq(workspaceTable.id, params.id));
    return { success: true };
  })
  .get("/:id/git-meta", async ({ params, set }) => {
    const workspace = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, params.id))
      .get();
    if (!workspace) {
      set.status = 404;
      return { error: "Not found" };
    }
    const branch = await getGitBranch(workspace.path);
    const worktreeCount = await getWorktreeCount(workspace.path);
    return { branch, worktreeCount };
  })
  .post("/:id/refresh-git", async ({ params, set }) => {
    const workspace = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, params.id))
      .get();
    if (!workspace) {
      set.status = 404;
      return { error: "Not found" };
    }
    const branch = await getGitBranch(workspace.path);
    const worktreeCount = await getWorktreeCount(workspace.path);
    await db
      .update(workspaceTable)
      .set({ branch, worktreeCount, updatedAt: new Date() })
      .where(eq(workspaceTable.id, params.id));
    return { branch, worktreeCount };
  });
