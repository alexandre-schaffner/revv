# Team Walkthrough Cache

## What it is

A team-shared cache for generated AI walkthroughs, backed by a single Google
Cloud Storage bucket. Whenever a teammate has already generated a walkthrough
for the same `(repo, headSha)`, every other teammate skips the agent run and
hydrates from the bucket instead — instant, zero token spend.

Off by default. Enable per-machine in **Settings → Team Cache**. Each teammate
points their Revv at the same bucket and pastes a service-account JSON.

## Architecture in one paragraph

The cache key is content-addressable on `<owner>/<repo>/<headSha>.json.gz`. The
local server gzips a `WalkthroughSnapshotV1` (see
`packages/shared/src/cache.ts`) and uploads it to the bucket on every
successful generation. Before kicking off the agent for any PR, the server
asks the bucket whether that key exists; on a hit it downloads, verifies the
integrity metadata (`schemaVersion`, `contentSha256`), runs the snapshot
through the same validation gate as `complete_walkthrough`, then bulk-imports
into a fresh row in one transaction. The orchestrator then flips status to
`'complete'` and the existing `walkthrough:complete` broadcast does the rest.
On any error, fall back to running the agent normally — no half-imported rows
ever exist.

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

# 3. Create a custom role with the minimal permission set.
gcloud iam roles create walkthroughCacheWriter \
  --project=YOUR_PROJECT \
  --title="Walkthrough Cache Writer" \
  --permissions=storage.objects.get,storage.objects.list,storage.objects.create

# 4. Create a service account per teammate (or one shared SA — team's call;
#    per-teammate keeps audit logs cleaner).
gcloud iam service-accounts create alice-revv-cache \
  --display-name="Alice's Revv cache"
gcloud projects add-iam-policy-binding YOUR_PROJECT \
  --member="serviceAccount:alice-revv-cache@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="projects/YOUR_PROJECT/roles/walkthroughCacheWriter"
gcloud storage buckets add-iam-policy-binding gs://my-team-revv-cache \
  --member="serviceAccount:alice-revv-cache@YOUR_PROJECT.iam.gserviceaccount.com" \
  --role="projects/YOUR_PROJECT/roles/walkthroughCacheWriter"

# 5. Download the JSON key. Paste into Revv → Settings → Team Cache.
gcloud iam service-accounts keys create alice-revv-cache.json \
  --iam-account=alice-revv-cache@YOUR_PROJECT.iam.gserviceaccount.com
```

### Recommended bucket configuration

| Setting | Value | Why |
|---|---|---|
| Public access | **Disallowed** | Snapshots can contain code excerpts and AI commentary. The bucket should never be world-readable. |
| Uniform bucket-level access | **On** | Removes per-object ACL drift. The custom role above is the single source of truth. |
| Object versioning | **Off** | Keys are content-addressed by `headSha` — same SHA, same body. Versions would just bloat the bucket. |
| Region | Pick one close to your team | Reduces probe + fetch latency on cache hits. |

## Threat model

**What this protects.** Confidentiality and integrity of the cached payloads
are gated by GCS IAM. Bucket access = team membership. The `contentSha256`
metadata is cross-checked on every download, so silent corruption of the
gzipped body is caught and downgraded to a cache miss.

**What this does NOT protect.** Anyone with read access to the bucket can
read *every* walkthrough in it, regardless of which GitHub repositories they
have access to. **This is acceptable because the bucket IAM grant list is
the team boundary** — teammates with bucket access are already trusted with
all the repos the team is working on. If you need per-repo ACL enforcement
(e.g. a contractor who can read repo A but not repo B), do not enable the
cache for cross-trust-boundary teammates; let them run the agent locally.

A future hosted variant could reintroduce per-request GitHub-token-based
ACL enforcement via a tiny Cloud Function fronting the bucket. The client
abstraction (`BlobStore`) doesn't change.

### What we never put in the bucket

- The reviewer's GitHub access token.
- The PR diff body (which is fetched live from GitHub on render).
- `submittedAt`-marked issues (per-account GitHub submission state — leaks
  reviewer activity across teammates).
- Local `opencode_session_id`, `resume_attempts`, `last_edited_*` columns.

### Credentials

V1 stores the service-account JSON in the local SQLite settings table as
plaintext. This matches how `BETTER_AUTH_SECRET` is handled today (plain in
the OS app-support directory, gated by OS file permissions). A V2 work item
will move secrets into the OS keychain via `tauri-plugin-stronghold` and
cover the GitHub token + better-auth secret in the same pass.

## Troubleshooting

### "Test connection" returns `403 Forbidden`

Your service account doesn't have read access to the bucket. Re-check the
IAM binding:
```bash
gcloud storage buckets get-iam-policy gs://my-team-revv-cache
```
The custom role must include `storage.objects.get`, `storage.objects.list`,
and `storage.objects.create`.

### "Test connection" returns `404 Not Found`

Either the bucket name is wrong, or the project's billing isn't active.

### Generation always runs locally even when teammates have already cached

Open Settings → Team Cache and verify:
- **Enable remote cache** is on.
- **Hydrate from team cache** is on.
- The bucket name and credentials are right (use "Test connection").

If those all look right, check `[remote-cache]` log lines on the local server
console — failures (corrupt blob, schemaVersion mismatch, sha256 mismatch)
log there and are treated as misses.

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
