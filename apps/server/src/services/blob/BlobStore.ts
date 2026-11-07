// Team-shared object storage holding gzipped walkthrough snapshots. Callers
// never let its errors escape: every cache failure downgrades to a local
// agent run.

import type { Effect, Option } from "effect";
import { Context } from "effect";
import type { BlobStoreUnavailable } from "../../domain/errors";

/** Keys are `CACHE_METADATA_KEYS` in `../walkthrough/cache-format`. */
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

export class BlobStore extends Context.Service<
  BlobStore,
  {
    readonly exists: (key: string) => Effect.Effect<boolean, BlobStoreUnavailable>;

    /**
     * The body comes back unverified: `RemoteWalkthroughCache` gunzips it and
     * checks its sha256 against the metadata.
     */
    readonly get: (key: string) => Effect.Effect<Option.Option<BlobRecord>, BlobStoreUnavailable>;

    /**
     * Last writer wins (GCS default). Snapshots are content-addressed by
     * `headSha`, so concurrent uploads converge to byte-identical bodies.
     */
    readonly put: (
      key: string,
      body: Buffer,
      metadata: BlobMetadata,
    ) => Effect.Effect<void, BlobStoreUnavailable>;

    /**
     * Backs the Settings "Test connection" button: an IAM misconfiguration
     * comes back as a readable `detail`, not a failure.
     */
    readonly status: () => Effect.Effect<BlobStoreStatus>;
  }
>()("BlobStore") {}
