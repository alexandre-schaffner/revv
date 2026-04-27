import { Context, Effect, Layer, PubSub, Stream } from "effect";

/**
 * Server-internal invalidation bus.
 *
 * Publishers (`PollScheduler`, `Sync`, mutation routes) emit high-level
 * domain events; subscribers translate those events into:
 *
 *   1. Cross-namespace cache drops (cache-cascade subscriber).
 *   2. `cache:invalidated` WebSocket fan-out to clients.
 *   3. A short-window ring buffer that powers `/api/cache/stats`
 *      ("invalidationsLastHour").
 *
 * The bus itself is transport-neutral — it doesn't know about caches or
 * WebSockets. That's intentional: adding a new subscriber is a layer-only
 * concern, no publisher has to change.
 *
 * ### Event taxonomy
 *
 * Events are domain-shaped, not cache-shaped. "This PR's head SHA
 * changed" is a fact about the world; mapping it to three different cache
 * invalidations is the subscriber's responsibility.
 */

export type InvalidationEvent =
  | {
      readonly kind: "pr:sha-changed";
      readonly prId: string;
      readonly headSha: string;
      readonly baseSha: string;
      readonly previousHeadSha: string | null;
      readonly previousBaseSha: string | null;
    }
  | { readonly kind: "pr:closed"; readonly prId: string }
  | {
      readonly kind: "pr:comments-synced";
      readonly prId: string;
      readonly watermark: string;
      readonly hadChanges: boolean;
    }
  | {
      readonly kind: "pr:threads-fingerprint-changed";
      readonly prId: string;
      readonly fingerprint: string | null;
    }
  | { readonly kind: "repo:added"; readonly repoId: string }
  | { readonly kind: "repo:deleted"; readonly repoId: string }
  | { readonly kind: "repos:updated" }
  | { readonly kind: "user:changed"; readonly userId: string }
  | {
      readonly kind: "namespace:bulk";
      readonly namespace: string;
      readonly reason: string;
    };

export interface InvalidationBusService {
  /** Publish an event. Non-blocking — delivers to all current subscribers. */
  readonly publish: (event: InvalidationEvent) => Effect.Effect<void>;
  /**
   * Stream helper — consumers use `Stream.runForEach` (scoped) to process
   * events. Slow consumers back-pressure themselves, not the publisher.
   *
   * Subscribers that want to live for the app lifetime should fork a fiber
   * that runs `Stream.runForEach(bus.stream(), handler)` under a long-lived
   * scope (e.g. the main AppLayer scope).
   */
  readonly stream: () => Stream.Stream<InvalidationEvent, never, never>;
  /**
   * Recent-events ring buffer (used by `/api/cache/stats`). Capped at
   * the last hour's worth.
   */
  readonly recent: () => Effect.Effect<ReadonlyArray<RecentEvent>>;
}

export interface RecentEvent {
  readonly kind: InvalidationEvent["kind"];
  readonly at: string;
}

export class InvalidationBus extends Context.Tag("InvalidationBus")<
  InvalidationBus,
  InvalidationBusService
>() {}

const HOUR_MS = 60 * 60 * 1000;

export const InvalidationBusLive = Layer.scoped(
  InvalidationBus,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<InvalidationEvent>();

    // Ring buffer — cheap mutable array, pruned on each publish.
    const recentBuf: RecentEvent[] = [];

    const publish = (event: InvalidationEvent) =>
      Effect.gen(function* () {
        recentBuf.push({ kind: event.kind, at: new Date().toISOString() });
        const now = Date.now();
        // Drop anything older than an hour.
        while (
          recentBuf.length > 0 &&
          now - Date.parse(recentBuf[0]!.at) > HOUR_MS
        ) {
          recentBuf.shift();
        }
        yield* pubsub.publish(event);
      });

    const stream = () => Stream.fromPubSub(pubsub);

    const recent = () => Effect.sync(() => recentBuf.slice());

    return { publish, stream, recent } satisfies InvalidationBusService;
  }),
);
