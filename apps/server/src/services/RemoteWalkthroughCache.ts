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
import type { WalkthroughSnapshotV1 } from "@revv/shared";
import { CACHE_METADATA_KEYS, CACHE_SCHEMA_VERSION, cacheObjectKey } from "@revv/shared";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import type { Db } from "../db/index";
import { pullRequests } from "../db/schema/pull-requests";
import { repositories } from "../db/schema/repositories";
import { walkthroughs as walkthroughsTable } from "../db/schema/walkthroughs";
import { CacheSerialization, CacheUnavailable } from "../domain/errors";
import { debug, logError } from "../logger";
import { BlobStore } from "./blob/BlobStore";
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
    ) => Effect.Effect<Option.Option<WalkthroughSnapshotV1>>;

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
          if (!ok) return Option.none<WalkthroughSnapshotV1>();

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
          if (Option.isNone(record)) return Option.none<WalkthroughSnapshotV1>();

          const { body, metadata } = record.value;

          // Cross-check schemaVersion metadata before paying for gunzip.
          const advertisedVersion = metadata[CACHE_METADATA_KEYS.schemaVersion];
          if (advertisedVersion && Number(advertisedVersion) !== CACHE_SCHEMA_VERSION) {
            logError(
              "remote-cache",
              `schemaVersion mismatch key=${key} advertised=${advertisedVersion} expected=${CACHE_SCHEMA_VERSION}`,
            );
            return Option.none<WalkthroughSnapshotV1>();
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
              return Option.none<WalkthroughSnapshotV1>();
            }
          }

          let parsed: WalkthroughSnapshotV1;
          try {
            const decompressed = gunzipSync(body);
            parsed = JSON.parse(decompressed.toString("utf8")) as WalkthroughSnapshotV1;
          } catch (cause) {
            logError(
              "remote-cache",
              `gunzip/parse failed key=${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
            return Option.none<WalkthroughSnapshotV1>();
          }

          const v = validateSnapshot(parsed);
          if (!v.ok) {
            logError("remote-cache", `validation failed key=${key}: ${v.reason}`);
            return Option.none<WalkthroughSnapshotV1>();
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

          const key = cacheObjectKey(repoFullName, snapshot.prHeadSha);
          yield* blob
            .put(key, gz, {
              [CACHE_METADATA_KEYS.schemaVersion]: String(CACHE_SCHEMA_VERSION),
              [CACHE_METADATA_KEYS.modelUsed]: snapshot.modelUsed,
              [CACHE_METADATA_KEYS.uploadedByUserId]: live.id,
              [CACHE_METADATA_KEYS.contentSha256]: contentSha256,
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
