import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createDb, type Db } from "../db/index";
import { account, remoteUsers, repositories, user } from "../db/schema";
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

  it("serves the owner's cached avatar for its host, never another host's", async () => {
    const db = createDb(":memory:");
    seedAccount(db);
    db.insert(remoteUsers)
      .values([
        {
          id: "ru-ghe",
          provider: "github",
          providerUserId: "",
          host: "ghe.example.com",
          login: "acme",
          avatarContent: "data:image/png;base64,ghe",
        },
        {
          id: "ru-public",
          provider: "github",
          providerUserId: "",
          host: "github.com",
          login: "acme",
          avatarContent: "data:image/png;base64,public",
        },
      ])
      .run();

    const repo = await addRepo(db, { avatarUrl: "https://example.com/raw.png" });

    expect(repo.avatarUrl).toBe("data:image/png;base64,public");
  });

  it("falls back to the raw URL on github.com before the avatar is cached", async () => {
    const db = createDb(":memory:");
    seedAccount(db);

    const repo = await addRepo(db, { avatarUrl: "https://example.com/raw.png" });

    expect(repo.avatarUrl).toBe("https://example.com/raw.png");
  });
});

describe("RepositoryService failures", () => {
  const run = <A, E>(
    db: Db,
    f: (svc: typeof RepositoryService.Service) => Effect.Effect<A, E, DbService>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* RepositoryService);
      }).pipe(
        Effect.result,
        Effect.provide(RepositoryServiceLive),
        Effect.provide(Layer.succeed(DbService, { db })),
      ),
    );

  it("reports a failed insert as a DbError, not a client mistake", async () => {
    const db = createDb(":memory:");
    const result = await run(db, (svc) =>
      svc.addRepo(
        {
          provider: "github",
          owner: "acme",
          name: "web",
          fullName: "acme/web",
          defaultBranch: "main",
          avatarUrl: null,
          githubHost: "github.com",
        },
        "no-such-account",
      ),
    );
    expect(result._tag === "Failure" && result.failure._tag).toBe("DbError");
  });

  it("refuses to delete another account's repository", async () => {
    const db = createDb(":memory:");
    seedAccount(db);
    const repo = await addRepo(db);
    const result = await run(db, (svc) => svc.deleteRepo(repo.id, "acc-2"));
    expect(result._tag === "Failure" && result.failure._tag).toBe("NotFoundError");
    expect(db.select().from(repositories).all()).toHaveLength(1);
  });
});
