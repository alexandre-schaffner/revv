import { Effect } from "effect";
import { Elysia } from "elysia";
import { BlobStore } from "../services/blob/BlobStore";
import { adcStatus, startAdcLogin } from "../services/blob/gcloud-adc";
import { SshSigner } from "../services/cache-signing/index";
import { runRoute, withAccount, withAuth } from "./middleware";

/** Sign and verify a probe as the requesting account, to check commit signing works. */
const signingTestRoute = new Elysia().use(withAccount).post("/signing/test", (ctx) => {
  const probe = "revv-signing-test";
  return runRoute(
    Effect.gen(function* () {
      const signerSvc = yield* SshSigner;
      const signed = yield* signerSvc.sign(probe, ctx.account.accountId);
      yield* signerSvc.verify(probe, signed.signature, signed.signerHost, signed.signerLogin);
      return {
        ok: true as const,
        signerLogin: signed.signerLogin,
        signerHost: signed.signerHost,
        signatureNamespace: signed.signatureNamespace,
      };
    }).pipe(
      Effect.catch((e) =>
        Effect.succeed({
          ok: false as const,
          error: (e as { message?: string }).message ?? String(e),
        }),
      ),
    ),
  );
});

/**
 * Settings → Team cache. Every route is authed: the ADC routes spawn gcloud,
 * and a body-less POST is a CORS-simple request any web page can send.
 */
export const teamCacheRoutes = new Elysia({ prefix: "/api/settings/cache" })
  .use(signingTestRoute)
  .use(withAuth)
  .get("/status", () => runRoute(Effect.flatMap(BlobStore, (blob) => blob.status())))
  .get("/adc-status", () => runRoute(Effect.sync(adcStatus)))
  .post("/adc-login", () => runRoute(Effect.sync(startAdcLogin)));
