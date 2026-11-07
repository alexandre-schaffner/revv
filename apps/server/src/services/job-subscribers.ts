// Per-job SSE subscriber fan-out for a job orchestrator: events buffer until a
// subscriber flushes, then forward directly, and a subscriber is dropped after
// 3 consecutive throwing deliveries so one wedged client can't stall the others.
//
// Commit first, broadcast second (invariant 8): by the time an event reaches
// `fanOut`, the MCP tool handler (content events) or the orchestrator
// (lifecycle events) has already committed it. A delivery failure never rolls
// back state; a reconnecting subscriber recovers the truth from the DB.
//
// The subscriber set lives inside the orchestrator's run object, not in a
// registry owned here, so a stale run's teardown can't drop a newer same-id
// run's subscribers. `nextSeq` is a diagnostic counter, not a durable wire
// cursor. `fanOut` forwards every event it is handed; any filtering belongs to
// the caller.

import { debug, logError } from "../logger";

export interface SubscriberHandle<E> {
  readonly id: string;
  readonly callback: (event: E) => void;
  /** Buffer for pre-flush events. `null` after flush (direct-forward mode). */
  buffered: E[] | null;
  consecutiveFailures: number;
}

export interface SubscriberChannel<E> {
  readonly subscribers: Set<SubscriberHandle<E>>;
  /** Diagnostic-only monotonic counter assigned to every fanned-out event. */
  nextSeq: number;
}

export interface SubscriberRegistryConfig {
  readonly traceScope: string;
  readonly errorScope: string;
  readonly idLabel: string;
  /** Prefix for generated handle ids (e.g. "h" → "h1", "" → "1"). */
  readonly handleIdPrefix: string;
}

export interface SubscriberSubscription {
  readonly unsubscribe: () => void;
  readonly flush: () => void;
}

export interface SubscriberRegistry<E extends { readonly type: string }> {
  /** Returns the diagnostic seq assigned to the event. */
  readonly fanOut: (jobId: string, channel: SubscriberChannel<E>, event: E) => number;
  /** The caller checks its own job registry for the job before calling this. */
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
              handle.consecutiveFailures = 0;
            } catch (err) {
              // Same 3-strike error budget as `fanOut`: a buffered replay can
              // be many events, so a wedged client must be droppable here too.
              handle.consecutiveFailures += 1;
              if (handle.consecutiveFailures >= 3) {
                channel.subscribers.delete(handle);
                logError(
                  errorScope,
                  `subscriber dropped after 3 consecutive failures during flush ${idLabel}=${jobId} handle=${handleId}:`,
                  err instanceof Error ? err.message : String(err),
                );
                break;
              }
              logError(
                errorScope,
                `subscriber flush threw (${handle.consecutiveFailures}/3) ${idLabel}=${jobId} handle=${handleId} type=${event.type}:`,
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
