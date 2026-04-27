import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectedWorkspace, Workspace } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { workspaces } from "../db/schema/index";
import { NotFoundError, ValidationError } from "../domain/errors";
import { DbService } from "./Db";

// ── Constants ─────────────────────────────────────────────────────────────────

const SCAN_DEPTH = 2;
const COMMON_PARENTS = [
  join(homedir(), "dev"),
  join(homedir(), "projects"),
  join(homedir(), "code"),
  join(homedir(), "src"),
  join(homedir(), "workspace"),
  join(homedir(), "Work"),
  join(homedir(), "Repositories"),
  join(homedir(), "repos"),
  homedir(),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function isGitRepo(dirPath: string): boolean {
  return existsSync(join(dirPath, ".git"));
}

function scanForGitRepos(rootPath: string, depth: number): DetectedWorkspace[] {
  const results: DetectedWorkspace[] = [];

  if (!existsSync(rootPath)) return results;

  try {
    const entries = readdirSync(rootPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = join(rootPath, entry.name);

      if (isGitRepo(fullPath)) {
        results.push({
          path: fullPath,
          name: entry.name,
          isGitRepo: true,
        });
      } else if (depth > 0) {
        results.push(...scanForGitRepos(fullPath, depth - 1));
      }
    }
  } catch {
    // Permission errors or unreadable dirs — skip silently
  }

  return results;
}

function rowToWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    addedAt: row.addedAt,
    lastOpenedAt: row.lastOpenedAt ?? null,
  };
}

// ── Service definition ───────────────────────────────────────────────────────

export class WorkspaceService extends Context.Tag("WorkspaceService")<
  WorkspaceService,
  {
    /** Scan common directories for git repositories. */
    readonly detectWorkspaces: () => Effect.Effect<DetectedWorkspace[]>;
    /** List all saved workspaces. */
    readonly listWorkspaces: () => Effect.Effect<Workspace[], never, DbService>;
    /** Add a workspace by path. */
    readonly addWorkspace: (
      path: string,
    ) => Effect.Effect<Workspace, ValidationError, DbService>;
    /** Remove a workspace. */
    readonly removeWorkspace: (
      id: string,
    ) => Effect.Effect<void, NotFoundError, DbService>;
    /** Update last opened timestamp. */
    readonly touchWorkspace: (
      id: string,
    ) => Effect.Effect<void, NotFoundError, DbService>;
  }
>() {}

// ── Live implementation ─────────────────────────────────────────────────────

export const WorkspaceServiceLive = Layer.succeed(WorkspaceService, {
  detectWorkspaces: () =>
    Effect.sync(() => {
      const seen = new Set<string>();
      const results: DetectedWorkspace[] = [];

      for (const parent of COMMON_PARENTS) {
        const found = scanForGitRepos(parent, SCAN_DEPTH);
        for (const ws of found) {
          if (!seen.has(ws.path)) {
            seen.add(ws.path);
            results.push(ws);
          }
        }
      }

      // Sort by name for stable ordering
      results.sort((a, b) => a.name.localeCompare(b.name));
      return results;
    }),

  listWorkspaces: () =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const rows = db.select().from(workspaces).all();
      return rows.map(rowToWorkspace);
    }),

  addWorkspace: (path) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;

      if (!existsSync(path)) {
        return yield* Effect.fail(
          new ValidationError({ message: `Path does not exist: ${path}` }),
        );
      }

      const name = path.split("/").pop() || path;
      const id = crypto.randomUUID();
      const addedAt = new Date().toISOString();

      const row = {
        id,
        name,
        path,
        addedAt,
      } satisfies typeof workspaces.$inferInsert;

      yield* Effect.tryPromise({
        try: () => Promise.resolve(db.insert(workspaces).values(row).run()),
        catch: (e) =>
          new ValidationError({
            message: e instanceof Error ? e.message : String(e),
          }),
      });

      return rowToWorkspace({
        ...row,
        lastOpenedAt: null,
      });
    }),

  removeWorkspace: (id) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .get();
      if (!existing) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "workspace", id }),
        );
      }
      yield* Effect.try({
        try: () => db.delete(workspaces).where(eq(workspaces.id, id)).run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
    }),

  touchWorkspace: (id) =>
    Effect.gen(function* () {
      const { db } = yield* DbService;
      const existing = db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .get();
      if (!existing) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "workspace", id }),
        );
      }
      const lastOpenedAt = new Date().toISOString();
      yield* Effect.try({
        try: () =>
          db
            .update(workspaces)
            .set({ lastOpenedAt })
            .where(eq(workspaces.id, id))
            .run(),
        catch: (e) => new Error(String(e)),
      }).pipe(Effect.orDie);
    }),
});
