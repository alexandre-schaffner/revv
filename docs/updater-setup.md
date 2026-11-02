# Updater release setup

Both release channels use `.github/workflows/_build-tauri.yml`. Compilation runs without signing keys or release permissions. A separate publisher in the main-only `release` environment signs the updater archives, checks their signatures, publishes a complete draft, and verifies immutability. See [CI and release operations](ci-cd.md) for recovery and cache checks.

## Configure the updater key

The public key is committed at `apps/desktop/tauri.conf.json` under `plugins.updater.pubkey`. Every installed app verifies updates against it. The private key belongs in the `release` environment as `TAURI_SIGNING_PRIVATE_KEY`. If the key has a password, set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the same environment.

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.tauri/revv-updater.key
```

The current key has no password. Back up its private half outside the repository. Changing the key requires a distribution plan because installed apps trust the old public key. Do not rotate it as routine maintenance.

The publisher uses the official pinned Tauri signer and independently verifies each resulting signature with minisign against the public key in the tested source. Signing a file with a mismatched key fails before publication.

## Published assets

Each architecture produces a DMG and updater archive. Updater archives and signatures use architecture-qualified filenames so matrix legs cannot overwrite each other:

- `Revv_<version>_aarch64.dmg` and `Revv_<version>_x64.dmg`
- `Revv_aarch64.app.tar.gz` and `Revv_x64.app.tar.gz`
- A `.sig` for each updater archive
- One `latest.json` with `darwin-aarch64` and `darwin-x86_64` entries

Stable releases also include the verified installer, `SHA256SUMS`, and their Sigstore attestation bundles. The publisher requires all expected assets, checks their uploaded digests, and publishes only after both architectures and attestations are ready. A failed upload is fatal.

Stable versions come from the committed Tauri version. Nightlies use `<major>.<minor>.<patch+1>-nightly.<ci-run-id>`. The numeric CI run ID orders builds and remains stable on reruns. A new nightly tag is created explicitly at the tested SHA before the draft is built. Published tags and assets are immutable.

## Update endpoints

The app tries these endpoints in order:

1. `http://localhost:45678/api/update-manifest` resolves the user's channel from SQLite and proxies that release's manifest.
2. `https://github.com/alexandre-schaffner/revv/releases/latest/download/latest.json` provides a stable fallback when the local server is unavailable.

The local route returns `204` only when no update exists. Failures return `502` so the plugin can try the next endpoint. A `204` response stops endpoint fallback.

`dangerousInsecureTransportProtocol` remains enabled for the loopback endpoint. Downloaded archives are still verified against the pinned updater key before installation. Do not remove that setting without changing the channel-resolution design.

Verify the published manifest and local endpoint with:

```sh
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/latest.json | jq
curl -si http://localhost:45678/api/update-manifest | head -1
```

The manifest version must match the release, and both architecture URLs must resolve. A missing manifest is a failed release, not evidence that the installed app is current.
