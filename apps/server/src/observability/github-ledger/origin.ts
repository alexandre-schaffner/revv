// ── Who asked GitHub ────────────────────────────────────────────────────────
//
// Every GitHub request the ledger records carries the origin that caused it:
// the HTTP route a client hit, or the background loop that woke up. An origin
// is one *run* (a request, a poll cycle) so the analyzer can tell a waterfall
// inside one page load from two page loads that happened to overlap.
//
// Two carriers. `AsyncLocalStorage` holds the ambient origin: the request
// hook sets it, and it follows the work through awaits and Effect fibers
// alike. But ALS can only be scoped around a callback, so a loop that wants
// to name its own run partway through an Effect (`withGitHubOrigin`) puts the
// origin in the Effect's Context instead, which forked fibers inherit.
// `githubTryPromise` reconciles the two where the promise that talks to
// GitHub starts: a named run wins, else the ambient origin stands.

import { AsyncLocalStorage } from "node:async_hooks";
import { type Cause, Context, Effect } from "effect";

export type OriginKind = "request" | "background" | "boot";

export interface Origin {
  /** `GET /api/prs/:id/conversation`, `poll:sync:periodic`, `boot`. */
  label: string;
  readonly kind: OriginKind;
  /** One request or one loop iteration. */
  readonly runId: string;
}

let nextRun = 1;
const runId = () => `r${(nextRun++).toString(36)}`;

export function newOrigin(label: string, kind: OriginKind): Origin {
  return { label, kind, runId: runId() };
}

/** A run an Effect named for itself; null defers to the ambient origin. */
export class GitHubOrigin extends Context.Reference<GitHubOrigin>()("GitHubOrigin", {
  defaultValue: (): Origin | null => null,
}) {}

export const originStore = new AsyncLocalStorage<Origin>();

/** Run `effect` as a fresh run of `label`; GitHub calls inside are attributed to it. */
export const withGitHubOrigin =
  (label: string, kind: OriginKind = "background") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => Effect.provideService(effect, GitHubOrigin, newOrigin(label, kind)));

/** Run `thunk` with the fiber's origin in ALS, so every `await` inside it keeps it. */
const underOrigin =
  <A>(origin: Origin | null, thunk: (signal: AbortSignal) => PromiseLike<A>) =>
  (signal: AbortSignal): Promise<A> =>
    origin
      ? originStore.run(origin, () => Promise.resolve(thunk(signal)))
      : Promise.resolve(thunk(signal));

/**
 * `Effect.tryPromise` for a promise that talks to GitHub: the fiber's origin
 * rides into the promise (and every `await` inside it) through ALS.
 */
export function githubTryPromise<A>(
  thunk: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, Cause.UnknownException>;
export function githubTryPromise<A, E>(options: {
  readonly try: (signal: AbortSignal) => PromiseLike<A>;
  readonly catch: (error: unknown) => E;
}): Effect.Effect<A, E>;
export function githubTryPromise<A, E>(
  arg:
    | ((signal: AbortSignal) => PromiseLike<A>)
    | {
        readonly try: (signal: AbortSignal) => PromiseLike<A>;
        readonly catch: (error: unknown) => E;
      },
): Effect.Effect<A, E | Cause.UnknownException> {
  return Effect.flatMap(
    GitHubOrigin,
    (origin): Effect.Effect<A, E | Cause.UnknownException> =>
      typeof arg === "function"
        ? Effect.tryPromise(underOrigin(origin, arg))
        : Effect.tryPromise({ try: underOrigin(origin, arg.try), catch: arg.catch }),
  );
}

/** `Effect.promise` for a GitHub promise that can't fail. */
export function githubPromise<A>(thunk: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A> {
  return Effect.flatMap(GitHubOrigin, (origin) => Effect.promise(underOrigin(origin, thunk)));
}
