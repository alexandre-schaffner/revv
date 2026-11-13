import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { type CacheSigningMode, RATING_AXES } from "@revv/shared";
import { Effect, Layer, Option } from "effect";
import { createDb, type Db } from "../../db/index";
import { walkthroughBlocks, walkthroughRatings, walkthroughs } from "../../db/schema";
import { type BlobMetadata, BlobStore } from "../blob/BlobStore";
import { CacheEligibility } from "../cache-eligibility";
import { SshSigner } from "../cache-signing/index";
import { DbService } from "../Db";
import { PrContextService } from "../PrContext";
import { SettingsService } from "../Settings";
import {
  CACHE_METADATA_KEYS,
  CACHE_SCHEMA_VERSION,
  type CacheRepo,
  cacheObjectKey,
} from "./cache-format";
import { RemoteWalkthroughCache, RemoteWalkthroughCacheLive } from "./RemoteWalkthroughCache";

const HEAD = "abc123";
const DOTCOM: CacheRepo = { githubHost: "github.com", fullName: "acme/widget" };
const GHE: CacheRepo = { githubHost: "ghe.acme.test", fullName: "acme/widget" };

/** A snapshot that clears `validateSnapshot`, told apart by its summary. */
function snapshot(summary: string): Buffer {
  const body = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repoFullName: "acme/widget",
    prHeadSha: HEAD,
    summary,
    sentiment: "Fine.",
    blocks: [{ type: "markdown", content: "x" }],
    ratings: RATING_AXES.map((axis) => ({ axis })),
    issues: [],
  };
  return gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
}

function cacheOver(
  objects: ReadonlyMap<string, { body: Buffer; metadata: BlobMetadata }>,
  signingMode: CacheSigningMode = "off",
  db: Db = {} as Db,
  pushedFrom: CacheRepo = DOTCOM,
) {
  const reads: string[] = [];
  const writes: string[] = [];
  const layer = RemoteWalkthroughCacheLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BlobStore, {
          get: (key: string) =>
            Effect.sync(() => {
              reads.push(key);
              return Option.fromNullishOr(objects.get(key));
            }),
          put: (key: string) => Effect.sync(() => void writes.push(key)),
          status: () => Effect.succeed({ healthy: true, detail: "" }),
        }),
        Layer.succeed(SettingsService, {
          getSettings: () =>
            Effect.succeed({
              cache: {
                enabled: true,
                downloadsEnabled: true,
                uploadsEnabled: true,
                signing: { mode: signingMode, trustedSignerHosts: [] },
              },
            }),
        } as never),
        Layer.succeed(DbService, { db }),
        Layer.succeed(SshSigner, {} as never),
        Layer.succeed(CacheEligibility, { canPush: () => Effect.succeed(true) } as never),
        Layer.succeed(PrContextService, {
          readPr: () =>
            Effect.succeed({ accountId: "acc-1", repo: { id: "repo-1", ...pushedFrom } }),
        } as never),
      ),
    ),
  );
  const fetch = (repo: CacheRepo) =>
    Effect.runPromise(
      Effect.flatMap(RemoteWalkthroughCache, (cache) => cache.fetch(repo, HEAD, "reviewer")).pipe(
        Effect.provide(layer),
        Effect.map((hit) => (Option.isSome(hit) ? hit.value.summary : null)),
      ),
    );
  const push = (walkthroughId: string) =>
    Effect.runPromise(
      Effect.flatMap(RemoteWalkthroughCache, (cache) => cache.push(walkthroughId)).pipe(
        Effect.provide(layer),
      ),
    );
  return { fetch, push, reads, writes };
}

/** A database holding one complete reviewer walkthrough at HEAD, `wt-1`. */
function completedReview(): Db {
  const db = createDb(":memory:");
  db.$client.run("PRAGMA foreign_keys = OFF");
  const now = "2026-11-07T00:00:00Z";
  db.insert(walkthroughs)
    .values({
      id: "wt-1",
      reviewSessionId: "session-1",
      pullRequestId: "pr-1",
      generatedAt: now,
      completedAt: now,
      modelUsed: "test-model",
      tokenUsage: "{}",
      prHeadSha: HEAD,
      status: "complete",
      lastCompletedPhase: "D",
      summary: "Adds a limiter.",
      sentiment: "Ship it.",
    })
    .run();
  db.insert(walkthroughBlocks)
    .values({
      id: "b-0",
      walkthroughId: "wt-1",
      semanticStepIndex: 0,
      order: 0,
      stepIndex: 0,
      type: "markdown",
      data: JSON.stringify({ type: "markdown", content: "The limiter." }),
      createdAt: now,
    })
    .run();
  for (const axis of RATING_AXES) {
    db.insert(walkthroughRatings)
      .values({
        id: `r-${axis}`,
        walkthroughId: "wt-1",
        axis,
        verdict: "pass",
        confidence: "high",
        rationale: "Fine.",
        details: "Fine.",
        citations: "[]",
        blockIds: "[]",
        createdAt: now,
      })
      .run();
  }
  return db;
}

const entry = (summary: string, metadata: BlobMetadata = {}) => ({
  body: snapshot(summary),
  metadata,
});
const legacyKey = `acme/widget/${HEAD}.json.gz`;
const gheKey = `ghe.acme.test/acme/widget/${HEAD}.json.gz`;

describe("team-cache keys", () => {
  it("keep the legacy host-less key for github.com, so older clients share it", () => {
    expect(cacheObjectKey(DOTCOM, HEAD)).toBe(legacyKey);
    expect(cacheObjectKey({ ...DOTCOM, githubHost: "https://GitHub.com/" }, HEAD)).toBe(legacyKey);
  });

  it("name an Enterprise repository's host, one segment more than a legacy key", () => {
    expect(cacheObjectKey(GHE, HEAD)).toBe(gheKey);
    expect(cacheObjectKey({ ...GHE, githubHost: "HTTPS://GHE.acme.test/" }, HEAD)).toBe(gheKey);
  });
});

describe("a team-cache push", () => {
  it("writes a github.com review to the legacy key", async () => {
    const { push, writes } = cacheOver(new Map(), "off", completedReview(), DOTCOM);
    await push("wt-1");
    expect(writes).toEqual([legacyKey]);
  });

  it("writes an Enterprise review to its host's key, never the legacy one", async () => {
    const { push, writes } = cacheOver(new Map(), "off", completedReview(), GHE);
    await push("wt-1");
    expect(writes).toEqual([gheKey]);
  });
});

describe("a team-cache lookup", () => {
  it("serves each host its own review of a same-named repository", async () => {
    const { fetch } = cacheOver(
      new Map([
        [legacyKey, entry("dotcom")],
        [gheKey, entry("ghe")],
      ]),
    );
    expect(await fetch(DOTCOM)).toBe("dotcom");
    expect(await fetch(GHE)).toBe("ghe");
  });

  it("reads only the legacy key for a github.com repository", async () => {
    const { fetch, reads } = cacheOver(
      new Map([
        [`github.com/acme/widget/${HEAD}.json.gz`, entry("host-scoped")],
        [legacyKey, entry("legacy")],
      ]),
    );
    expect(await fetch(DOTCOM)).toBe("legacy");
    expect(reads).toEqual([legacyKey]);
  });

  it("never reads the legacy key for an Enterprise repository", async () => {
    const { fetch, reads } = cacheOver(new Map([[legacyKey, entry("legacy")]]));
    expect(await fetch(GHE)).toBeNull();
    expect(reads).toEqual([gheKey]);
  });

  it("refuses a legacy entry signed on another host, in every signing mode", async () => {
    for (const mode of ["off", "permissive", "strict"] as const) {
      const signedOnGhe = entry("ghe via legacy", {
        [CACHE_METADATA_KEYS.signerHost]: GHE.githubHost,
        [CACHE_METADATA_KEYS.signerLogin]: "alice",
        [CACHE_METADATA_KEYS.signature]: "sig",
      });
      const { fetch } = cacheOver(new Map([[legacyKey, signedOnGhe]]), mode);
      expect(await fetch(DOTCOM)).toBeNull();
    }
  });

  it("refuses an entry under a host's key that was signed on another host", async () => {
    const { fetch } = cacheOver(
      new Map([
        [gheKey, entry("dotcom copied", { [CACHE_METADATA_KEYS.signerHost]: "github.com" })],
      ]),
    );
    expect(await fetch(GHE)).toBeNull();
  });
});
