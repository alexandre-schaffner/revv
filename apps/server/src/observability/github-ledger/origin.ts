import { AsyncLocalStorage } from "node:async_hooks";
import { type Cause, Context, Effect } from "effect";

export type OriginKind = "request" | "background" | "boot";

interface Run {
  label: string;
  readonly kind: OriginKind;
  readonly runId: string;
}

export type Origin = Readonly<Run>;

let nextRun = 1;
const runId = () => `r${(nextRun++).toString(36)}`;

function newRun(label: string, kind: OriginKind): Run {
  return { label, kind, runId: runId() };
}

const GitHubOrigin = Context.Reference<Run | null>("GitHubOrigin", {
  defaultValue: () => null,
});

const ambientOrigin = new AsyncLocalStorage<Run>();

export function enterOrigin(label: string, kind: OriginKind): void {
  ambientOrigin.enterWith(newRun(label, kind));
}

export function relabelOrigin(label: string): void {
  const run = ambientOrigin.getStore();
  if (run) run.label = label;
}

export function currentOrigin(): Origin | undefined {
  return ambientOrigin.getStore();
}

/**
 * For runtime entry points: `effect` runs as the caller's ambient origin, read
 * now. Inside it, the Context is the only origin GitHub calls see.
 */
export function seedOriginFromAmbient<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.provideService(effect, GitHubOrigin, ambientOrigin.getStore() ?? null);
}

export const withGitHubOrigin =
  (label: string, kind: OriginKind = "background") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => Effect.provideService(effect, GitHubOrigin, newRun(label, kind)));

const underOrigin =
  <A>(origin: Run | null, thunk: (signal: AbortSignal) => PromiseLike<A>) =>
  (signal: AbortSignal): Promise<A> => {
    const start = () => Promise.resolve(thunk(signal));
    return origin ? ambientOrigin.run(origin, start) : ambientOrigin.exit(start);
  };

export function githubTryPromise<A>(
  thunk: (signal: AbortSignal) => PromiseLike<A>,
): Effect.Effect<A, Cause.UnknownError>;
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
): Effect.Effect<A, E | Cause.UnknownError> {
  return Effect.flatMap(
    GitHubOrigin,
    (origin): Effect.Effect<A, E | Cause.UnknownError> =>
      typeof arg === "function"
        ? Effect.tryPromise(underOrigin(origin, arg))
        : Effect.tryPromise({ try: underOrigin(origin, arg.try), catch: arg.catch }),
  );
}

export function githubPromise<A>(thunk: (signal: AbortSignal) => PromiseLike<A>): Effect.Effect<A> {
  return Effect.flatMap(GitHubOrigin, (origin) => Effect.promise(underOrigin(origin, thunk)));
}
