import { describe, expect, it } from "bun:test";
import { gzipSync } from "node:zlib";
import { type CacheSigningMode, RATING_AXES } from "@revv/shared";
import { Effect, Layer, Option } from "effect";
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
  legacyCacheObjectKey,
  type WalkthroughSnapshotV2,
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
) {
  const reads: string[] = [];
  const layer = RemoteWalkthroughCacheLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(BlobStore, {
          get: (key: string) =>
            Effect.sync(() => {
              reads.push(key);
              return Option.fromNullishOr(objects.get(key));
            }),
          put: () => Effect.void,
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
        Layer.succeed(DbService, {} as never),
        Layer.succeed(SshSigner, {} as never),
        Layer.succeed(CacheEligibility, {} as never),
        Layer.succeed(PrContextService, {} as never),
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
  return { fetch, reads };
}

const entry = (summary: string, metadata: BlobMetadata = {}) => ({
  body: snapshot(summary),
  metadata,
});
const legacyKey = `acme/widget/${HEAD}.json.gz`;

describe("team-cache keys", () => {
  it("name the repository's host, one segment more than a legacy key", () => {
    expect(cacheObjectKey(DOTCOM, HEAD)).toBe(`github.com/acme/widget/${HEAD}.json.gz`);
    expect(cacheObjectKey({ ...GHE, githubHost: "HTTPS://GHE.acme.test/" }, HEAD)).toBe(
      `ghe.acme.test/acme/widget/${HEAD}.json.gz`,
    );
    expect(legacyCacheObjectKey(DOTCOM, HEAD)).toBe(legacyKey);
    expect(legacyCacheObjectKey(GHE, HEAD)).toBeNull();
  });
});

describe("a team-cache lookup", () => {
  it("serves each host its own review of a same-named repository", async () => {
    const { fetch } = cacheOver(
      new Map([
        [cacheObjectKey(DOTCOM, HEAD), entry("dotcom")],
        [cacheObjectKey(GHE, HEAD), entry("ghe")],
        [legacyKey, entry("legacy")],
      ]),
    );
    expect(await fetch(DOTCOM)).toBe("dotcom");
    expect(await fetch(GHE)).toBe("ghe");
  });

  it("falls back to the legacy key for a github.com repository", async () => {
    const { fetch, reads } = cacheOver(new Map([[legacyKey, entry("legacy")]]));
    expect(await fetch(DOTCOM)).toBe("legacy");
    expect(reads).toEqual([cacheObjectKey(DOTCOM, HEAD), legacyKey]);
  });

  it("never reads the legacy key for an Enterprise repository", async () => {
    const { fetch, reads } = cacheOver(new Map([[legacyKey, entry("legacy")]]));
    expect(await fetch(GHE)).toBeNull();
    expect(reads).toEqual([cacheObjectKey(GHE, HEAD)]);
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
        [
          cacheObjectKey(GHE, HEAD),
          entry("dotcom copied", { [CACHE_METADATA_KEYS.signerHost]: "github.com" }),
        ],
      ]),
    );
    expect(await fetch(GHE)).toBeNull();
  });
});
