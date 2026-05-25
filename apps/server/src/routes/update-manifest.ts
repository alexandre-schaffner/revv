// Update-manifest dispatcher for the Tauri auto-updater.
//
// `tauri-plugin-updater` reads its endpoint list from `tauri.conf.json` at
// compile time and offers no runtime override. Release builds also reject
// insecure updater endpoints, so the packaged desktop app points directly at
// the HTTPS stable manifest. This local route remains for source installs and
// CLI-managed channel experiments that already have the local API server up.
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
// Nightly uses per-SHA tags (`nightly-<short-sha>`) because GitHub's
// immutable-releases feature permanently reserves any tag used by a release,
// making a moving `nightly` tag a one-shot. We resolve "latest nightly" at
// request time by listing releases and picking the newest prerelease whose
// tag starts with `nightly-`. The asset filename inside each release is just
// `latest.json` (same as stable) so no post-build rename step is needed.
const NIGHTLY_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=30`;
const NIGHTLY_TAG_PREFIX = "nightly-";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}
interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubAsset[];
}

async function resolveNightlyManifestUrl(): Promise<string | null> {
  const res = await fetch(NIGHTLY_RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const releases = (await res.json()) as GitHubRelease[];
  // The releases API returns results sorted by published_at desc, so the
  // first matching entry is the newest nightly.
  const nightly = releases.find(
    (r) => r.prerelease && !r.draft && r.tag_name.startsWith(NIGHTLY_TAG_PREFIX),
  );
  if (!nightly) return null;
  const asset = nightly.assets.find((a) => a.name === "latest.json");
  return asset?.browser_download_url ?? null;
}

export const updateManifestRoute = new Elysia()
  .get("/api/update-manifest", async () => {
    const channel = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const s = yield* settings.getSettings();
        return s.updateChannel;
      }).pipe(Effect.orElseSucceed(() => "stable" as const)),
    );

    let target: string | null;
    if (channel === "nightly") {
      target = await resolveNightlyManifestUrl();
      // No nightly published yet — keep the toast silent.
      if (!target) return new Response(null, { status: 204 });
    } else {
      target = STABLE_MANIFEST_URL;
    }

    // The updater plugin treats any non-2xx as "no update available". When
    // the tag hasn't been published yet, returning 204 keeps the toast
    // silent rather than surfacing a bogus error.
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
