// Update-manifest dispatcher for the Tauri auto-updater.
//
// `tauri-plugin-updater` reads its endpoint list from `tauri.conf.json` at
// compile time and offers no runtime override. To let the user switch
// between stable and nightly channels without rebuilding the app, the static
// endpoint points here, and this route reads the `update_channel` setting
// and proxies the matching GitHub release manifest.
//
// The route is intentionally unauthenticated — the updater plugin runs in
// the Rust host and doesn't forward bearer tokens, and the server only binds
// to 127.0.0.1, so external reach isn't a concern.
//
// PUT /api/update-channel is the write path for the `revv` CLI (no GET
// counterpart: the CLI reads directly from SQLite, which is the source of
// truth — going through the server only matters for writes so the in-memory
// SettingsService cache stays consistent with the persisted column).

import { Effect } from "effect";
import { Elysia } from "elysia";
import { AppRuntime } from "../runtime";
import { SettingsService } from "../services/Settings";
import { updateChannelSchema } from "./schemas";

const GITHUB_REPO = "alexandre-schaffner/revv";
const STABLE_MANIFEST_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`;
// Same filename inside the moving `nightly` tag — the tag is what selects
// the channel, the filename inside the release is just `latest.json` for
// both pipelines so we don't need a post-build rename step in CI.
const NIGHTLY_MANIFEST_URL = `https://github.com/${GITHUB_REPO}/releases/download/nightly/latest.json`;

export const updateManifestRoute = new Elysia()
  .get("/api/update-manifest", async () => {
    const channel = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const s = yield* settings.getSettings();
        return s.updateChannel;
      }).pipe(Effect.orElseSucceed(() => "stable" as const)),
    );

    const target = channel === "nightly" ? NIGHTLY_MANIFEST_URL : STABLE_MANIFEST_URL;

    // The updater plugin treats any non-2xx as "no update available". When
    // the nightly tag hasn't been published yet, returning 204 keeps the
    // toast silent rather than surfacing a bogus error.
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    if (upstream.status === 404) return new Response(null, { status: 204 });
    if (!upstream.ok) return new Response(null, { status: 502 });

    return new Response(await upstream.text(), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  })
  .put(
    "/api/update-channel",
    async (ctx) => {
      const updated = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const settings = yield* SettingsService;
          return yield* settings.updateSettings({ updateChannel: ctx.body.channel });
        }),
      );
      return { channel: updated.updateChannel };
    },
    {
      body: updateChannelSchema.put,
    },
  );
