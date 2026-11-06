// Snapshot-level layer above `BlobStore`.
//
// The service is the only gate on sharing; callers don't re-check it:
//   • cache.enabled         OFF → every op short-circuits (no-op / Option.none).
//   • cache.downloadsEnabled OFF → fetch/probe short-circuit to miss.
//   • cache.uploadsEnabled   OFF → push short-circuits to no-op.
//   • Only the reviewer perspective is shared: an author self-review is
//     never pushed, and never looked up. The key carries no perspective.
//
// On corrupt blob or schemaVersion mismatch the fetch path returns
// `Option.none` and logs. From a behavior standpoint it's identical to a
// real miss — the orchestrator falls back to running the agent.

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { WalkthroughMode } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import type { Db } from "../db/index";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { walkthroughs as walkthroughsTable } from "../db/schema/walkthroughs";
import { CacheSerialization, CacheUnavailable } from "../domain/errors";
import { debug, logError } from "../logger";
import { BlobStore } from "./blob/BlobStore";
import { CacheEligibility } from "./cache-eligibility";
import { SshSigner } from "./cache-signing/index";
import { DbService } from "./Db";
import { SettingsService } from "./Settings";
import {
  CACHE_METADATA_KEYS,
  CACHE_SCHEMA_VERSION,
  cacheObjectKey,
  cacheSigningMessage,
  type WalkthroughSnapshotV2,
} from "./walkthrough-cache-format";
import { exportWalkthroughSnapshot, validateSnapshot } from "./walkthrough-snapshot";

function resolveRepo(
  db: Db,
  prId: string,
): { readonly id: string; readonly fullName: string; readonly accountId: string } | null {
  const pr = db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  if (!pr) return null;
  return (
    db
      .select({
        id: repositories.id,
        fullName: repositories.fullName,
        accountId: repositories.accountId,
      })
      .from(repositories)
      .where(eq(repositories.id, pr.repositoryId))
      .get() ?? null
  );
}

export class RemoteWalkthroughCache extends Context.Service<
  RemoteWalkthroughCache,
  {
    /**
     * Cheap existence check. False when sharing is off for `mode`, the blob
     * is missing, or the backend is unreachable. Never raises — callers
     * treat truthiness as "object might exist".
     */
    readonly probe: (
      repoFullName: string,
      headSha: string,
      mode: WalkthroughMode,
    ) => Effect.Effect<boolean>;

    /**
     * Download + verify + parse. `Option.none` on a miss, when sharing is
     * off for `mode`, or on any failure. Failures are logged but never
     * escape — the orchestrator falls back to running the agent.
     */
    readonly fetch: (
      repoFullName: string,
      headSha: string,
      mode: WalkthroughMode,
    ) => Effect.Effect<Option.Option<WalkthroughSnapshotV2>>;

    /**
     * Build a snapshot from the local DB and upload. Fire-and-forget: the
     * completion path forks it after the row commits `complete`. Failures
     * log and never touch the completion (invariant #8).
     *
     * Preconditions enforced inside:
     *   • walkthroughs.status === 'complete', in the reviewer perspective
     *   • exporter validation passes (validateSnapshot)
     */
    readonly push: (
      walkthroughId: string,
    ) => Effect.Effect<void, CacheUnavailable | CacheSerialization>;
  }
>()("RemoteWalkthroughCache") {}

export const RemoteWalkthroughCacheLive = Layer.effect(
  RemoteWalkthroughCache,
  Effect.gen(function* () {
    const blob = yield* BlobStore;
    const settings = yield* SettingsService;
    const { db } = yield* DbService;
    const signer = yield* SshSigner;
    const eligibility = yield* CacheEligibility;

    const isDownloadEnabled = (mode: WalkthroughMode): Effect.Effect<boolean> =>
      settings
        .getSettings()
        .pipe(
          Effect.map((s) => mode === "reviewer" && s.cache.enabled && s.cache.downloadsEnabled),
        );

    const isUploadEnabled = (): Effect.Effect<boolean> =>
      settings.getSettings().pipe(Effect.map((s) => s.cache.enabled && s.cache.uploadsEnabled));

    return RemoteWalkthroughCache.of({
      probe: (repoFullName, headSha, mode) =>
        Effect.gen(function* () {
          const ok = yield* isDownloadEnabled(mode);
          if (!ok) return false;
          const key = cacheObjectKey(repoFullName, headSha);
          return yield* blob.exists(key).pipe(
            Effect.catch((e) => {
              debug("remote-cache", `probe failed key=${key}: ${e.message}`);
              return Effect.succeed(false);
            }),
          );
        }),

      fetch: (repoFullName, headSha, mode) =>
        Effect.gen(function* () {
          const ok = yield* isDownloadEnabled(mode);
          if (!ok) return Option.none<WalkthroughSnapshotV2>();

          const live = yield* settings.getSettings();
          const signingMode = live.cache.signing.mode;
          const trustedHosts = new Set(live.cache.signing.trustedSignerHosts);

          const key = cacheObjectKey(repoFullName, headSha);
          const record = yield* blob.get(key).pipe(
            Effect.catch((e) => {
              if (e._tag === "BlobCorrupt") {
                logError("remote-cache", `blob corrupt key=${key}: ${e.reason}`);
              } else {
                debug("remote-cache", `fetch failed key=${key}: ${e.message}`);
              }
              return Effect.succeed(
                Option.none<{ body: Buffer; metadata: Record<string, string> }>(),
              );
            }),
          );
          if (Option.isNone(record)) return Option.none<WalkthroughSnapshotV2>();

          const { body, metadata } = record.value;

          const advertisedVersion = metadata[CACHE_METADATA_KEYS.schemaVersion];
          if (advertisedVersion && Number(advertisedVersion) !== CACHE_SCHEMA_VERSION) {
            logError(
              "remote-cache",
              `schemaVersion mismatch key=${key} advertised=${advertisedVersion} expected=${CACHE_SCHEMA_VERSION}`,
            );
            return Option.none<WalkthroughSnapshotV2>();
          }

          const advertisedSha = metadata[CACHE_METADATA_KEYS.contentSha256];
          if (advertisedSha) {
            const actualSha = createHash("sha256").update(body).digest("hex");
            if (actualSha !== advertisedSha) {
              logError(
                "remote-cache",
                `contentSha256 mismatch key=${key} advertised=${advertisedSha} actual=${actualSha}`,
              );
              return Option.none<WalkthroughSnapshotV2>();
            }
          }

          if (signingMode !== "off") {
            const signerHost = metadata[CACHE_METADATA_KEYS.signerHost];
            const signerLogin = metadata[CACHE_METADATA_KEYS.signerLogin];
            const signature = metadata[CACHE_METADATA_KEYS.signature];

            if (!signature || !signerHost || !signerLogin) {
              // Legacy unsigned blob.
              if (signingMode === "strict") {
                logError(
                  "remote-cache",
                  `unsigned blob in strict mode — treating as miss key=${key}`,
                );
                return Option.none<WalkthroughSnapshotV2>();
              }
              logError("remote-cache", `unsigned blob accepted in permissive mode key=${key}`);
            } else {
              // Before verify fetches the signer's public keys from `signerHost`.
              if (!trustedHosts.has(signerHost)) {
                logError(
                  "remote-cache",
                  `signerHost=${signerHost} not in trusted hosts — treating as miss key=${key}`,
                );
                return Option.none<WalkthroughSnapshotV2>();
              }

              const contentSha = advertisedSha ?? createHash("sha256").update(body).digest("hex");
              const sigMsg = cacheSigningMessage(repoFullName, headSha, contentSha);

              const verifyResult = yield* signer
                .verify(sigMsg, signature, signerHost, signerLogin)
                .pipe(
                  Effect.map(() => "ok" as const),
                  Effect.catch((e) => {
                    const tag = (e as { _tag?: string })._tag ?? "unknown";
                    const msg = (e as { message?: string }).message ?? String(e);
                    return Effect.succeed(`fail:${tag}:${msg}` as const);
                  }),
                );

              if (typeof verifyResult === "string" && verifyResult.startsWith("fail:")) {
                const detail = verifyResult.slice(5);
                if (signingMode === "strict") {
                  logError(
                    "remote-cache",
                    `signature verification failed in strict mode key=${key}: ${detail}`,
                  );
                  return Option.none<WalkthroughSnapshotV2>();
                }
                logError(
                  "remote-cache",
                  `signature verification failed in permissive mode key=${key}: ${detail} — accepting anyway`,
                );
              } else {
                const eligible = yield* eligibility
                  .isSignerEligible(repoFullName, signerHost, signerLogin)
                  .pipe(Effect.catch(() => Effect.succeed(false)));

                if (!eligible) {
                  if (signingMode === "strict") {
                    logError(
                      "remote-cache",
                      `signer ${signerLogin}@${signerHost} lacks write permission on ${repoFullName} — treating as miss key=${key}`,
                    );
                    return Option.none<WalkthroughSnapshotV2>();
                  }
                  logError(
                    "remote-cache",
                    `signer ${signerLogin}@${signerHost} lacks write permission on ${repoFullName} — accepting in permissive mode key=${key}`,
                  );
                } else {
                  debug(
                    "remote-cache",
                    `signature OK signer=${signerLogin}@${signerHost} key=${key}`,
                  );
                }
              }
            }
          }

          let parsed: WalkthroughSnapshotV2;
          try {
            const decompressed = gunzipSync(body);
            parsed = JSON.parse(decompressed.toString("utf8")) as WalkthroughSnapshotV2;
          } catch (cause) {
            logError(
              "remote-cache",
              `gunzip/parse failed key=${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return Option.none<WalkthroughSnapshotV2>();
          }

          const v = validateSnapshot(parsed);
          if (!v.ok) {
            logError("remote-cache", `validation failed key=${key}: ${v.reason}`);
            return Option.none<WalkthroughSnapshotV2>();
          }

          debug(
            "remote-cache",
            `fetch hit key=${key} bytes=${body.length} sha=${advertisedSha ?? "n/a"}`,
          );
          return Option.some(parsed);
        }),

      push: (walkthroughId) =>
        Effect.gen(function* () {
          const ok = yield* isUploadEnabled();
          if (!ok) return;

          const wtRow = db
            .select({
              id: walkthroughsTable.id,
              status: walkthroughsTable.status,
              mode: walkthroughsTable.mode,
              pullRequestId: walkthroughsTable.pullRequestId,
            })
            .from(walkthroughsTable)
            .where(eq(walkthroughsTable.id, walkthroughId))
            .get();
          if (!wtRow) {
            return yield* Effect.fail(
              new CacheUnavailable({ message: `walkthrough ${walkthroughId} not found` }),
            );
          }
          if (wtRow.status !== "complete" || wtRow.mode !== "reviewer") {
            debug(
              "remote-cache",
              `push skipped wt=${walkthroughId} status=${wtRow.status} mode=${wtRow.mode}`,
            );
            return;
          }

          const repo = resolveRepo(db, wtRow.pullRequestId);
          if (!repo) {
            return yield* Effect.fail(
              new CacheUnavailable({
                message: `repoFullName unresolvable for walkthrough ${walkthroughId}`,
              }),
            );
          }

          const repoFullName = repo.fullName;

          const canPush = yield* eligibility
            .canPush(repo.id)
            .pipe(Effect.catch(() => Effect.succeed(false)));
          if (!canPush) {
            debug(
              "remote-cache",
              `push skipped: local user lacks write permission on ${repoFullName}`,
            );
            return;
          }

          const snapshot = yield* Effect.try({
            try: () => exportWalkthroughSnapshot(db, { walkthroughId, repoFullName }),
            catch: (cause) =>
              new CacheSerialization({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          });

          const validation = validateSnapshot(snapshot);
          if (!validation.ok) {
            return yield* Effect.fail(
              new CacheSerialization({
                message: `snapshot validation failed: ${validation.reason}`,
              }),
            );
          }

          const json = JSON.stringify(snapshot);
          const gz = gzipSync(Buffer.from(json, "utf8"));
          const contentSha256 = createHash("sha256").update(gz).digest("hex");

          const live = yield* settings.getSettings();

          const signingMode = live.cache.signing.mode;
          let signingMeta: Record<string, string> = {};

          if (signingMode !== "off") {
            const sigMsg = cacheSigningMessage(repoFullName, snapshot.prHeadSha, contentSha256);
            const signResult = yield* signer.sign(sigMsg, repo.accountId).pipe(
              Effect.mapError(
                (e) =>
                  new CacheSerialization({
                    message: `signing failed: ${e.message}`,
                    cause: e,
                  }),
              ),
            );
            signingMeta = {
              [CACHE_METADATA_KEYS.signature]: signResult.signature,
              [CACHE_METADATA_KEYS.signerHost]: signResult.signerHost,
              [CACHE_METADATA_KEYS.signerLogin]: signResult.signerLogin,
              [CACHE_METADATA_KEYS.signerGithubUserId]: signResult.signerGithubUserId,
              [CACHE_METADATA_KEYS.signatureNamespace]: signResult.signatureNamespace,
            };
            debug(
              "remote-cache",
              `signed as ${signResult.signerLogin}@${signResult.signerHost} namespace=${signResult.signatureNamespace}`,
            );
          }

          const key = cacheObjectKey(repoFullName, snapshot.prHeadSha);
          yield* blob
            .put(key, gz, {
              [CACHE_METADATA_KEYS.schemaVersion]: String(CACHE_SCHEMA_VERSION),
              [CACHE_METADATA_KEYS.modelUsed]: snapshot.modelUsed,
              [CACHE_METADATA_KEYS.contentSha256]: contentSha256,
              ...signingMeta,
            })
            .pipe(Effect.mapError((e) => new CacheUnavailable({ message: e.message, cause: e })));

          debug("remote-cache", `push ok key=${key} bytes=${gz.length} sha=${contentSha256}`);
        }).pipe(
          Effect.tapError((e) =>
            Effect.sync(() => {
              const tag = (e as { _tag?: string })._tag ?? "unknown";
              const message = (e as { message?: string }).message ?? String(e);
              logError("remote-cache", `push failed wt=${walkthroughId}: ${tag}: ${message}`);
            }),
          ),
        ),
    });
  }),
);
