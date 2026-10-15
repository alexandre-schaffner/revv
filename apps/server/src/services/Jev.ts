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
import {
  APITimeoutError,
  APIUserAbortError,
  noul,
  RateLimitError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { Context, Duration, Effect, Layer, RateLimiter } from "effect";
import { resolveJevApiKey } from "../ai/jev/api-key";
import { JevUnavailable } from "../domain/errors";
import { debug } from "../logger";
import { SecretStore } from "./SecretStore";
import { SettingsService } from "./Settings";

/** Pinned, not `jev-latest`: consuming hooks calibrate thresholds against one model version. */
export const JEV_MODEL = "jev-1.13.0";

/**
 * Requests per second across every hook. TypeSafe allows 1,200 a minute per
 * key; staying just under keeps a large first pass from tripping the quota
 * and failing its own tail, or starving the Phase-B hooks of the same key.
 */
const JEV_REQUESTS_PER_SECOND = 18;

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
  | "hunk-scan"
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

/**
 * The SDK's default retry set minus 429. Waiting out a `Retry-After` (up to
 * 60 s by default) inside a call whose budget is a few seconds turns every
 * rate limit into a `timeout`, which the first pass's circuit breaker counts
 * as Jev being down. A 429 surfaces as `rate_limited` instead, which the
 * first pass waits out and the other call sites degrade on.
 */
const RETRIED_STATUSES: ReadonlySet<number> = new Set([
  408,
  ...Array.from({ length: 100 }, (_, i) => 500 + i),
]);

/** Map an SDK rejection onto the closed reason set. */
function classify(cause: unknown): JevUnavailable {
  if (cause instanceof APITimeoutError || cause instanceof APIUserAbortError) {
    return new JevUnavailable({ reason: "timeout", cause });
  }
  if (cause instanceof RateLimitError) {
    return new JevUnavailable({
      reason: "rate_limited",
      message: cause.message,
      ...(cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs }),
      cause,
    });
  }
  return new JevUnavailable({
    reason: "transport",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export const JevServiceLive: Layer.Layer<JevService, never, SettingsService | SecretStore> =
  Layer.scoped(
    JevService,
    Effect.gen(function* () {
      const settingsSvc = yield* SettingsService;
      const store = yield* SecretStore;
      const paced = yield* RateLimiter.make({
        limit: JEV_REQUESTS_PER_SECOND,
        interval: "1 seconds",
      });

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
            // Paced before the clock starts: waiting for a slot isn't Jev being slow.
            const [elapsed, response] = yield* paced(
              Effect.tryPromise({
                // The signal is Effect's: an interrupt (including the timeout
                // below) aborts the HTTP request rather than leaking it.
                try: (signal) =>
                  client.systemOne(
                    { state: req.state, questions: req.questions, model: JEV_MODEL },
                    { signal, retry: { httpStatuses: RETRIED_STATUSES } },
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
                Effect.timed,
              ),
            );

            if (response.answers === null || typeof response.answers !== "object") {
              return yield* Effect.fail(
                new JevUnavailable({ reason: "malformed", message: "response carried no answers" }),
              );
            }

            debug(
              "jev",
              `${req.label}: ${Object.keys(req.questions).length}q in ${Math.round(Duration.toMillis(elapsed))}ms`,
              `(${response.usage.input_tokens} input tokens, ${response.model})`,
            );
            return response;
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
