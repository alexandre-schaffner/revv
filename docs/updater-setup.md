# Updater setup (operator notes)

Internal runbook for signing and publishing Revv releases. Not a user-facing
doc — keep it terse.

## One-time: generate the signing keypair

Tauri's updater uses minisign signatures. Generate the keypair once and keep
the private key off of the repo:

```bash
bun x @tauri-apps/cli signer generate -w ~/.tauri/revv-updater.key
```

- The public key is printed to stdout. Paste it into
  `apps/desktop/tauri.conf.json` → `plugins.updater.pubkey` (replaces the
  `REPLACE_WITH_MINISIGN_PUBLIC_KEY` placeholder). Commit that change.
- The private key is written to `~/.tauri/revv-updater.key`. Add it to your
  machine's backups. **Do not commit it.** Anyone with this key can push a
  malicious update to every installed copy of Revv.
- The CLI will also ask for a password — set one and store it in your
  password manager.

## One-time: point the endpoint at the real repo

`tauri.conf.json` → `plugins.updater.endpoints[0]` currently points at
`https://github.com/alexmerkl/revv/releases/latest/download/latest.json`.
If the GitHub org/repo changes, update that URL before the first release.

## Per release

1. Bump the version **in every file that tracks it** — they must match for
   Tauri's "is this newer?" comparison to work:
   - `apps/desktop/tauri.conf.json` → `version`
   - `apps/desktop/Cargo.toml` → `[package] version`
   - `apps/web/package.json` → `version`
   - `apps/server/package.json` → `version`
   - root `package.json` → `version`
2. Build the signed installer:
   ```bash
   TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/revv-updater.key)" \
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<your-password>' \
   make dist
   ```
   This emits the `.app`, `.dmg`, and a matching `.sig` into
   `apps/desktop/target/release/bundle/`.
3. Hand-craft `latest.json`. Shape:
   ```json
   {
     "version": "0.0.2",
     "notes": "Short release notes shown in the toast description.",
     "pub_date": "2026-04-20T00:00:00Z",
     "platforms": {
       "darwin-aarch64": {
         "signature": "<contents of the .sig file>",
         "url": "https://github.com/alexmerkl/revv/releases/download/v0.0.2/Revv_0.0.2_aarch64.app.tar.gz"
       },
       "darwin-x86_64": {
         "signature": "…",
         "url": "…"
       }
     }
   }
   ```
   Tauri's docs have the full schema including Windows + Linux targets.
4. Create a GitHub Release tagged `v<version>` and upload:
   - the `.dmg` (user-facing download)
   - the `.tar.gz` referenced in `latest.json` (what the updater downloads)
   - `latest.json` itself

The endpoint URL in `tauri.conf.json` uses GitHub's
`releases/latest/download/<asset>` redirect, so as long as the newest release
is tagged "latest" the updater will find the JSON automatically.

## Out of scope (PRD 06)

Automating steps 2–4 in a GitHub Actions `release.yml` workflow is tracked
in `docs/prds/06-polish-ship.md:277-295`. Until that lands, releases are
manual.
