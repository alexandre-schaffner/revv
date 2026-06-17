// ─── RemoteWalkthroughCache ──────────────────────────────────────────────────
//
// Snapshot-level layer above `BlobStore`. Three ops:
//
//   • probe — cheap existence check, used as a fast-path gate.
//   • fetch — download + integrity-verify + parse.
//   • push  — gzip + upload (fire-and-forget at the caller site).
//
// All ops are settings-gated:
//   • cache.enabled         OFF → every op short-circuits (no-op / Option.none).
//   • cache.downloadsEnabled OFF → fetch/probe short-circuit to miss.
//   • cache.uploadsEnabled   OFF → push short-circuits to no-op.
//
// On corrupt blob or schemaVersion mismatch the fetch path returns
// `Option.none` and logs. From a behavior standpoint it's identical to a
// real miss — the orchestrator falls back to running the agent.

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { WalkthroughSnapshotV2 } from "@revv/shared";
import {
  CACHE_METADATA_KEYS,
  CACHE_SCHEMA_VERSION,
  cacheObjectKey,
  cacheSigningMessage,
} from "@revv/shared";
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
import { exportWalkthroughSnapshot, validateSnapshot } from "./walkthrough-snapshot";

function resolveRepoFullName(db: Db, prId: string): string | null {
  const pr = db
    .select({ repositoryId: pullRequests.repositoryId })
    .from(pullRequests)
    .where(eq(pullRequests.id, prId))
    .get();
  if (!pr) return null;
  const repo = db
    .select({ fullName: repositories.fullName })
    .from(repositories)
    .where(eq(repositories.id, pr.repositoryId))
    .get();
  return repo?.fullName ?? null;
}

export class RemoteWalkthroughCache extends Context.Tag("RemoteWalkthroughCache")<
  RemoteWalkthroughCache,
  {
    /**
     * Cheap existence check. Returns `false` when:
     *   • feature disabled (cache.enabled || cache.downloadsEnabled false)
     *   • blob is missing
     *   • backend is unreachable
     *
     * Never raises — callers treat truthiness as "object might exist".
     */
    readonly probe: (repoFullName: string, headSha: string) => Effect.Effect<boolean>;

    /**
     * Download + verify + parse. Returns `Option.none` on miss, feature
     * disabled, or any failure. Failures are logged but never escape —
     * the orchestrator falls back to running the agent.
     */
    readonly fetch: (
      repoFullName: string,
      headSha: string,
    ) => Effect.Effect<Option.Option<WalkthroughSnapshotV2>>;

    /**
     * Build a snapshot from the local DB and upload. Fire-and-forget at
     * the call site — `WalkthroughJobs` schedules this on a forked fiber
     * after `setStatus('complete')` lands. Failures log + return; never
     * block the commit-first / broadcast-second contract (invariant #8).
     *
     * Preconditions enforced inside:
     *   • walkthroughs.status === 'complete'
     *   • exporter validation passes (validateSnapshot)
     */
    readonly push: (
      walkthroughId: string,
    ) => Effect.Effect<void, CacheUnavailable | CacheSerialization>;
  }
>() {}

export const RemoteWalkthroughCacheLive = Layer.effect(
  RemoteWalkthroughCache,
  Effect.gen(function* () {
    const blob = yield* BlobStore;
    const settings = yield* SettingsService;
    const { db } = yield* DbService;
    const signer = yield* SshSigner;
    const eligibility = yield* CacheEligibility;

    const isDownloadEnabled = (): Effect.Effect<boolean> =>
      settings.getSettings().pipe(
        Effect.map((s) => s.cache.enabled && s.cache.downloadsEnabled),
        Effect.catchAll(() => Effect.succeed(false)),
      );

    const isUploadEnabled = (): Effect.Effect<boolean> =>
      settings.getSettings().pipe(
        Effect.map((s) => s.cache.enabled && s.cache.uploadsEnabled),
        Effect.catchAll(() => Effect.succeed(false)),
      );

    return RemoteWalkthroughCache.of({
      probe: (repoFullName, headSha) =>
        Effect.gen(function* () {
          const ok = yield* isDownloadEnabled();
          if (!ok) return false;
          const key = cacheObjectKey(repoFullName, headSha);
          return yield* blob.exists(key).pipe(
            Effect.catchAll((e) => {
              debug("remote-cache", `probe failed key=${key}: ${e.message}`);
              return Effect.succeed(false);
            }),
          );
        }),

      fetch: (repoFullName, headSha) =>
        Effect.gen(function* () {
          const ok = yield* isDownloadEnabled();
          if (!ok) return Option.none<WalkthroughSnapshotV2>();

          const live = yield* settings
            .getSettings()
            .pipe(Effect.catchAll(() => Effect.succeed(null)));
          const signingMode = live?.cache.signing.mode ?? "strict";
          const trustedHosts = new Set(live?.cache.signing.trustedSignerHosts ?? []);

          const key = cacheObjectKey(repoFullName, headSha);
          const record = yield* blob.get(key).pipe(
            Effect.catchAll((e) => {
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

          // Cross-check schemaVersion metadata before paying for gunzip.
          const advertisedVersion = metadata[CACHE_METADATA_KEYS.schemaVersion];
          if (advertisedVersion && Number(advertisedVersion) !== CACHE_SCHEMA_VERSION) {
            logError(
              "remote-cache",
              `schemaVersion mismatch key=${key} advertised=${advertisedVersion} expected=${CACHE_SCHEMA_VERSION}`,
            );
            return Option.none<WalkthroughSnapshotV2>();
          }

          // contentSha256 cross-check — defensive against silent corruption.
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

          // ── Signature verification (when mode != 'off') ──────────────────
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
              // permissive: log and continue
              logError("remote-cache", `unsigned blob accepted in permissive mode key=${key}`);
            } else {
              // Verify trusted host first (cheap check before hitting the network).
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
                  Effect.catchAll((e) => {
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
                // Signature valid — now check signer eligibility.
                const eligible = yield* eligibility
                  .isSignerEligible(repoFullName, signerHost, signerLogin)
                  .pipe(Effect.catchAll(() => Effect.succeed(false)));

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
          if (wtRow.status !== "complete") {
            debug("remote-cache", `push skipped wt=${walkthroughId} status=${wtRow.status}`);
            return;
          }

          const repoFullName = resolveRepoFullName(db, wtRow.pullRequestId);
          if (!repoFullName) {
            return yield* Effect.fail(
              new CacheUnavailable({
                message: `repoFullName unresolvable for walkthrough ${walkthroughId}`,
              }),
            );
          }

          // ── Eligibility gate ────────────────────────────────────────────
          const canPush = yield* eligibility
            .canPush(repoFullName)
            .pipe(Effect.catchAll(() => Effect.succeed(false)));
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

          const live = yield* settings
            .getSettings()
            .pipe(Effect.mapError((e) => new CacheUnavailable({ message: e.message })));

          // ── Signing (when mode != 'off') ─────────────────────────────────
          const signingMode = live.cache.signing.mode;
          let signingMeta: Record<string, string> = {};

          if (signingMode !== "off") {
            const sigMsg = cacheSigningMessage(repoFullName, snapshot.prHeadSha, contentSha256);
            const signResult = yield* signer.sign(sigMsg).pipe(
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
              [CACHE_METADATA_KEYS.uploadedByUserId]: live.id,
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
