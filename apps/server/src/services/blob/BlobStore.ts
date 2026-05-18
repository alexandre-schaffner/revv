// ─── BlobStore ───────────────────────────────────────────────────────────────
//
// Backend-agnostic interface over the team-shared object storage that
// holds gzipped walkthrough snapshots. V1 ships a `GcsBlobStore` only;
// future variants (`S3BlobStore`, `R2BlobStore`, `HostedBlobStore`) can
// land behind this interface with zero protocol change.
//
// All ops are `Effect.Effect<…, BlobStoreUnavailable | BlobCorrupt>`. The
// orchestrator never lets these errors escape — every cache failure
// downgrades to a local agent run.

import type { Effect, Option } from "effect";
import { Context } from "effect";
import type { BlobCorrupt, BlobStoreUnavailable } from "../../domain/errors";

/**
 * Free-form key/value metadata attached to every blob. We use it for:
 *   • integrity tracking (`contentSha256`)
 *   • forward-compat versioning (`schemaVersion`)
 *   • advisory attribution (`uploadedByUserId`, `modelUsed`)
 * — see `CACHE_METADATA_KEYS` in `@revv/shared`.
 */
export type BlobMetadata = Record<string, string>;

export interface BlobRecord {
  body: Buffer;
  metadata: BlobMetadata;
}

export interface BlobStoreStatus {
  healthy: boolean;
  /** Human-readable detail surfaced to the Settings UI's "Test connection" button. */
  detail: string;
}

export class BlobStore extends Context.Tag("BlobStore")<
  BlobStore,
  {
    /**
     * Probe object existence. Returns `false` on miss; raises
     * `BlobStoreUnavailable` on network / auth failure. No body fetched.
     */
    readonly exists: (key: string) => Effect.Effect<boolean, BlobStoreUnavailable>;

    /**
     * Download and verify a blob. Missing object → `Option.none()`.
     * Network/auth failure → `BlobStoreUnavailable`. Corrupt body
     * (gunzip failure, missing metadata, sha256 mismatch) → `BlobCorrupt`.
     */
    readonly get: (
      key: string,
    ) => Effect.Effect<Option.Option<BlobRecord>, BlobStoreUnavailable | BlobCorrupt>;

    /**
     * Upload a blob with the given content-type / encoding / metadata. GCS
     * default semantics: last writer wins. Snapshots are content-addressed
     * by `headSha`, so concurrent uploads converge to byte-identical bodies.
     */
    readonly put: (
      key: string,
      body: Buffer,
      metadata: BlobMetadata,
    ) => Effect.Effect<void, BlobStoreUnavailable>;

    /**
     * Health probe — used by the Settings UI's "Test connection" button.
     * Always succeeds; the result discriminates healthy vs. why-not. Wraps
     * `bucket.getMetadata()` so an IAM misconfig surfaces a readable error
     * string to the user.
     */
    readonly status: () => Effect.Effect<BlobStoreStatus>;
  }
>() {}
