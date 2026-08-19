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
// A 204 from this route ends the walk (the plugin reads it as "no update"),
// so this handler only ever returns 204 for a genuinely resolved "no release
// published for this asset" (the final upstream 404) — every other
// unresolved/failure case returns 502 so the walk continues to the GitHub
// stable endpoint instead of going silent.
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

function isGitHubAsset(value: unknown): value is GitHubAsset {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return typeof a.name === "string" && typeof a.browser_download_url === "string";
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.tag_name === "string" &&
    typeof r.prerelease === "boolean" &&
    typeof r.draft === "boolean" &&
    Array.isArray(r.assets) &&
    r.assets.every(isGitHubAsset)
  );
}

type NightlyResolution = { kind: "ok"; url: string } | { kind: "none" } | { kind: "error" };

// The releases API is unauthenticated here (60 req/hr per source IP) and gets
// hit on every updater check. A short in-memory cache keeps a handful of
// manual "check for updates" clicks from burning through that budget. Errors
// are never cached — a transient rate-limit/outage shouldn't stick around
// for the full TTL once GitHub recovers.
const NIGHTLY_CACHE_TTL_MS = 5 * 60 * 1000;
let nightlyCache: { resolution: NightlyResolution; expiresAt: number } | null = null;

async function resolveNightlyManifestUrlUncached(): Promise<NightlyResolution> {
  const res = await fetch(NIGHTLY_RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return { kind: "error" };
  const body: unknown = await res.json();
  if (!Array.isArray(body)) return { kind: "error" };
  const releases = body.filter(isGitHubRelease);
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

/**
 * Resolves the newest published nightly's `latest.json` URL, cached for
 * {@link NIGHTLY_CACHE_TTL_MS}.
 *
 * Still distinguishes "no nightly exists yet" (`"none"`, a legitimate state)
 * from "couldn't ask GitHub" (`"error"`, e.g. the API is down or
 * rate-limited) even though both now produce the same 502 response to the
 * plugin: only `"none"` is cache-worthy — caching a transient error would
 * make a rate-limit blip look like "no nightly" for the full TTL.
 */
async function resolveNightlyManifestUrl(): Promise<NightlyResolution> {
  if (nightlyCache && nightlyCache.expiresAt > Date.now()) return nightlyCache.resolution;
  const resolution = await resolveNightlyManifestUrlUncached();
  if (resolution.kind !== "error") {
    nightlyCache = { resolution, expiresAt: Date.now() + NIGHTLY_CACHE_TTL_MS };
  }
  return resolution;
}

export const updateManifestRoute = new Elysia()
  .get("/api/update-manifest", async () => {
    const channelResult = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        const s = yield* settings.getSettings();
        return { kind: "ok", channel: s.updateChannel } as const;
      }).pipe(Effect.orElseSucceed(() => ({ kind: "error" }) as const)),
    );
    // Don't default a Settings/DB read failure to "stable" — that would
    // silently downgrade a nightly user. 502 falls through to the GitHub
    // stable endpoint instead, same as any other resolution failure below.
    if (channelResult.kind === "error") return new Response(null, { status: 502 });
    const channel = channelResult.channel;

    let target: string;
    if (channel === "nightly") {
      const resolved = await resolveNightlyManifestUrl();
      // Both "no nightly published yet" and "couldn't resolve one" return 502
      // (not 204): a 204 ends the plugin's endpoint walk right here, so a
      // nightly user would never fall through to check the stable endpoint,
      // and — since this route is unauthenticated on loopback — any process
      // that beat the real server to the port could otherwise suppress every
      // update by always answering 204.
      if (resolved.kind === "none" || resolved.kind === "error") {
        return new Response(null, { status: 502 });
      }
      target = resolved.url;
    } else {
      target = STABLE_MANIFEST_URL;
    }

    const upstream = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    // A 404 here means no release has been published yet (fresh clone / no
    // tags cut) — a legitimate absence, so end the walk quietly with 204
    // rather than surfacing a hard error toast on a manual check. Any other
    // non-2xx is a genuine failure (broken pipeline, GitHub outage): 502, so
    // the plugin falls through / a manual check can report it.
    if (!upstream.ok) {
      return new Response(null, { status: upstream.status === 404 ? 204 : 502 });
    }

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
