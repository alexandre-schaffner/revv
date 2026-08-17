// Update-manifest dispatcher for the Tauri auto-updater.
//
// `tauri-plugin-updater` reads its endpoint list from `tauri.conf.json` at
// compile time and offers no runtime override, so a channel switch cannot
// change which URL it fetches. This route is that indirection: the desktop
// app's first endpoint is `http://localhost:45678/api/update-manifest`, and
// the channel is resolved here, per request, from SQLite. Switching channels
// therefore takes effect on the next check with no rebuild and no restart.
//
// The plugin normally refuses non-HTTPS endpoints in release builds; the app
// opts out via `dangerousInsecureTransportProtocol`. What that gives up is
// small: the server binds to loopback only, and the payload this manifest
// points at is still minisign-verified against the pinned public key before
// anything is installed. A local process squatting on the port could at worst
// suppress or misdirect an update, not install one.
//
// The GitHub stable manifest stays in the endpoint list as a second entry.
// The plugin walks endpoints in order and skips any that error, so a stopped
// LaunchAgent degrades to stable-channel checks instead of failing outright.
// Note that a 204 from this route ends the walk (the plugin reads it as "no
// update") — that is deliberate, and why the not-yet-published cases below
// return 204 while genuine failures return 502.
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

/**
 * Resolves the newest published nightly's `latest.json` URL.
 *
 * Distinguishes "no nightly exists yet" (`"none"`, a legitimate silent state)
 * from "couldn't ask GitHub" (`"error"`, e.g. the API is down or rate-limited).
 * Collapsing the two would report an unreachable GitHub as "you're up to
 * date", which is exactly the kind of silent failure that let the updater stay
 * broken across 23 releases.
 */
async function resolveNightlyManifestUrl(): Promise<
  { kind: "ok"; url: string } | { kind: "none" } | { kind: "error" }
> {
  const res = await fetch(NIGHTLY_RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { kind: "error" };
  const releases = (await res.json()) as GitHubRelease[];
  // The releases API returns results sorted by published_at desc, so the
  // first matching entry is the newest nightly.
  const nightly = releases.find(
    (r) => r.prerelease && !r.draft && r.tag_name.startsWith(NIGHTLY_TAG_PREFIX),
  );
  if (!nightly) return { kind: "none" };
  const asset = nightly.assets.find((a) => a.name === "latest.json");
  // A published nightly release that lacks the manifest means the release
  // pipeline's `manifest` job didn't run — a failure, not an absence.
  return asset ? { kind: "ok", url: asset.browser_download_url } : { kind: "error" };
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

    let target: string;
    if (channel === "nightly") {
      const resolved = await resolveNightlyManifestUrl();
      // No nightly published yet — a real "nothing to offer", so 204 and let
      // the plugin end its endpoint walk quietly.
      if (resolved.kind === "none") return new Response(null, { status: 204 });
      if (resolved.kind === "error") return new Response(null, { status: 502 });
      target = resolved.url;
    } else {
      target = STABLE_MANIFEST_URL;
    }

    // 502 rather than 204 on failure: 204 would end the plugin's endpoint
    // walk and render as "You're up to date", whereas a non-success status
    // makes it fall through to the GitHub endpoint and, if that fails too,
    // surface a real error on manual checks. A missing manifest is a broken
    // release pipeline, not an absence of updates.
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
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
