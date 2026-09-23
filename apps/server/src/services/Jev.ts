// ─── JevService ──────────────────────────────────────────────────────────────
//
// Thin Effect wrapper over TypeSafe System One (`POST /v1/systemone`): one
// state blob plus named questions, answered in parallel as typed
// choice/score/noul judgments, never prose.
//
// Two invariants: (1) off is free — disabled toggle or missing key
// short-circuits with no network call, like `RemoteWalkthroughCache` gating
// on `cache.enabled`. (2) never fails a walkthrough — every call site
// collapses failure to `null` (`ai/jev/optional.ts`); `ask` fails with
// exactly one error type so that collapse is total.

import type { JsonValue, Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { APITimeoutError, APIUserAbortError, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { Context, Duration, Effect, Layer } from "effect";
import { resolveJevApiKey } from "../ai/jev/api-key";
import { JevUnavailable } from "../domain/errors";
import { debug } from "../logger";
import { SecretStore } from "./SecretStore";
import { SettingsService } from "./Settings";

/** Pinned, not `jev-latest`: consuming hooks calibrate thresholds against one model version. */
export const JEV_MODEL = "jev-1.13.0";

/**
 * JSON object, not prose, so questions can reference nested paths (`pr.title`,
 * `issues.<id>.hunk`). Typed against the SDK's `JsonValue` so a builder can't
 * smuggle in a `Date`/`undefined`. Builders live in `ai/jev/state.ts`.
 */
export type JevState = { [key: string]: JsonValue };

/** Which hook a call belongs to, for log correlation. */
export type JevCallLabel =
  | "job-start"
  | "issues"
  | "artifact"
  | "prose"
  | "continuation"
  | "connection-test";

export interface JevRequest<Q extends Questions> {
  readonly label: JevCallLabel;
  /** Pre-budgeted JSON. Builders in `ai/jev/state.ts` enforce the size cap. */
  readonly state: JevState;
  readonly questions: Q;
  /** Total budget including the SDK's internal retries; `Effect.timeout` interrupt aborts the in-flight fetch via signal. */
  readonly timeoutMs: number;
}

export class JevService extends Context.Tag("JevService")<
  JevService,
  {
    /**
     * Ask one batch of independent questions over one state. Questions run in
     * parallel and can't see each other's answers — batch everything that
     * doesn't depend on a prior answer.
     *
     * Fails with {@link JevUnavailable} only; `disabled`/`unconfigured` never touch the network.
     */
    readonly ask: <const Q extends Questions>(
      req: JevRequest<Q>,
    ) => Effect.Effect<SystemOneResult<Q>, JevUnavailable>;

    /**
     * Whether the master switch is on *and* a key is present. Per-feature
     * toggles are the caller's to check.
     */
    readonly isAvailable: () => Effect.Effect<boolean>;

    /**
     * Round trip for the Settings "Test connection" button. Bypasses
     * `jev.enabled` since the user tests a key before flipping the master
     * switch. A missing key still fails as `unconfigured`.
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

      /** Cached on the key so a key change in Settings takes effect on the very next call. */
      let cached: { readonly key: string; readonly client: TypeSafeClient } | null = null;
      const clientFor = (apiKey: string): TypeSafeClient => {
        if (cached?.key === apiKey) return cached.client;
        const client = new TypeSafeClient({
          apiKey,
          defaultModel: JEV_MODEL,
          // `Effect.timeout` is the authoritative budget; unbounded here would let a stalled socket outlive it.
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
                    questions: { reachable: noul("`probe` is a connection test from Revv.") },
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
