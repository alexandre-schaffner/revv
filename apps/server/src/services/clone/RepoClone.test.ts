import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Context, Effect } from "effect";
import type { Db } from "../../db/index";
import { repositories } from "../../db/schema/index";
import { addWorktree, cloneServices, git, makeClone, seedDb } from "./clone-test-support";
import { cloneLayout } from "./layout";
import { RepoCloneService } from "./RepoClone";

// Real clones on disk. Each case adopts clones made here instead of cloning
// from GitHub: a matching clone found where a clone would go is adopted.

setDefaultTimeout(60_000);

let root: string;
let base: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "revv-clone-"));
  base = join(root, "base");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const rowOf = (db: Db, id: string) =>
  db.select().from(repositories).where(eq(repositories.id, id)).get();

const clone = <A, E>(
  f: (svc: Context.Service.Shape<typeof RepoCloneService>) => Effect.Effect<A, E>,
) => Effect.flatMap(RepoCloneService, f);

describe("one folder per repository row", () => {
  it("gives two accounts tracking one repository two clones, and deleting one keeps the other", async () => {
    const layout = cloneLayout(base);
    const db = seedDb([
      { id: "repo-a", accountId: "acc-a" },
      { id: "repo-b", accountId: "acc-b" },
    ]);
    const first = layout.clonePath(base, { id: "repo-a", owner: "octo", name: "repo" });
    const second = layout.distinctClonePath(base, { id: "repo-b", owner: "octo", name: "repo" });
    makeClone(first);
    makeClone(second);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.ensureClone("repo-a")));
      await run(clone((svc) => svc.ensureClone("repo-b")));
      expect(rowOf(db, "repo-a")).toMatchObject({ clonePath: first, cloneStatus: "ready" });
      expect(rowOf(db, "repo-b")).toMatchObject({ clonePath: second, cloneStatus: "ready" });

      await run(clone((svc) => svc.deleteClone("repo-a")));
      expect(existsSync(first)).toBe(false);
      expect(existsSync(join(second, "README.md"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("never deletes a clone another row still uses", async () => {
    const shared = join(base, "octo", "repo");
    makeClone(shared);
    const db = seedDb([
      { id: "repo-a", accountId: "acc-a", clonePath: shared, cloneStatus: "ready" },
      { id: "repo-b", accountId: "acc-b", clonePath: shared, cloneStatus: "ready" },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.deleteClone("repo-a")));
      expect(existsSync(join(shared, "README.md"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("keeps a refused destination the user chose for the retry, and never deletes it", async () => {
    const chosen = join(root, "code");
    const dest = join(chosen, "octo", "repo");
    makeClone(dest, "octo/other");
    const db = seedDb([{ id: "repo-a", accountId: "acc-a" }]);
    const { run, dispose } = cloneServices(db, base);
    try {
      const refused = run(clone((svc) => svc.ensureClone("repo-a", { basePath: chosen })));
      await expect(refused).rejects.toBeDefined();
      expect(rowOf(db, "repo-a")).toMatchObject({ clonePath: dest, cloneStatus: "error" });

      // A retry carries no base: it must not fall back to Revv's.
      await expect(run(clone((svc) => svc.ensureClone("repo-a")))).rejects.toBeDefined();
      expect(rowOf(db, "repo-a")).toMatchObject({ clonePath: dest, cloneStatus: "error" });

      await run(clone((svc) => svc.deleteClone("repo-a")));
      expect(existsSync(join(dest, "README.md"))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("refuses to link a checkout another account already links", async () => {
    const checkout = join(root, "code", "repo");
    makeClone(checkout);
    const db = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: checkout,
        cloneStatus: "ready",
        managed: false,
      },
      { id: "repo-b", accountId: "acc-b", managed: false },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      const outcome = await run(
        clone((svc) => svc.linkExisting("repo-b", checkout)).pipe(Effect.flip),
      );
      expect(String((outcome as Error).message)).toContain("already linked");
      expect(rowOf(db, "repo-b")?.cloneStatus).toBe("error");
    } finally {
      await dispose();
    }
  });

  it("deletes a clone Revv wrote in a folder the user picked, and only a clone of the repo", async () => {
    const custom = join(root, "picked", "octo", "repo");
    makeClone(custom);
    const db = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: custom,
        cloneStatus: "ready",
        revvWroteClone: true,
      },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.deleteClone("repo-a")));
      expect(existsSync(custom)).toBe(false);
    } finally {
      await dispose();
    }

    const other = join(root, "picked", "octo", "other");
    makeClone(other, "octo/other");
    const db2 = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: other,
        cloneStatus: "ready",
        revvWroteClone: true,
      },
    ]);
    const second = cloneServices(db2, base);
    try {
      await second.run(clone((svc) => svc.deleteClone("repo-a")));
      expect(existsSync(join(other, "README.md"))).toBe(true);
    } finally {
      await second.dispose();
    }
  });
});

describe("a clone into a folder the user picked, cut off mid-way", () => {
  // Nothing listens on port 1, so the retried clone fails at once, offline.
  const unreachableHost = "127.0.0.1:1";
  const settled = async (db: Db, id: string) => {
    for (let i = 0; i < 200; i++) {
      const status = rowOf(db, id)?.cloneStatus;
      if (status !== "pending" && status !== "cloning") return;
      await Bun.sleep(50);
    }
  };

  it("retries at boot over its own partial clone instead of refusing it", async () => {
    const dest = join(root, "picked", "octo", "repo");
    mkdirSync(dest, { recursive: true });
    git(dest, ["init", "--quiet"]);
    const db = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: dest,
        cloneStatus: "cloning",
        revvWroteClone: true,
        githubHost: unreachableHost,
      },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.recoverAtBoot()));
      await settled(db, "repo-a");
      const row = rowOf(db, "repo-a");
      expect(row?.cloneError).toStartWith("git clone failed");
      expect(row).toMatchObject({ clonePath: dest, cloneStatus: "error" });
      // The failed attempt cleared what it wrote: nothing there is Revv's now.
      expect(existsSync(dest)).toBe(false);
      expect(row?.revvWroteClone).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("is removed with the repository, while one Revv never wrote is kept", async () => {
    const written = join(root, "picked", "octo", "repo");
    const users = join(root, "mine", "octo", "repo");
    for (const dest of [written, users]) {
      mkdirSync(dest, { recursive: true });
      git(dest, ["init", "--quiet"]);
    }
    const db = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: written,
        cloneStatus: "error",
        revvWroteClone: true,
      },
      { id: "repo-b", accountId: "acc-b", clonePath: users, cloneStatus: "error" },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.deleteClone("repo-a")));
      await run(clone((svc) => svc.deleteClone("repo-b")));
      expect(existsSync(written)).toBe(false);
      expect(existsSync(join(users, ".git"))).toBe(true);
    } finally {
      await dispose();
    }
  });
});

describe("recoverAtBoot", () => {
  it("gives the later of two rows sharing a clone its own, keeping the first's", async () => {
    const layout = cloneLayout(base);
    const shared = join(base, "octo", "repo");
    makeClone(shared);
    // Where repo-b's own clone goes: made here so the resumed clone adopts it.
    makeClone(layout.distinctClonePath(base, { id: "repo-b", owner: "octo", name: "repo" }));
    const db = seedDb([
      {
        id: "repo-a",
        accountId: "acc-a",
        clonePath: shared,
        cloneStatus: "ready",
        addedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "repo-b",
        accountId: "acc-b",
        clonePath: shared,
        cloneStatus: "ready",
        addedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.recoverAtBoot()));
      expect(rowOf(db, "repo-a")?.clonePath).toBe(shared);
      for (let i = 0; i < 100 && rowOf(db, "repo-b")?.cloneStatus !== "ready"; i++) {
        await Bun.sleep(50);
      }
      expect(rowOf(db, "repo-b")).toMatchObject({
        clonePath: layout.distinctClonePath(base, { id: "repo-b", owner: "octo", name: "repo" }),
        cloneStatus: "ready",
        managed: true,
      });
    } finally {
      await dispose();
    }
  });

  it("moves an agent worktree out of the older shared layout, uncommitted edits included", async () => {
    const layout = cloneLayout(base);
    const clonePath = join(base, "octo", "repo");
    const head = makeClone(clonePath);
    const legacy = join(layout.legacyHolder({ owner: "octo", name: "repo" }), "pr-5");
    addWorktree(clonePath, legacy, "revv/pr-5", head);
    writeFileSync(join(legacy, "draft.ts"), "unsaved work\n");
    const db = seedDb([{ id: "repo-a", accountId: "acc-a", clonePath, cloneStatus: "ready" }]);
    const { run, dispose } = cloneServices(db, base);
    try {
      await run(clone((svc) => svc.recoverAtBoot()));
      const moved = layout.agentWorktree("repo-a", 5);
      expect(readFileSync(join(moved, "draft.ts"), "utf8")).toBe("unsaved work\n");
      expect(git(moved, ["symbolic-ref", "--short", "HEAD"])).toBe("revv/pr-5");
      expect(existsSync(legacy)).toBe(false);
    } finally {
      await dispose();
    }
  });
});
