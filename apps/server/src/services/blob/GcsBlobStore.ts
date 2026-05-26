// ─── GcsBlobStore ────────────────────────────────────────────────────────────
//
// `BlobStore` implementation against Google Cloud Storage. Lazy-init:
// the underlying `@google-cloud/storage` client is constructed once from
// `Settings.cache`, then rebuilt whenever the relevant settings fields
// change (bucket / credentials).
//
// The store is settings-aware: when `cache.enabled` is false, every op
// short-circuits to `BlobStoreUnavailable` — the caller treats that as a
// miss. The orchestrator never escalates; the only place this error is
// user-visible is the "Test connection" button in Settings.
//
// **Install note.** The `@google-cloud/storage` package is declared as a
// dependency in `apps/server/package.json` but is not pulled into the
// TypeScript program here — the SDK has a heavy type surface we don't
// need, and a dynamic import keeps cold-start cheap when the cache
// feature is off. The shapes we touch (`Storage`, `Bucket`, `File`) are
// captured in the narrow local types below; if the SDK API drifts, the
// runtime will surface the breakage via `tryPromise` → `BlobStoreUnavailable`.

import { Effect, Layer, Option, Ref, Stream } from "effect";
import { BlobStoreUnavailable } from "../../domain/errors";
import { logError } from "../../logger";
import { SettingsService } from "../Settings";
import { type BlobRecord, BlobStore, type BlobStoreStatus } from "./BlobStore";

// ── Local typings for the slice of @google-cloud/storage we touch ────────
// Kept minimal so the heavy SDK doesn't need to land in our `tsc` program.

interface GcsFile {
  exists(): Promise<[boolean]>;
  // `validation: false` disables the SDK's MD5/CRC32c check on download.
  // Safe because RemoteWalkthroughCache cross-checks contentSha256 itself.
  download(opts?: { validation?: boolean }): Promise<[Buffer]>;
  getMetadata(): Promise<[{ metadata?: Record<string, string> }]>;
  save(
    body: Buffer,
    options: {
      resumable?: boolean;
      contentType?: string;
      metadata?: {
        contentType?: string;
        contentEncoding?: string;
        metadata?: Record<string, string>;
      };
    },
  ): Promise<void>;
}

interface GcsBucket {
  file(name: string): GcsFile;
  getMetadata(): Promise<[unknown]>;
}

interface GcsStorageClass {
  new (opts: Record<string, unknown>): { bucket(name: string): GcsBucket };
}

interface GcsModule {
  Storage: GcsStorageClass;
}

interface ResolvedClient {
  bucket: GcsBucket;
  bucketName: string;
}

interface ClientCache {
  /**
   * Stringified config that produced this client. We compare against
   * the live settings on each op; if it changed, we rebuild lazily.
   * Cheaper than tearing down + recreating per settings stream tick.
   */
  configKey: string;
  client: ResolvedClient | null;
}

function buildConfigKey(s: { enabled: boolean; bucket: string }): string {
  return [s.enabled ? "1" : "0", s.bucket].join("|");
}

function gcsErr(prefix: string, cause: unknown): BlobStoreUnavailable {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new BlobStoreUnavailable({ message: `${prefix}: ${message}`, cause });
}

export const GcsBlobStoreLive = Layer.scoped(
  BlobStore,
  Effect.gen(function* () {
    const settings = yield* SettingsService;

    const cache = yield* Ref.make<ClientCache>({ configKey: "", client: null });

    yield* Effect.forkScoped(
      Stream.runDrain(
        settings.settingsChanges().pipe(
          Stream.tap((s) =>
            Ref.update(cache, (c) => {
              const nextKey = buildConfigKey(s.cache);
              if (nextKey === c.configKey) return c;
              return { configKey: nextKey, client: null };
            }),
          ),
        ),
      ),
    );

    // Dynamic import — keeps cold-start fast when the feature is off.
    let gcsModule: GcsModule | null = null;
    const loadGcs = (): Effect.Effect<GcsModule, BlobStoreUnavailable> =>
      Effect.tryPromise({
        try: async () => {
          if (gcsModule) return gcsModule;
          // biome-ignore lint/suspicious/noExplicitAny: SDK is dynamically loaded; surface area captured by GcsModule.
          const mod = (await import("@google-cloud/storage")) as any;
          gcsModule = mod as GcsModule;
          return gcsModule;
        },
        catch: (cause) => gcsErr("failed to load @google-cloud/storage", cause),
      });

    const resolveClient = (): Effect.Effect<ResolvedClient, BlobStoreUnavailable> =>
      Effect.gen(function* () {
        const live = yield* settings
          .getSettings()
          .pipe(
            Effect.mapError(
              (e) => new BlobStoreUnavailable({ message: `settings unavailable: ${e.message}` }),
            ),
          );
        if (!live.cache.enabled) {
          return yield* Effect.fail(
            new BlobStoreUnavailable({ message: "team cache is disabled" }),
          );
        }
        if (live.cache.bucket.trim().length === 0) {
          return yield* Effect.fail(new BlobStoreUnavailable({ message: "cache.bucket is empty" }));
        }

        const liveKey = buildConfigKey(live.cache);
        const cached = yield* Ref.get(cache);
        if (cached.client && cached.configKey === liveKey) {
          return cached.client;
        }

        const mod = yield* loadGcs();
        const opts: Record<string, unknown> = {};
        // Emulator override (REVV_CACHE_API_ENDPOINT). We deliberately
        // do NOT use the SDK's own `STORAGE_EMULATOR_HOST`: with that
        // env var set, `@google-cloud/storage` v7 forces bare-bucket
        // URL routing (`/b/<name>`) regardless of any `apiEndpoint`
        // constructor option, and fake-gcs-server only serves the JSON
        // API at `/storage/v1/b/<name>`. Using our own var lets us
        // pick the JSON-API path via `apiEndpoint` while keeping
        // STORAGE_EMULATOR_HOST out of the SDK's environment entirely.
        // Real-GCS unaffected when the env var is unset.
        const emulatorHost = process.env.REVV_CACHE_API_ENDPOINT?.trim();
        if (emulatorHost && emulatorHost.length > 0) {
          opts.apiEndpoint = emulatorHost;
          opts.projectId = opts.projectId ?? "revv-cache-emulator";
          // With valid SA credentials, the SDK fetches a real OAuth token and
          // uses an authenticated download path (`/storage/v1/...?alt=media`)
          // that fake-gcs-server returns 0 bytes for. Disabling auth with the
          // custom endpoint forces the unauthenticated path
          // (`/download/storage/v1/...`) which the emulator serves correctly.
          opts.useAuthWithCustomEndpoint = false;
        }
        const storage = new mod.Storage(opts);
        const bucket = storage.bucket(live.cache.bucket.trim());
        const next: ResolvedClient = { bucket, bucketName: live.cache.bucket.trim() };
        yield* Ref.set(cache, { configKey: liveKey, client: next });
        return next;
      });

    const fileFor = (key: string): Effect.Effect<GcsFile, BlobStoreUnavailable> =>
      Effect.map(resolveClient(), (c) => c.bucket.file(key));

    return BlobStore.of({
      exists: (key) =>
        Effect.gen(function* () {
          const file = yield* fileFor(key);
          const result = yield* Effect.tryPromise({
            try: () => file.exists(),
            catch: (cause) => gcsErr(`exists(${key})`, cause),
          });
          return result[0];
        }),

      get: (key) =>
        Effect.gen(function* () {
          const file = yield* fileFor(key);
          const existsResult = yield* Effect.tryPromise({
            try: () => file.exists(),
            catch: (cause) => gcsErr(`get.exists(${key})`, cause),
          });
          if (!existsResult[0]) return Option.none<BlobRecord>();

          const downloadResult = yield* Effect.tryPromise({
            try: () => file.download({ validation: false }),
            catch: (cause) => gcsErr(`download(${key})`, cause),
          });
          const body = downloadResult[0];

          const metaResult = yield* Effect.tryPromise({
            try: () => file.getMetadata(),
            catch: (cause) => gcsErr(`getMetadata(${key})`, cause),
          });

          const m = metaResult[0].metadata ?? {};
          return Option.some<BlobRecord>({ body, metadata: { ...m } });
        }),

      put: (key, body, metadata) =>
        Effect.gen(function* () {
          const file = yield* fileFor(key);
          yield* Effect.tryPromise({
            try: () =>
              file.save(body, {
                resumable: false,
                // Store as application/gzip without a Content-Encoding header.
                // Setting Content-Encoding: gzip causes GCS (and emulators) to
                // serve the body transparently decompressed, which breaks our
                // own gunzip + SHA256 pipeline in RemoteWalkthroughCache.
                contentType: "application/gzip",
                metadata: {
                  contentType: "application/gzip",
                  metadata,
                },
              }),
            catch: (cause) => gcsErr(`put(${key})`, cause),
          });
        }),

      status: () =>
        resolveClient().pipe(
          Effect.flatMap((c) =>
            Effect.tryPromise({
              try: async () => {
                await c.bucket.getMetadata();
                return {
                  healthy: true as const,
                  detail: `Connected to bucket "${c.bucketName}"`,
                };
              },
              catch: (cause) => {
                const message = cause instanceof Error ? cause.message : String(cause);
                return new BlobStoreUnavailable({ message, cause });
              },
            }),
          ),
          Effect.catchAll((e) =>
            Effect.sync(() => {
              logError("gcs-blob-store", "status check failed:", e.message);
              return { healthy: false as const, detail: e.message } satisfies BlobStoreStatus;
            }),
          ),
        ),
    });
  }),
);
