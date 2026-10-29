# CI and release operations

CI validates each pull request and main push once. `ci-ok` requires workflow policy checks, typecheck, lint, Knip, builds, tests, dependency security, CodeQL, and any required desktop checks. Main requires this check and a pull request. The desktop filter skips native checks only for pull requests that do not change desktop inputs or workflow policy. Main pushes always check both architectures.

Release and Nightly consume a successful **push** CI run from this repository's main branch. Before downloading its frontend artifact, `scripts/ci/trusted-run.py` validates the repository, workflow ID, event, branch, completion, conclusion, source SHA, and ancestry. A PR run or fork run cannot release. Superseded main runs are skipped before scheduling release builds.

The frontend is built once in CI and handed to both macOS compilation jobs. Each compilation job has read access and no signing secrets. It builds an unsigned app and DMG, checks the app version and architecture, verifies that the DMG contains the same executable and plist, and uploads one artifact. It does not rebuild the server or development collector.

The separate publisher uses the main-only `release` environment. It installs a pinned official Tauri signer without workspace dependencies or install scripts, then signs each updater archive and verifies it against the public key in the tested source. It stages the updater manifest and stable installer, attests the artifacts, uploads once, checks the exact remote asset set and SHA-256 digests, publishes the draft, and asserts release immutability. Failures leave a draft for recovery. Stale assets on a recovered draft are removed before publication.

## Recover a release

For a failed build or publisher, use **Re-run failed jobs** on the Release or Nightly run. Successful build artifacts are retained for 14 days.

For a stable draft created by this pipeline, dispatch Release from main with its tag:

```sh
gh workflow run release.yml --ref main -f tag=v0.32.3
```

Recovery resolves the tag to its tested SHA and requires successful main-push CI for that SHA. If the frontend artifact expired, rerun that original CI run first, then recover the draft. Older drafts created before this pipeline lack its frontend artifact and are not supported by this recovery command. Published immutable releases cannot be recovered in place. Publish a new version instead.

Release-please uses `GITHUB_TOKEN`, so it explicitly dispatches CI on its release PR branch. Stable publication is serialized. Nightly publication is also serialized to prevent cancellation during signing or upload. A queued nightly skips itself when its tested SHA is no longer current main.

## Check caches

Package downloads are partitioned by OS, architecture, Bun version, and lockfile. Every runner still performs a frozen install. `node_modules` is never copied across platforms. Only trusted main jobs save shared caches.

The Rust cache separates release and check profiles and includes the requested target triple. The cache action also hashes the toolchain, Cargo manifests and lockfile, and compiler flags. Each matrix leg installs only its own target.

Turbo uses a persistent `.turbo/cache` per checkout. `scripts/turbo.mjs` resolves the commit and actual Bun runtime before task hashing. Root compiler settings, server API source and dependencies, shared types, frontend environment values, and the embedded commit invalidate their affected tasks. SvelteKit sync is uncached so generated configuration exists even when typechecking is cached. Only final portable frontend output crosses from Linux to macOS.

Run these checks after changing task inputs or outputs:

```sh
python3 scripts/ci/check-cache.py
python3 scripts/ci/check-cache-restore.py
```

The first changes inputs in an isolated copy and checks real Turbo hashes. The second moves generated files and build outputs aside, runs typecheck, Knip, and build, then compares restored bytes. Neither check measures a build speedup.

## Maintain security checks

Dependabot groups updates for Bun, Cargo, and Actions. Security checks fail high or critical Bun advisories and Cargo vulnerability findings. GitHub dependency review supplements the lockfile audits for supported ecosystems. It does not replace Bun's transitive lockfile audit. CodeQL scans TypeScript, Rust, Actions, and Python. The security workflow also runs weekly to detect new advisories without a source change.

The initial remediation updates Better Auth, DOMPurify, Vite, Zod, source-map-js, concurrently and its shell-quote dependency, Rust TLS libraries, and Tauri's vulnerable zip dependency. Low and moderate Bun advisories and upstream Rust maintenance warnings remain visible. No advisory IDs are suppressed. Several Rust warnings concern Linux-only GTK dependencies or upstream unmaintained packages; review them when their parents update.

Apply or inspect repository settings with:

```sh
python3 scripts/ci/configure-github.py
python3 scripts/ci/configure-github.py --apply
```

The script preserves existing branch protection when it already requires `ci-ok` and pull requests. It refuses to replace a different protection policy.

## Complete the signing-key migration after merge

The existing updater key is installed in the main-only `release` environment and verified against the committed public key. The repository-level copy remains until these workflows reach main, so the currently deployed workflow can still release.

After merge, remove that legacy copy:

```sh
python3 scripts/ci/configure-github.py --finalize-secret-migration
```

The command first confirms that main contains this exact publisher workflow and that the environment key exists. It refuses to remove the repository key before that point.

Apple Developer ID signing, notarization, SBOM publication, and a different nightly optimization profile remain separate follow-up work. They require distribution credentials or controlled build and runtime measurements. This change preserves the existing DMG and minisign updater formats.
