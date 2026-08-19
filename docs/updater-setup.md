# Updater setup (operator notes)

Internal runbook for signing and publishing Revv releases. Not a user-facing
doc — keep it terse.

Releases are automated. `release.yml` (stable) and `nightly.yml` both call
`_build-tauri.yml`, which builds both macOS architectures, signs the updater
artifacts, and publishes the `latest.json` manifest the in-app updater reads.
The only manual part is the one-time signing-key setup below.

## One-time: the signing keypair

Tauri's updater uses minisign signatures. The keypair was generated with:

```bash
bun x @tauri-apps/cli signer generate -w ~/.tauri/revv-updater.key
```

- The **public** key is committed in `apps/desktop/tauri.conf.json` →
  `plugins.updater.pubkey`. Every installed copy of Revv verifies downloaded
  updates against it.
- The **private** key lives at `~/.tauri/revv-updater.key` on the maintainer's
  machine and in the `TAURI_SIGNING_PRIVATE_KEY` repo secret. Back it up.
  **Never commit it.** Anyone holding it can push a malicious update to every
  installed copy of Revv.
- The current key has **no password**, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
  is unset in CI. If you regenerate with one, add it as a second repo secret
  under that name — the workflow already passes it through.

Rotating the key is a breaking change: builds signed by the new key will not
verify on copies of Revv shipped with the old `pubkey`, so those users have to
reinstall by hand. Only rotate on suspected compromise.

### Repo secrets

| Secret                               | Required | Value                               |
| ------------------------------------ | -------- | ----------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | yes      | contents of `~/.tauri/revv-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | no       | only if the key has a password      |

Set with:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo alexandre-schaffner/revv < ~/.tauri/revv-updater.key
```

`_build-tauri.yml` fails fast with an explicit error if the key secret is
missing, rather than letting the bundler fail deep in the build.

## What CI publishes

`bundle.createUpdaterArtifacts` is `true` in `tauri.conf.json`, so each build
emits, per architecture:

- `Revv.Alpha._<version>_<arch>.dmg` — the user-facing download
- `Revv.Alpha._<arch>.app.tar.gz` — what the updater actually downloads
- `Revv.Alpha._<arch>.app.tar.gz.sig` — its minisign signature

The `manifest` job then composes `latest.json` from both architectures'
signatures and uploads it to the release:

```json
{
  "version": "0.24.0",
  "notes": "Short one-liner shown in the update toast.",
  "pub_date": "2026-08-17T09:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "…", "url": "https://github.com/…/Revv.Alpha._aarch64.app.tar.gz" },
    "darwin-x86_64":  { "signature": "…", "url": "https://github.com/…/Revv.Alpha._x64.app.tar.gz" }
  }
}
```

It is composed in a dedicated job rather than by `tauri-action`
(`includeUpdaterJson: false`) because the two matrix legs run concurrently and
each only knows its own platform — letting both read-modify-write the same
asset is a race that can drop an architecture.

On disk both legs produce an identically-named `<product>.app.tar.gz`, so the
build job stages arch-suffixed copies before uploading. The suffix matches
what `tauri-action` uses, so the fallback upload replaces its copy instead of
adding a second one.

`notes` comes from the `updater_notes` workflow input, not the GitHub release
body: it renders as a Sonner toast description, so it needs to be one line,
not a changelog.

## Versioning

- **Stable** builds use `tauri.conf.json` → `version` verbatim (release-please
  keeps it in sync with `Cargo.toml` and the `package.json`s via the
  `x-release-please-version` markers).
- **Nightly** builds are stamped `<major>.<minor>.<patch+1>-nightly.<run>` at
  build time. Every nightly is cut from the same released version, so without
  the bump they would all report an identical version and the updater would
  never see one as newer. Patch+1 keeps a nightly above the stable release it
  came from and below the next stable one; the run number is numeric, so
  semver orders successive nightlies correctly (a short SHA would not — it
  sorts as an ASCII string).

## Endpoints and channel switching

`tauri-plugin-updater` reads `plugins.updater.endpoints` from
`tauri.conf.json` at compile time and offers no runtime override, so the
endpoint list cannot depend on the selected release channel. The indirection
that makes `Settings → Updates → Release channel` work is the local API
server. Two endpoints, in order:

1. `http://localhost:45678/api/update-manifest` — resolves the channel from
   SQLite per request and proxies the right manifest
   (`apps/server/src/routes/update-manifest.ts`). Channel switches take effect
   on the next check: no rebuild, no restart.
2. `https://github.com/alexandre-schaffner/revv/releases/latest/download/latest.json`
   — stable manifest, reached only if the first endpoint errors (e.g. the
   `com.revv.server` LaunchAgent is stopped). Degrades to stable-channel
   checks rather than failing outright.

The port in endpoint 1 is hard-coded: `tauri.conf.json` is plain JSON read by
the Rust host, so it cannot import `API_PORT` from `@revv/shared`. Changing
the port means changing both.

### Status codes matter

The plugin walks the endpoint list in order, and **a 204 ends the walk** — it
reads as "no update available". So the route returns:

- **204** only for genuine absence (nightly channel, no nightly published yet)
- **502** for any failure (missing manifest, GitHub unreachable, rate-limited)

Returning 204 on failure would render as "You're up to date" and hide a broken
release pipeline — which is how the updater stayed broken across 23 releases.

### `dangerousInsecureTransportProtocol`

Release builds normally refuse non-HTTPS updater endpoints; endpoint 1 needs
the app to opt out via `plugins.updater.dangerousInsecureTransportProtocol`.
Without the flag the plugin rejects the whole config at startup, so this is
not something to remove casually.

What it gives up is small. The server binds to loopback only, and the payload
the manifest points at is still minisign-verified against the pinned public
key before installation. A local process squatting on port 45678 could at
worst suppress or misdirect an update — it cannot get one installed.

## Verifying a release by hand

```bash
# The published manifest
curl -sL https://github.com/alexandre-schaffner/revv/releases/latest/download/latest.json | jq

# What the app actually fetches (respects the selected channel)
curl -si http://localhost:45678/api/update-manifest | head -1
```

The first should return a manifest whose `version` matches the latest tag and
whose two `platforms` URLs both resolve. If it 404s, the `manifest` job did
not run or failed — the in-app check then reports "Could not fetch a valid
release JSON from the remote".

The second should be `200` with that manifest, or `204` on the nightly channel
before any nightly exists. A `502` means the channel's manifest could not be
fetched.
