// Test support for the poll phases and PrMirror: a real GitHubAccounts and a
// real PrMirror over an in-memory DB, with everything they talk to faked and
// recorded. Imported by tests only.
import { DEFAULT_USER_SETTINGS, type Repository, type ServerEventMessage } from "@revv/shared";
import { type Context, Effect, Layer, Stream } from "effect";
import { createDb, type Db } from "../db/index";
import { account, user } from "../db/schema/auth";
import { repositories } from "../db/schema/repositories";
import { DbService } from "./Db";
import { GitHubAccounts, GitHubAccountsLive } from "./github/accounts";
import { GitHubGateway } from "./github/gateway";
import { PrMirror, PrMirrorLive } from "./PrMirror";
import { PullRequestService, PullRequestServiceLive } from "./PullRequest";
import { Realtime } from "./Realtime";
import { RepositoryServiceLive } from "./Repository";
import { SecretStore } from "./SecretStore";
import { SettingsService } from "./Settings";
import { StackService } from "./stacks/StackService";
import { WalkthroughJobs } from "./WalkthroughJobs";
import { AgentWorktrees } from "./workspace/agent-worktrees";

export const ACCOUNT_ID = "acc-1";

export const REPO: Repository = {
  id: "repo-1",
  provider: "github",
  owner: "octo",
  name: "repo",
  fullName: "octo/repo",
  defaultBranch: "main",
  avatarUrl: null,
  addedAt: "2026-01-01T00:00:00Z",
  cloneStatus: "ready",
  clonePath: null,
  cloneError: null,
  managed: false,
  githubHost: "github.com",
};

/** A user, their github.com account `acc-1`, and the repos it tracks. */
export function seedDb(repos: readonly Repository[] = [REPO]): Db {
  const db = createDb(":memory:");
  const now = new Date();
  db.insert(user)
    .values({
      id: "user-1",
      name: "U",
      email: "u@test",
      githubLogin: "me",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: ACCOUNT_ID,
      accountId: "1",
      providerId: "github:github.com",
      userId: "user-1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const repo of repos) {
    db.insert(repositories)
      .values({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        addedAt: repo.addedAt,
        githubHost: repo.githubHost,
        accountId: ACCOUNT_ID,
      })
      .run();
  }
  return db;
}

/** What the faked neighbours of PrMirror were asked to do. */
export interface Recorded {
  readonly superseded: Array<{ readonly prId: string; readonly exceptHeadSha?: string }>;
  readonly pruned: Array<{ readonly repoId: string; readonly prNumber: number }>;
  readonly staleStacks: string[];
  readonly events: Array<{ readonly to: string; readonly msg: ServerEventMessage }>;
}

export interface Harness {
  readonly db: Db;
  readonly accounts: Context.Service.Shape<typeof GitHubAccounts>;
  readonly mirror: Context.Service.Shape<typeof PrMirror>;
  readonly prService: Context.Service.Shape<typeof PullRequestService>;
  readonly recorded: Recorded;
}

/** `github` is the gateway PrMirror sees (only `recordPushes` and `headOf` call it). */
export async function makeHarness(
  db: Db,
  github: Partial<Context.Service.Shape<typeof GitHubGateway>> = {},
): Promise<Harness> {
  const recorded: Recorded = { superseded: [], pruned: [], staleStacks: [], events: [] };
  const push = (to: string, msg: ServerEventMessage) =>
    Effect.sync(() => {
      recorded.events.push({ to, msg });
    });
  const dbLayer = Layer.succeed(DbService, { db });
  const realtime = Layer.succeed(Realtime, {
    toAccount: push,
    toRepo: push,
    toPr: push,
    toAll: (msg) => push("*", msg),
  });
  const secretStore = Layer.succeed(SecretStore, {
    setTokens: () => Effect.void,
    getTokens: () => Effect.succeed({ accessToken: "token", refreshToken: null }),
    deleteTokens: () => Effect.void,
    setSecret: () => Effect.void,
    getSecret: () => Effect.succeed(null),
    deleteSecret: () => Effect.void,
  });
  const settings = Layer.succeed(SettingsService, {
    getSettings: () => Effect.succeed(DEFAULT_USER_SETTINGS),
    updateSettings: () => Effect.succeed(DEFAULT_USER_SETTINGS),
    githubHost: () => Effect.succeed("github.com"),
    watch: () => Stream.empty,
    resolveAgent: () => Effect.succeed("opencode" as const),
    resolveRecapAgent: () => Effect.succeed("opencode" as const),
  } as unknown as Context.Service.Shape<typeof SettingsService>);
  const fakes = Layer.mergeAll(
    Layer.succeed(WalkthroughJobs, {
      supersedeForPr: (prId: string, exceptHeadSha?: string) =>
        Effect.sync(() => {
          recorded.superseded.push(
            exceptHeadSha === undefined ? { prId } : { prId, exceptHeadSha },
          );
        }),
    } as unknown as Context.Service.Shape<typeof WalkthroughJobs>),
    Layer.succeed(AgentWorktrees, {
      prune: (params: { repoId: string; prNumber: number }) =>
        Effect.sync(() => {
          recorded.pruned.push({ repoId: params.repoId, prNumber: params.prNumber });
          return { pruned: true };
        }),
    } as unknown as Context.Service.Shape<typeof AgentWorktrees>),
    Layer.succeed(StackService, {
      moved: (_accountId: string, repositoryId: string, stackNumber: number) =>
        Effect.sync(() => {
          recorded.staleStacks.push(`${repositoryId}:${stackNumber}`);
        }),
    } as unknown as Context.Service.Shape<typeof StackService>),
    Layer.succeed(GitHubGateway, github as Context.Service.Shape<typeof GitHubGateway>),
  );
  const deps = Layer.mergeAll(
    dbLayer,
    realtime,
    PullRequestServiceLive,
    RepositoryServiceLive,
    fakes,
  );
  const layer = Layer.mergeAll(
    GitHubAccountsLive.pipe(
      Layer.provide(Layer.mergeAll(dbLayer, realtime, secretStore, settings)),
    ),
    PrMirrorLive.pipe(Layer.provide(deps)),
    PullRequestServiceLive,
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return {
        db,
        accounts: yield* GitHubAccounts,
        mirror: yield* PrMirror,
        prService: yield* PullRequestService,
        recorded,
      };
    }).pipe(Effect.provide(layer)),
  );
}
