// ─── JevService ──────────────────────────────────────────────────────────────
//
// Thin Effect wrapper over TypeSafe System One (`POST /v1/systemone`): one
// state blob plus a map of named questions, answered in parallel, returning a
// typed `choice` / `score` / `noul` per key with probabilities and confidence.
// The model cannot generate text — every hook built on it is a closed-set
// judgment, never prose.
//
// Two rules the rest of the codebase depends on:
//
//   1. **Off is free.** A disabled toggle or a missing key short-circuits with
//      no network call and no latency, the same way `RemoteWalkthroughCache`
//      gates on `cache.enabled`.
//   2. **It never fails a walkthrough.** Every call site ends in
//      `Effect.catchAll(() => Effect.succeed(null))` and degrades to the
//      pre-Jev behaviour. `ask` therefore fails with exactly one error type,
//      so that collapse is total.

import type { JsonValue, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { APITimeoutError, APIUserAbortError, TypeSafeClient } from "@typesafe-ai/sdk";
import { Context, Duration, Effect, Layer } from "effect";
import { resolveJevApiKey } from "../ai/jev/api-key";
import { JevUnavailable } from "../domain/errors";
import { debug } from "../logger";
import { SecretStore } from "./SecretStore";
import { SettingsService } from "./Settings";

/**
 * Pinned rather than `jev-latest`: every threshold in the hooks that consume
 * this is calibrated against one model version, and an alias moving under us
 * would silently re-tune them all.
 */
export const JEV_MODEL = "jev-1.13.0";

/**
 * The `state` half of a request: a JSON object rather than a prose blob, so
 * questions can reference nested paths (`pr.title`, `issues.<id>.hunk`).
 * Typed against the SDK's `JsonValue` so a builder can't smuggle in a `Date`
 * or an `undefined` that would serialize to something the model reads as
 * missing. Builders live in `ai/jev/state.ts`.
 */
export type JevState = { [key: string]: JsonValue };

/**
 * Which hook a call belongs to. Used for log correlation and, later, for
 * per-hook latency attribution — the job-start call is the only one on a
 * user-visible critical path, so distinguishing it matters.
 */
export type JevCallLabel = "job-start" | "phase-c" | "issues" | "continuation" | "connection-test";

export interface JevRequest<Q extends Questions> {
  readonly label: JevCallLabel;
  /** Pre-budgeted JSON. Builders in `ai/jev/state.ts` enforce the size cap. */
  readonly state: JevState;
  readonly questions: Q;
  /**
   * Total budget for the call including the SDK's internal retries. The outer
   * `Effect.timeout` interrupts, which aborts the in-flight fetch through the
   * signal — no orphaned request outlives the budget.
   */
  readonly timeoutMs: number;
}

export class JevService extends Context.Tag("JevService")<
  JevService,
  {
    /**
     * Ask one batch of independent questions over one state.
     *
     * Questions in a single request run in parallel and cannot see each
     * other's answers, so batch everything that doesn't depend on a prior
     * answer — a second request is only warranted when an answer is needed to
     * build new state.
     *
     * Fails with {@link JevUnavailable} and nothing else. `disabled` and
     * `unconfigured` are returned without touching the network.
     */
    readonly ask: <const Q extends Questions>(
      req: JevRequest<Q>,
    ) => Effect.Effect<SystemOneResult<Q>, JevUnavailable>;

    /**
     * Whether the master switch is on *and* a key is present. Hooks call this
     * before assembling state, so an off feature costs nothing but a settings
     * read. Per-feature toggles are the caller's to check.
     */
    readonly isAvailable: () => Effect.Effect<boolean>;

    /**
     * One trivial round trip for the Settings "Test connection" button.
     *
     * Deliberately bypasses `jev.enabled`: the user pastes a key and tests it
     * *before* flipping the master switch, and failing that with "disabled"
     * would be a trap. A missing key still fails as `unconfigured`.
     */
    readonly testConnection: () => Effect.Effect<
      { readonly model: string; readonly latencyMs: number },
      JevUnavailable
    >;
  }
>() {}

/** Map an SDK rejection onto the closed reason set. */
function classify(cause: unknown): JevUnavailable {
  if (cause instanceof APITimeoutError || cause instanceof APIUserAbortError) {
    return new JevUnavailable({ reason: "timeout", cause });
  }
  return new JevUnavailable({
    reason: "transport",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const JevServiceLive: Layer.Layer<JevService, never, SettingsService | SecretStore> =
  Layer.effect(
    JevService,
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const store = yield* SecretStore;

      /**
       * Clients are cheap config holders, but rebuilding one per call would
       * also re-read the environment each time. Cache on the key so a key
       * change in Settings takes effect on the very next call.
       */
      let cached: { readonly key: string; readonly client: TypeSafeClient } | null = null;
      const clientFor = (apiKey: string): TypeSafeClient => {
        if (cached?.key === apiKey) return cached.client;
        const client = new TypeSafeClient({
          apiKey,
          defaultModel: JEV_MODEL,
          // Our `Effect.timeout` is the authoritative budget; leaving the
          // SDK's own per-attempt timeout unbounded would let a stalled
          // socket sit past it.
          timeout: 10_000,
        });
        cached = { key: apiKey, client };
        return client;
      };

      /** Settings read that can't fail the caller — a broken row means "off". */
      const jevSettings = settingsSvc.getSettings().pipe(
        Effect.map((s) => s.jev),
        Effect.orElseSucceed(() => ({ enabled: false }) as const),
      );

      const requireKey = Effect.gen(function* () {
        const apiKey = yield* resolveJevApiKey;
        if (apiKey === null) {
          return yield* Effect.fail(new JevUnavailable({ reason: "unconfigured" }));
        }
        return apiKey;
      }).pipe(Effect.provideService(SecretStore, store));

      const resolveKey = Effect.gen(function* () {
        const jev = yield* jevSettings;
        if (!jev.enabled) {
          return yield* Effect.fail(new JevUnavailable({ reason: "disabled" }));
        }
        return yield* requireKey;
      });

      return {
        ask: <const Q extends Questions>(req: JevRequest<Q>) =>
          Effect.gen(function* () {
            const apiKey = yield* resolveKey;
            const client = clientFor(apiKey);
            const startedAt = Date.now();

            const result = yield* Effect.tryPromise({
              // The signal is Effect's: an interrupt (including the timeout
              // below) aborts the HTTP request rather than leaking it.
              try: (signal) =>
                client.systemOne(
                  { state: req.state, questions: req.questions, model: JEV_MODEL },
                  { signal },
                ),
              catch: classify,
            }).pipe(
              Effect.timeoutFail({
                duration: Duration.millis(req.timeoutMs),
                onTimeout: () =>
                  new JevUnavailable({
                    reason: "timeout",
                    message: `Jev ${req.label} exceeded ${req.timeoutMs}ms`,
                  }),
              }),
            );

            if (result.answers === null || typeof result.answers !== "object") {
              return yield* Effect.fail(
                new JevUnavailable({ reason: "malformed", message: "response carried no answers" }),
              );
            }

            debug(
              "jev",
              `${req.label}: ${Object.keys(req.questions).length}q in ${Date.now() - startedAt}ms`,
              `(${result.usage.input_tokens} input tokens, ${result.model})`,
            );
            return result;
          }),

        isAvailable: () =>
          Effect.gen(function* () {
            const jev = yield* jevSettings;
            if (!jev.enabled) return false;
            const apiKey = yield* resolveJevApiKey;
            return apiKey !== null;
          }).pipe(Effect.provideService(SecretStore, store)),

        testConnection: () =>
          Effect.gen(function* () {
            const apiKey = yield* requireKey;
            const startedAt = Date.now();
            const result = yield* Effect.tryPromise({
              try: (signal) =>
                clientFor(apiKey).systemOne(
                  {
                    state: { probe: "Revv connection test." },
                    questions: {
                      reachable: {
                        type: "noul" as const,
                        instructions: "`probe` is a connection test from Revv.",
                      },
                    },
                    model: JEV_MODEL,
                  },
                  { signal },
                ),
              catch: classify,
            }).pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(15),
                onTimeout: () =>
                  new JevUnavailable({ reason: "timeout", message: "Connection test timed out" }),
              }),
            );
            return { model: result.model, latencyMs: Date.now() - startedAt };
          }),
      };
    }),
  );
