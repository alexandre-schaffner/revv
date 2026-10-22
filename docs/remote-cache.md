# Team Walkthrough Cache

## What it is

A team-shared cache for generated AI walkthroughs, backed by a single Google
Cloud Storage bucket. Whenever a teammate has already generated a walkthrough
for the same `(repo, headSha)`, every other teammate skips the agent run and
hydrates from the bucket instead — instant, zero token spend.

Off by default. Enable per-machine in **Settings → Team Cache**. Each teammate
points their Revv at the same bucket and authenticates with Google Cloud's
Application Default Credentials (see [Per-machine setup](#per-machine-setup)) —
no service-account JSON to copy around.

## Architecture in one paragraph

The cache key is content-addressable on `<owner>/<repo>/<headSha>.json.gz`. The
local server gzips a `WalkthroughSnapshotV2` (see
`packages/shared/src/cache.ts`) and uploads it to the bucket on every
successful generation — but only after an eligibility check (the local user
must currently hold `write` on the repo) and, unless signing is `off`, after
SSHSIG-signing the payload with the user's GitHub SSH key. Before kicking off
the agent for any PR, the server asks the bucket whether that key exists; on a
hit it downloads, verifies the integrity metadata (`schemaVersion`,
`contentSha256`), then verifies the **signature** (signer host is trusted, the
SSHSIG matches the signer's published GitHub keys, and the signer still holds
`write` on the repo), runs the snapshot through the same validation gate as
`complete_walkthrough`, and finally bulk-imports into a fresh row in one
transaction. The orchestrator then flips status to `'complete'` and the
existing `walkthrough:complete` broadcast does the rest. On any error — or any
failed signature check in `strict` mode — fall back to running the agent
normally (treated as a cache miss); no half-imported rows ever exist.

## Bucket setup

```bash
# 1. Create the bucket. Pick a unique name; uniform IAM is recommended.
gcloud storage buckets create gs://my-team-revv-cache \
  --location=US \
  --uniform-bucket-level-access \
  --no-public-access-prevention=false

# 2. (Optional but recommended) lifecycle rule to GC entries you stopped
#    caring about — old branches, abandoned PRs, etc. Snapshots are
#    content-addressed so re-running generation always produces a
#    byte-identical body for the same headSha; deleting an old one is
#    never destructive.
gcloud storage buckets update gs://my-team-revv-cache \
  --lifecycle-file=<(cat <<'EOF'
{ "rule": [ { "action": { "type": "Delete" },
             "condition": { "age": 90 } } ] }
EOF
)

# 3. Grant your Google account (or your team's Google Group) access to the bucket.
#    Revv uses Application Default Credentials, so it will authenticate as YOU.
gcloud storage buckets add-iam-policy-binding gs://my-team-revv-cache \
  --member="user:alice@example.com" \
  --role="roles/storage.objectAdmin"
```

### Per-machine setup

Each teammate only needs to sign in once on their machine:

```bash
gcloud auth application-default login
```

Then open Revv → Settings → Team Cache, enter the bucket name, and click **Test connection**. Revv probes for the saved credentials automatically — no JSON keys, no copy-paste.

### Recommended bucket configuration

| Setting | Value | Why |
|---|---|---|
| Public access | **Disallowed** | Snapshots can contain code excerpts and AI commentary. The bucket should never be world-readable. |
| Uniform bucket-level access | **On** | Removes per-object ACL drift. The custom role above is the single source of truth. |
| Object versioning | **Off** | Keys are content-addressed by `headSha` — same SHA, same body. Versions would just bloat the bucket. |
| Region | Pick one close to your team | Reduces probe + fetch latency on cache hits. |

## Threat model

The cache rests on **two independent layers**: GCS IAM (who can read/write the
bucket at all) and SSHSIG artifact signing (who is allowed to *author* an
entry your machine will trust). IAM is the confidentiality boundary; signing is
the authenticity/integrity boundary.

### Layer 1 — confidentiality (GCS IAM)

Read/write access to the cached payloads is gated by GCS IAM. Bucket access =
team membership. Anyone with read access to the bucket can read *every*
walkthrough in it, regardless of which GitHub repositories they have access to.
**This is acceptable because the bucket IAM grant list is the team boundary** —
teammates with bucket access are already trusted with all the repos the team is
working on. If you need per-repo *read* ACL enforcement (e.g. a contractor who
can read repo A but not repo B), do not enable the cache for cross-trust-
boundary teammates; let them run the agent locally.

A future hosted variant could reintroduce per-request GitHub-token-based read
ACL enforcement via a tiny Cloud Function fronting the bucket. The client
abstraction (`BlobStore`) doesn't change.

### Layer 2 — authenticity & integrity (SSHSIG signing)

IAM alone says nothing about *whether the content you downloaded is genuine*.
A teammate with bucket write access (or a leaked/over-broad service account)
could otherwise overwrite any key with a poisoned walkthrough, and every other
machine would import it. Signing closes that gap: a cache entry is only trusted
if it was authored by a GitHub identity that **currently holds `write` on the
target repo**, proven cryptographically.

**On push** (`RemoteWalkthroughCache.push`):

1. **Eligibility gate** — `CacheEligibility.canPush` checks, via the GitHub
   collaborator-permission API, that the local user has at least `write` on the
   repo. Read-only contributors still get cache *hits*; they simply never push.
2. **Sign** (when `mode != 'off'`) — the server signs the canonical message
   `revv-cache:v1\n<repoFullName>\n<headSha>\n<contentSha256>` (see
   `cacheSigningMessage` in `packages/shared/src/cache.ts`) with SSHSIG via
   `ssh-keygen -Y sign`, namespace `revv-cache@<host>`. The signing key is the
   user's local SSH private key — auto-detected by matching `~/.ssh/id_*`
   against the keys the user has published at `https://<host>/<login>.keys`, or
   set explicitly via `cache.signing.keyPath`. The signature binds the entry to
   `(repo, headSha, content hash)`; the body bytes are already covered by
   `contentSha256`, so the signed message stays tiny.
3. The signature plus signer identity (`signerHost`, `signerLogin`,
   `signerGithubUserId`, `signatureNamespace`) ride along as GCS custom
   metadata (`CACHE_METADATA_KEYS`).

**On fetch** (`RemoteWalkthroughCache.fetch`), when `mode != 'off'`, every
entry must clear, in order:

1. `schemaVersion` matches `CACHE_SCHEMA_VERSION`.
2. `contentSha256` matches a fresh hash of the gzipped body (catches silent
   corruption).
3. Signature, `signerHost`, and `signerLogin` are all present (else the blob is
   "unsigned" — see modes below).
4. `signerHost` is in the local `cache.signing.trustedSignerHosts` allow-list.
   **An untrusted host is always a miss, in every mode** (this check sits ahead
   of the network round-trip).
5. The SSHSIG verifies against the signer's currently-published keys at
   `https://<signerHost>/<signerLogin>.keys` (via `ssh-keygen -Y verify`).
6. `CacheEligibility.isSignerEligible` confirms the signer *still* holds
   `write` on the repo. Revoking a teammate's repo access revokes their cache
   authority on the next verification (subject to a short permission-cache TTL).

Steps 3, 5, and 6 are the ones whose *severity* depends on the mode.

### Signing modes (`cache.signing.mode`, default `strict`)

| Mode | On push | On fetch |
|---|---|---|
| `strict` *(default)* | Sign every upload. | Reject (treat as miss) any blob that is unsigned, fails verification, comes from an untrusted host, or whose signer lacks `write`. |
| `permissive` | Sign every upload. | Verify, but **downgrade failures to warnings and import anyway** — *except* an untrusted `signerHost`, which is still a hard miss. Useful for rollout while teammates publish keys / populate trusted hosts. |
| `off` | Do not sign. | Do not verify — trust IAM alone. |

> **Gotcha — trusted hosts start empty.** `cache.signing.trustedSignerHosts`
> defaults to `[]`. Because an untrusted host is a miss in *every* mode, a fresh
> install left in `strict` with no hosts added will treat **every** signed entry
> as a miss. Add your GitHub host (e.g. `github.com` or your Enterprise host) to
> the trusted list in **Settings → Team Cache** before expecting hits.

**What signing does NOT protect.** It is an *authenticity* control, not a read
ACL — it doesn't stop a bucket reader from seeing content (that's Layer 1).
It also trusts GitHub's published-keys endpoint and the collaborator-permission
API as the source of truth for identity and authority; if those are
compromised, so is signing. And `off`/`permissive` modes are exactly as strong
as you'd expect — only `strict` gives the full guarantee.

### What we never put in the bucket

- The reviewer's GitHub access token.
- The PR diff body (which is fetched live from GitHub on render).
- `submittedAt`-marked issues (per-account GitHub submission state — leaks
  reviewer activity across teammates).
- Local `opencode_session_id`, `resume_attempts`, `last_edited_*` columns.

### Credentials

Revv uses Google Cloud's Application Default Credentials (ADC). The user's
OAuth token is stored by the Google Cloud SDK in the standard OS location
(`~/.config/gcloud/`). Revv
never sees or stores the credential itself — the `@google-cloud/storage`
SDK reads it directly from that location. This removes the need for manual
service-account keys entirely.

**SSH signing key.** Artifact signing uses your existing local SSH private key
— the same one you push to GitHub with. Revv never reads, copies, or transmits
the private key: signing happens by shelling out to `ssh-keygen -Y sign`, which
reads the key from disk itself. The matching *public* key must be published on
your GitHub host (`https://<host>/<login>.keys`) so teammates can verify your
signatures. Revv auto-detects which `~/.ssh/id_*` to use by matching against
your published keys; override with `cache.signing.keyPath` if needed.

## Troubleshooting

### "Test connection" returns `403 Forbidden`

Your Google account doesn't have access to the bucket. Re-check the
IAM binding:
```bash
gcloud storage buckets get-iam-policy gs://my-team-revv-cache
```
Your account needs `storage.objects.get`, `storage.objects.list`,
and `storage.objects.create`.

### "Test connection" returns `404 Not Found`

Either the bucket name is wrong, or the project's billing isn't active.

### "Application Default Credentials not found" in Settings

Run `gcloud auth application-default login` in your terminal, then click
**Test connection** again. If `gcloud` is not installed, download the
[Google Cloud SDK](https://cloud.google.com/sdk/docs/install) first.

### Generation always runs locally even when teammates have already cached

Open Settings → Team Cache and verify:
- **Enable remote cache** is on.
- **Hydrate from team cache** is on.
- The bucket name is right (use "Test connection").
- Application Default Credentials are detected (green dot in Settings).

If those all look right, check `[remote-cache]` log lines on the local server
console — failures (corrupt blob, schemaVersion mismatch, sha256 mismatch,
signature/eligibility rejections) log there and are treated as misses.

### Cache hits never happen even though teammates are signing correctly

In `strict` mode (the default), an entry from a host that isn't in your
**trusted signer hosts** list is always a miss — and that list starts empty.
Open **Settings → Team Cache** and add your GitHub host (`github.com`, or your
Enterprise host) to it. Look for `signerHost=… not in trusted hosts` in the
`[remote-cache]` logs as the smoking gun.

### "signing failed" / pushes never reach the bucket

Signing requires three things on the pushing machine:
- `ssh-keygen` on `PATH` (ships with OpenSSH; install it if missing).
- An SSH private key in `~/.ssh` whose public half is published at
  `https://<host>/<login>.keys`. If none matches, auto-detection fails — add the
  key to GitHub or set `cache.signing.keyPath` explicitly.
- A signed-in GitHub account with a resolvable login.

You can sidestep signing entirely by setting **signing mode** to `off`, but then
you fall back to IAM-only trust (Layer 1) — anyone with bucket write access can
poison entries. Prefer fixing the key over disabling signing.

### A teammate's entries are rejected after they lost repo access

Working as intended. Eligibility is re-checked on every fetch against the
*current* GitHub permission, so once someone drops below `write` on the repo,
their previously-cached entries stop being trusted (after a short permission-
cache TTL). Regenerate locally, or have a current writer repopulate the entry.

### A walkthrough renders with the wrong "Generated by …" badge

The badge reflects who originally ran the generation that landed in the
cache. If a teammate generates a fresh walkthrough at a *new* headSha, their
identity gets stamped; the old SHA still shows the original author.

To repopulate the cache under a different identity, click **Regenerate** —
that creates a new walkthrough row keyed on the same headSha, your local
identity gets stamped, and the post-complete upload replaces the bucket
object.

### Cache key collisions

GCS uses last-writer-wins. Snapshots are content-addressed by `headSha` and
deterministic, so collisions converge to byte-identical bodies — there's no
data corruption to worry about. You may briefly see two uploads race; both
produce equivalent state.

### How to inspect the bucket

```bash
gcloud storage ls gs://my-team-revv-cache/owner/repo/
gcloud storage cat gs://my-team-revv-cache/owner/repo/abc1234.json.gz \
  | gunzip | jq '.schemaVersion, .modelUsed, .generatedBy.githubLogin'
```

## Schema evolution

The snapshot envelope is versioned via `CACHE_SCHEMA_VERSION` in
`packages/shared/src/cache.ts`. To make a breaking change:

1. Add a new `WalkthroughSnapshotV<N>` type alongside the existing one.
2. Bump `CACHE_SCHEMA_VERSION` to `<N>`.
3. The importer rejects mismatched versions — old snapshots in the bucket
   become misses for newer clients. That's intentional: snapshots are cheap
   to regenerate, so we never need a migration path. Old clients reading
   newer snapshots also miss (advertised version > expected).

Non-breaking field additions (e.g. add a new optional field) don't require
a version bump as long as old importers can ignore the new field.
