import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, repositories, user } from "../db/schema";
import { DbService } from "./Db";
import { RepositoryService, RepositoryServiceLive } from "./Repository";

const ACCOUNT_ID = "acc-1";

function seedAccount(db: Db): void {
  const now = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "Test",
      email: "test@example.com",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: ACCOUNT_ID,
      accountId: "gh-1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function addRepo(
  db: Db,
  data: {
    readonly managed?: boolean;
    readonly clonePath?: string | null;
    readonly defaultBranch?: string;
    readonly avatarUrl?: string | null;
  } = {},
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* RepositoryService;
      return yield* svc.addRepo(
        {
          provider: "github",
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          defaultBranch: data.defaultBranch ?? "main",
          avatarUrl: data.avatarUrl ?? null,
          githubHost: "github.com",
          ...(data.managed !== undefined ? { managed: data.managed } : {}),
          ...(data.clonePath !== undefined ? { clonePath: data.clonePath } : {}),
        },
        ACCOUNT_ID,
      );
    }).pipe(
      Effect.provide(RepositoryServiceLive),
      Effect.provide(Layer.succeed(DbService, { db })),
    ),
  );
}

describe("RepositoryService.addRepo", () => {
  it("upserts an existing repository and returns the persisted row id", async () => {
    const db = createDb(":memory:");
    seedAccount(db);

    const first = await addRepo(db);
    const relinked = await addRepo(db, {
      managed: false,
      clonePath: "/tmp/acme-web",
      defaultBranch: "develop",
      avatarUrl: "https://example.com/avatar.png",
    });

    expect(relinked.id).toBe(first.id);
    expect(relinked.managed).toBe(false);
    expect(relinked.cloneStatus).toBe("pending");
    expect(relinked.clonePath).toBe("/tmp/acme-web");
    expect(relinked.cloneError).toBeNull();
    expect(relinked.defaultBranch).toBe("develop");
    expect(relinked.avatarUrl).toBe("https://example.com/avatar.png");

    const rows = db.select().from(repositories).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
  });

  it("clears linked checkout state when re-added as a managed clone", async () => {
    const db = createDb(":memory:");
    seedAccount(db);

    const linked = await addRepo(db, { managed: false, clonePath: "/tmp/acme-web" });
    db.update(repositories).set({ cloneStatus: "ready", cloneError: "stale error" }).run();

    const managed = await addRepo(db, { managed: true });

    expect(managed.id).toBe(linked.id);
    expect(managed.managed).toBe(true);
    expect(managed.cloneStatus).toBe("pending");
    expect(managed.clonePath).toBeNull();
    expect(managed.cloneError).toBeNull();
  });
});
