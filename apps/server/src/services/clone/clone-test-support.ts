// Real repositories on disk and a real SQLite for the clone and worktree
// tests; only GitHub (a token) and the realtime fan-out are faked.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Context, Effect, Layer, ManagedRuntime } from "effect";
import { createDb, type Db } from "../../db/index";
import { account, user } from "../../db/schema/auth";
import { pullRequests, repositories } from "../../db/schema/index";
import { DbService } from "../Db";
import { GitHubAccounts } from "../github/accounts";
import { Realtime } from "../Realtime";
import { type AgentWorktrees, AgentWorktreesLive } from "../workspace/agent-worktrees";
import { type RepoCloneService, repoCloneLayer } from "./RepoClone";

const GIT_ENV: Record<string, string> = {
  ...process.env,
  GIT_AUTHOR_NAME: "Revv Test",
  GIT_AUTHOR_EMAIL: "revv-test@example.com",
  GIT_COMMITTER_NAME: "Revv Test",
  GIT_COMMITTER_EMAIL: "revv-test@example.com",
  GIT_TERMINAL_PROMPT: "0",
  // The user's and the system's git config (signing, hooks, templates) stay out of the fixtures.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** A clone of `octo/repo` on github.com at `path`, with one commit; returns its head. */
export function makeClone(path: string, fullName = "octo/repo"): string {
  mkdirSync(path, { recursive: true });
  git(path, ["init", "--quiet", "--initial-branch=main"]);
  git(path, ["remote", "add", "origin", `https://github.com/${fullName}.git`]);
  writeFileSync(join(path, "README.md"), "hello\n");
  git(path, ["add", "README.md"]);
  git(path, ["commit", "--quiet", "-m", "initial commit"]);
  return git(path, ["rev-parse", "HEAD"]);
}

export function addWorktree(clonePath: string, path: string, branch: string, sha: string): void {
  mkdirSync(dirname(path), { recursive: true });
  git(clonePath, ["worktree", "add", "--quiet", "-B", branch, path, sha]);
}

export interface RepoSeed {
  readonly id: string;
  readonly accountId: string;
  readonly addedAt?: string;
  readonly clonePath?: string | null;
  readonly cloneStatus?: "pending" | "ready";
  readonly managed?: boolean;
}

/** A user with two github.com accounts, `acc-a` and `acc-b`, tracking these repo rows. */
export function seedDb(repos: readonly RepoSeed[]): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({ id: "user-1", name: "U", email: "u@test", createdAt: now, updatedAt: now })
    .run();
  for (const id of ["acc-a", "acc-b"]) {
    db.insert(account)
      .values({
        id,
        accountId: id,
        providerId: "github:github.com",
        userId: "user-1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  for (const repo of repos) {
    db.insert(repositories)
      .values({
        id: repo.id,
        owner: "octo",
        name: "repo",
        fullName: "octo/repo",
        addedAt: repo.addedAt ?? now.toISOString(),
        githubHost: "github.com",
        accountId: repo.accountId,
        clonePath: repo.clonePath ?? null,
        cloneStatus: repo.cloneStatus ?? "pending",
        managed: repo.managed ?? true,
      })
      .run();
  }
  return db;
}

export function seedPr(db: Db, repoId: string, number: number, headSha: string): string {
  const id = `${repoId}:${number}`;
  db.insert(pullRequests)
    .values({
      id,
      repositoryId: repoId,
      externalId: number,
      title: `PR ${number}`,
      authorLogin: "me",
      status: "open",
      sourceBranch: `feature-${number}`,
      targetBranch: "main",
      headSha,
      url: `https://github.com/octo/repo/pull/${number}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      fetchedAt: "2026-01-01T00:00:00Z",
    })
    .run();
  return id;
}

/** One RepoClone and one AgentWorktrees over `base`, shared by every call until `dispose`. */
export function cloneServices(db: Db, base: string) {
  const deps = Layer.mergeAll(
    Layer.succeed(DbService, { db }),
    Layer.succeed(Realtime, {
      toAccount: () => Effect.void,
      toRepo: () => Effect.void,
      toUsers: () => Effect.void,
      toPr: () => Effect.void,
    }),
    Layer.succeed(GitHubAccounts, {
      clientFor: () => Effect.succeed({ token: "token" }),
    } as unknown as Context.Service.Shape<typeof GitHubAccounts>),
  );
  const repoClone = repoCloneLayer(base).pipe(Layer.provide(deps));
  const layer = Layer.mergeAll(
    repoClone,
    AgentWorktreesLive.pipe(Layer.provide(Layer.mergeAll(deps, repoClone))),
  );
  const runtime = ManagedRuntime.make(layer);
  return {
    run: <A, E>(effect: Effect.Effect<A, E, RepoCloneService | AgentWorktrees>): Promise<A> =>
      runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}
