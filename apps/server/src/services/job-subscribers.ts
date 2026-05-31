// ── Subscriber fan-out ─────────────────────────────────────────────────────
//
// Shared SSE subscriber fan-out for the two durable job orchestrators
// (walkthrough, recap). Both maintain a set of per-job subscribers that
// receive a live event stream; both buffer pre-flush events, forward directly
// post-flush, and drop a subscriber after 3 consecutive throwing deliveries (a
// per-subscriber error budget so one wedged client can't stall the others).
//
// Commit-first / broadcast-second (CLAUDE.md invariant #8): by the time an
// event reaches `fanOut`, the MCP tool handler (content events) or the
// orchestrator (lifecycle events) has already committed the DB write. A
// delivery failure here never rolls back state — a reconnecting subscriber
// recovers the truth from the DB.
//
// Subscriber state (the `Set` + the diagnostic `nextSeq`) deliberately lives
// INSIDE each orchestrator's job object, not in a registry owned here: that is
// what lets the orchestrator's own registry identity-guard protect it (a stale
// job's teardown can't drop a newer same-id job's subscribers, because the set
// is part of the old object). This module owns only the *algorithm*.
//
// NOTE (invariant boundary): the diagnostic `nextSeq` counter bumped here is
// NOT the durable wire cursor. Walkthrough's `emitEvent` stamps the
// authoritative, kill-9-surviving seq separately via `walkthroughService.bumpSeq`.
// Keep the two distinct. Likewise, any re-entrancy guard (e.g. dropping
// `thinking` heartbeats) lives in the orchestrator's concrete emit caller, not
// here — `fanOut` forwards every event it is handed.

import { debug, logError } from "../logger";

export interface SubscriberHandle<E> {
  /** Short opaque id for diagnostic logging. */
  readonly id: string;
  readonly callback: (event: E) => void;
  /** Buffer for pre-flush events. `null` after flush (direct-forward mode). */
  buffered: E[] | null;
  /**
   * Consecutive failure counter for the per-subscriber error budget.
   * Incremented on every throw from the callback; reset to 0 on each
   * successful invocation. Subscriber is dropped after 3 consecutive throws.
   */
  consecutiveFailures: number;
}

/**
 * Minimal shape the fan-out algorithm operates on. Each orchestrator's job
 * object (`ActiveJob` / `ActiveRecapJob`) structurally satisfies this.
 */
export interface SubscriberChannel<E> {
  readonly subscribers: Set<SubscriberHandle<E>>;
  /** Diagnostic-only monotonic counter assigned to every fanned-out event. */
  nextSeq: number;
}

export interface SubscriberRegistryConfig {
  /** `debug()` scope for the verbose trace lines (e.g. "wt-trace"). */
  readonly traceScope: string;
  /** `logError()` scope for subscriber-failure lines (e.g. "walkthrough-jobs"). */
  readonly errorScope: string;
  /** Job-id label used in log lines (e.g. "wt" / "recap"). */
  readonly idLabel: string;
  /** Prefix for generated handle ids (e.g. "h" → "h1", "" → "1"). */
  readonly handleIdPrefix: string;
}

export interface SubscriberSubscription {
  readonly unsubscribe: () => void;
  readonly flush: () => void;
}

export interface SubscriberRegistry<E extends { readonly type: string }> {
  /**
   * Deliver `event` to every subscriber on `channel`, buffering or forwarding
   * per handle and enforcing the 3-strike error budget. Returns the diagnostic
   * seq assigned to this event.
   */
  readonly fanOut: (jobId: string, channel: SubscriberChannel<E>, event: E) => number;
  /**
   * Register a new subscriber on `channel`. The caller is responsible for the
   * `found`/miss check against its own job registry before calling this.
   */
  readonly subscribe: (
    jobId: string,
    channel: SubscriberChannel<E>,
    onEvent: (event: E) => void,
  ) => SubscriberSubscription;
}

export const makeSubscriberRegistry = <E extends { readonly type: string }>(
  config: SubscriberRegistryConfig,
): SubscriberRegistry<E> => {
  const { traceScope, errorScope, idLabel, handleIdPrefix } = config;
  let nextHandleId = 1;

  const fanOut = (jobId: string, channel: SubscriberChannel<E>, event: E): number => {
    const seq = channel.nextSeq++;
    const subsCount = channel.subscribers.size;
    debug(traceScope, `fanOut ${idLabel}=${jobId} seq=${seq} type=${event.type} subs=${subsCount}`);
    if (subsCount === 0) {
      debug(traceScope, `fanOut-no-subscribers ${idLabel}=${jobId} seq=${seq} type=${event.type}`);
    }
    // Collect subscribers to drop (can't modify Set while iterating).
    const toDrop: SubscriberHandle<E>[] = [];
    for (const handle of channel.subscribers) {
      try {
        if (handle.buffered !== null) {
          handle.buffered.push(event);
          debug(
            traceScope,
            `fanOut-buffered ${idLabel}=${jobId} seq=${seq} type=${event.type} handle=${handle.id} bufLen=${handle.buffered.length}`,
          );
        } else {
          handle.callback(event);
          debug(
            traceScope,
            `fanOut-delivered ${idLabel}=${jobId} seq=${seq} type=${event.type} handle=${handle.id}`,
          );
        }
        handle.consecutiveFailures = 0;
      } catch (err) {
        handle.consecutiveFailures += 1;
        if (handle.consecutiveFailures >= 3) {
          toDrop.push(handle);
          logError(
            errorScope,
            `subscriber dropped after 3 consecutive failures ${idLabel}=${jobId} seq=${seq} handle=${handle.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        } else {
          logError(
            errorScope,
            `subscriber threw (${handle.consecutiveFailures}/3) ${idLabel}=${jobId} seq=${seq} type=${event.type} handle=${handle.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    for (const handle of toDrop) {
      channel.subscribers.delete(handle);
    }
    return seq;
  };

  const subscribe = (
    jobId: string,
    channel: SubscriberChannel<E>,
    onEvent: (event: E) => void,
  ): SubscriberSubscription => {
    const handleId = `${handleIdPrefix}${nextHandleId++}`;
    const handle: SubscriberHandle<E> = {
      id: handleId,
      callback: onEvent,
      buffered: [],
      consecutiveFailures: 0,
    };
    channel.subscribers.add(handle);
    debug(
      traceScope,
      `subscribe ${idLabel}=${jobId} handle=${handleId} subs=${channel.subscribers.size} nextSeq=${channel.nextSeq}`,
    );

    return {
      unsubscribe: () => {
        const removed = channel.subscribers.delete(handle);
        debug(
          traceScope,
          `unsubscribe ${idLabel}=${jobId} handle=${handleId} removed=${removed} subs=${channel.subscribers.size}`,
        );
      },
      flush: () => {
        const buf = handle.buffered;
        handle.buffered = null;
        const flushed = buf?.length ?? 0;
        debug(traceScope, `flush ${idLabel}=${jobId} handle=${handleId} flushedEvents=${flushed}`);
        if (buf) {
          for (const event of buf) {
            try {
              onEvent(event);
            } catch (err) {
              logError(
                errorScope,
                `subscriber flush threw ${idLabel}=${jobId} handle=${handleId} type=${event.type}:`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
      },
    };
  };

  return { fanOut, subscribe };
};
