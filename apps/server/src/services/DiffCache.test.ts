import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db";
import { prDiffFiles } from "../db/schema";
import { GitHubAuthError, GitHubRateLimitError } from "../domain/errors";
import { DbService } from "./Db";
import {
  type CachedDiffFile,
  DiffCacheService,
  DiffCacheServiceLive,
  hasCompleteCachedFiles,
  shouldServeCachedFilesOnFetchError,
} from "./DiffCache";
import { PR_FILES_MAX_COUNT } from "./GitHub";

function cachedFile(path: string): CachedDiffFile {
  return {
    path,
    oldPath: null,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function cacheFiles(db: Db, prId: string, files: CachedDiffFile[]): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* DiffCacheService;
      yield* service.cacheFiles(prId, files);
    }).pipe(Effect.provide(DiffCacheServiceLive), Effect.provide(Layer.succeed(DbService, { db }))),
  );
}

describe("hasCompleteCachedFiles", () => {
  it("accepts cached files when no expected count is available", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")])).toBe(true);
  });

  it("rejects cached files below the PR changed-files count", () => {
    expect(hasCompleteCachedFiles([cachedFile("src/a.ts")], 2)).toBe(false);
  });

  it("caps the expected count to the GitHub files endpoint range", () => {
    const files = Array.from({ length: PR_FILES_MAX_COUNT }, (_, i) => cachedFile(`src/${i}.ts`));
    expect(hasCompleteCachedFiles(files, PR_FILES_MAX_COUNT + 1)).toBe(true);
  });
});

describe("shouldServeCachedFilesOnFetchError", () => {
  it("serves existing cached files when GitHub rate-limits the refresh", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(true);
  });

  it("does not mask rate limits when there is no cache to render", () => {
    const error = new GitHubRateLimitError({
      resetAt: new Date("2026-01-01T00:01:00.000Z"),
      kind: "primary",
    });

    expect(shouldServeCachedFilesOnFetchError(null, error)).toBe(false);
  });

  it("does not serve cached files for non-rate-limit GitHub errors", () => {
    const cached = [cachedFile("src/a.ts")];
    const error = new GitHubAuthError({ message: "Invalid or expired GitHub token" });

    expect(shouldServeCachedFilesOnFetchError(cached, error)).toBe(false);
  });
});

describe("cacheFiles", () => {
  it("is idempotent for duplicate rows with the same deterministic id", async () => {
    const db = createDb(":memory:");
    const sqlite = (db as unknown as { session: { client: { run: (sql: string) => void } } })
      .session.client;
    sqlite.run("PRAGMA foreign_keys = OFF");

    const first = cachedFile("src/a.ts");
    const second: CachedDiffFile = {
      ...first,
      oldPath: "src/old-a.ts",
      additions: 3,
      patch: "@@ second",
      fetchedAt: "2026-01-01T00:01:00.000Z",
    };

    await cacheFiles(db, "pr-1", [first, second]);

    const rows = db.select().from(prDiffFiles).where(eq(prDiffFiles.prId, "pr-1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe("src/a.ts");
    expect(rows[0]?.oldPath).toBe("src/old-a.ts");
    expect(rows[0]?.additions).toBe(3);
    expect(rows[0]?.patch).toBe("@@ second");
  });
});
