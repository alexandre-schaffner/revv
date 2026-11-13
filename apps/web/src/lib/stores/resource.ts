// The one way a store fetches something per key: concurrent asks de-dupe onto
// one request, an answer can be served fresh for a while, a `pending` answer
// (the server is still working) waits for the server's completion signal or is
// asked again on a bounded schedule, a superseded or reset ask can't write
// back, and every key's state is a `RequestState<T>`.
//
// A store either keeps its data here (`data(key)`), or keeps its own state and
// lets its fetcher write it, using the resource only to schedule asks.
//
// Each key remembers the argument it was last asked with, so a store can ask
// again by key alone (a completion signal, a reconnect) without packing the
// argument into the key string.

import { SvelteMap } from "svelte/reactivity";
import { thrownMessage } from "$lib/api/wire";
import { RequestState } from "./_types";

/** One ask's outcome. `pending` waits for a signal, or is asked again after the next retry delay. */
export type Answer<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "pending"; readonly data?: T }
  | { readonly status: "error"; readonly error: string };

export interface ResourceEntry<T> {
  /** The last answer. An `ok` stays up while the key is asked again. */
  readonly request: RequestState<T>;
  /** An ask is in flight, or a `pending` answer will be asked again. */
  readonly loading: boolean;
  /** The retry schedule ran out while the answer was still `pending`. */
  readonly gaveUp: boolean;
  /** Identity of the inputs the answer was asked with; a different one supersedes it. */
  readonly version: string;
  /** When data last arrived; 0 before any. */
  readonly loadedAt: number;
}

export interface ResourceOptions<A, T> {
  readonly fetch: (key: string, arg: A) => Promise<Answer<T>>;
  /** How long a settled `ok` is served without asking again. 0 (default): every load asks. */
  readonly freshForMs?: number;
  /** Delay before re-asking after each `pending` answer; once used up, the key gives up. */
  readonly retryDelaysMs?: readonly number[];
  /**
   * A `pending` answer is not asked again on a timer: the server announces
   * completion, and the store's handler calls `refresh`, `put` or `giveUp`.
   * The key gives up on its own after this long without one.
   */
  readonly waitForSignalMs?: number;
  /** An error after an `ok` keeps the data on screen instead of replacing it. */
  readonly keepDataOnError?: boolean;
  /** The error a key with no data shows when it gives up. */
  readonly gaveUpError?: string;
}

export interface Resource<A, T> {
  entry(key: string): ResourceEntry<T>;
  data(key: string): T | null;
  /**
   * Ask for `key` unless an ask with the same `version` is in flight, being
   * retried, or answered within `freshForMs`. A different `version` supersedes
   * whatever is running. Resolves with the key's state once this ask lands.
   */
  load(key: string, arg: A, version?: string): Promise<RequestState<T>>;
  /** Ask now; if an ask is in flight, ask once more after it lands. */
  refresh(key: string, arg: A): Promise<RequestState<T>>;
  /** Settle `key` with data the server pushed, superseding any ask. */
  put(key: string, data: T): void;
  /** Stop waiting on a `pending` key: the server stopped working on it. */
  giveUp(key: string): void;
  /**
   * Whether a signal for `key` is due: it holds a `pending` answer, or an ask
   * whose answer may be `pending` is in flight (the signal can beat the
   * response). Always false without `waitForSignalMs`.
   */
  isWaiting(key: string): boolean;
  /** The argument `key` was last asked with; undefined when it never was, or was forgotten. */
  argOf(key: string): A | undefined;
  /** Ask again every key that was asked (and `match`es), with its last argument. */
  refreshAll(match?: (key: string, arg: A) => boolean): void;
  /** Ask again every key {@link isWaiting} on a signal (and `match`es), with its last argument. */
  refreshWaiting(match?: (key: string, arg: A) => boolean): void;
  /** Forget `key`; an ask in flight for it can't write back. */
  invalidate(key: string): void;
  reset(): void;
}

const IDLE: ResourceEntry<never> = Object.freeze({
  request: RequestState.idle<never>(),
  loading: false,
  gaveUp: false,
  version: "",
  loadedAt: 0,
});

/** Resources that wait on a server signal: a reconnect re-asks their waiting keys. */
const signalWaiters = new Set<{ refreshWaiting(): void }>();

/**
 * Signals sent while the event stream was down reached no one: every key
 * waiting on one is asked again.
 */
export function refreshAllWaiting(): void {
  for (const resource of signalWaiters) resource.refreshWaiting();
}

export function createResource<A, T>(options: ResourceOptions<A, T>): Resource<A, T> {
  const { freshForMs = 0, retryDelaysMs = [], keepDataOnError = false } = options;
  const waitForSignalMs = options.waitForSignalMs;
  const entries = new SvelteMap<string, ResourceEntry<T>>();
  const inflight = new Map<string, Promise<RequestState<T>>>();
  const askAgain = new Map<string, A>();
  const args = new Map<string, A>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const generations = new Map<string, number>();
  /** Keys whose last answer was `ok`; only those are ever served fresh. */
  const settled = new Set<string>();

  function entry(key: string): ResourceEntry<T> {
    return entries.get(key) ?? IDLE;
  }

  function isFresh(key: string, e: ResourceEntry<T>): boolean {
    return settled.has(key) && Date.now() - e.loadedAt < freshForMs;
  }

  function cancel(key: string): number {
    clearTimeout(retryTimers.get(key));
    retryTimers.delete(key);
    askAgain.delete(key);
    inflight.delete(key);
    settled.delete(key);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  }

  function start(key: string, arg: A, version: string): Promise<RequestState<T>> {
    const generation = cancel(key);
    args.set(key, arg);
    const previous = entry(key);
    entries.set(key, {
      request: previous.request.status === "ok" ? previous.request : RequestState.loading(),
      loading: true,
      gaveUp: false,
      version,
      loadedAt: previous.loadedAt,
    });
    return ask(key, arg, generation, 0);
  }

  function settle(key: string, answer: Answer<T>, attempt: number, retry: () => void): void {
    const previous = entry(key);
    const now = Date.now();
    if (answer.status === "ok") settled.add(key);
    else settled.delete(key);
    switch (answer.status) {
      case "ok":
        entries.set(key, {
          ...previous,
          request: RequestState.ok(answer.data),
          loading: false,
          gaveUp: false,
          loadedAt: now,
        });
        return;
      case "error":
        entries.set(key, {
          ...previous,
          request:
            keepDataOnError && previous.request.status === "ok"
              ? previous.request
              : RequestState.error(answer.error),
          loading: false,
        });
        return;
      case "pending": {
        const hasData = answer.data !== undefined;
        const request = hasData ? RequestState.ok(answer.data as T) : previous.request;
        const loadedAt = hasData ? now : previous.loadedAt;
        const delay = waitForSignalMs ?? retryDelaysMs[attempt];
        if (delay === undefined) {
          entries.set(key, { ...previous, loadedAt });
          markGaveUp(key, request);
          return;
        }
        entries.set(key, { ...previous, request, loading: true, loadedAt });
        retryTimers.set(
          key,
          setTimeout(() => {
            retryTimers.delete(key);
            if (waitForSignalMs === undefined) retry();
            else markGaveUp(key, entry(key).request);
          }, delay),
        );
      }
    }
  }

  function markGaveUp(key: string, request: RequestState<T>): void {
    entries.set(key, {
      ...entry(key),
      request:
        request.status === "ok"
          ? request
          : RequestState.error(options.gaveUpError ?? "Still not ready; gave up waiting"),
      loading: false,
      gaveUp: true,
    });
  }

  function isWaiting(key: string): boolean {
    return waitForSignalMs !== undefined && (retryTimers.has(key) || inflight.has(key));
  }

  function ask(key: string, arg: A, generation: number, attempt: number): Promise<RequestState<T>> {
    const current = () => generations.get(key) === generation;
    const promise: Promise<RequestState<T>> = (async () => {
      let answer: Answer<T>;
      try {
        answer = await options.fetch(key, arg);
      } catch (e) {
        answer = { status: "error", error: thrownMessage(e) };
      }
      if (current()) {
        settle(key, answer, attempt, () => {
          if (current()) void ask(key, arg, generation, attempt + 1);
        });
      }
      return entry(key).request;
    })().finally(() => {
      if (inflight.get(key) !== promise) return;
      inflight.delete(key);
      if (askAgain.has(key)) {
        const next = askAgain.get(key) as A;
        void start(key, next, entry(key).version);
      }
    });
    inflight.set(key, promise);
    return promise;
  }

  function refreshWhere(keep: (key: string) => boolean, match?: (key: string, arg: A) => boolean) {
    for (const [key, arg] of [...args]) {
      if (keep(key) && (match?.(key, arg) ?? true)) void resource.refresh(key, arg);
    }
  }

  const resource: Resource<A, T> = {
    entry,
    data(key) {
      const request = entry(key).request;
      return request.status === "ok" ? request.data : null;
    },
    load(key, arg, version = "") {
      const e = entries.get(key);
      if (e && e.version === version) {
        const running = inflight.get(key);
        if (running) return running;
        if (retryTimers.has(key) || isFresh(key, e)) return Promise.resolve(e.request);
      }
      return start(key, arg, version);
    },
    refresh(key, arg) {
      const running = inflight.get(key);
      if (running) {
        askAgain.set(key, arg);
        args.set(key, arg);
        return running;
      }
      return start(key, arg, entry(key).version);
    },
    put(key, data) {
      if (!entries.has(key)) return;
      cancel(key);
      settled.add(key);
      entries.set(key, {
        ...entry(key),
        request: RequestState.ok(data),
        loading: false,
        gaveUp: false,
        loadedAt: Date.now(),
      });
    },
    giveUp(key) {
      if (!isWaiting(key)) return;
      cancel(key);
      markGaveUp(key, entry(key).request);
    },
    isWaiting,
    argOf(key) {
      return args.get(key);
    },
    refreshAll(match) {
      refreshWhere(() => true, match);
    },
    refreshWaiting(match) {
      refreshWhere(isWaiting, match);
    },
    invalidate(key) {
      cancel(key);
      entries.delete(key);
      args.delete(key);
    },
    reset() {
      for (const key of new Set([...entries.keys(), ...inflight.keys(), ...retryTimers.keys()])) {
        cancel(key);
      }
      entries.clear();
      args.clear();
    },
  };
  if (waitForSignalMs !== undefined) signalWaiters.add(resource);
  return resource;
}
