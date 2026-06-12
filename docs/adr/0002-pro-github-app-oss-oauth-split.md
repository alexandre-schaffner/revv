---
status: accepted
---

# Pro uses a GitHub App; OSS keeps the classic OAuth App

## Context

Revv authenticates to GitHub today via a **classic OAuth App** using the
device-code flow, requesting the scope `repo read:org user:email`
(`apps/server/src/routes/device-auth.ts`). On a classic OAuth App, `repo` is
all-or-nothing: full read **and write** to all code, settings, webhooks, and
deploy keys across every repository the user can reach. It cannot be narrowed —
there is no read-only or pull-requests-only private-repo scope in the classic
model. Yet Revv only ever **reads** PRs/diffs/files and **writes** PR review
comments (`apps/server/src/routes/reviews/handlers/github-submit.ts`).

As Revv goes to market for professional/enterprise clients, that `repo` grant
is a sales blocker: orgs that enforce OAuth App access restrictions route it to
an admin whose approval dialog reads "can read and write all your private
code," and security teams routinely reject a third-party desktop app holding a
long-lived all-access token on an employee laptop.

## Decision

Split by **distribution**, not by pricing tier:

- **OSS / self-hosted** keeps the **classic OAuth App**, bring-your-own
  credentials, running locally. The broad `repo` scope is acceptable here
  because the user *is* the app owner on their own machine — there is no
  third-party trust boundary and no org-admin approval gate.
- **Pro** (the commercially distributed product, targeting **GitHub Enterprise
  Cloud / `*.ghe.com`** first) uses a single, centrally-registered **GitHub
  App** with **user-to-server tokens** obtained via the **device flow**.

Pro permission set, driven by the full feature inventory (PR review/submit,
chat-agent commit push, PR create/close/merge/draft):

- **Pull requests: Read & write** — sync, review submission, comments,
  threads, create/close/draft.
- **Contents: Read & write** — *read* for file content + `git clone`/`fetch`;
  **write** because Revv **pushes commits** (chat agent, new-PR) and **merges
  PRs** (GitHub requires Contents:write for merge, not PR:write).
- **Metadata: Read** — mandatory baseline (repo metadata, `/user/repos`,
  collaborator-permission check).

No org-level permission (skip the `/user/orgs` picker — fine-grained tokens
don't enumerate all orgs reliably anyway) and no dedicated Email permission
(fall back to the public-profile email). Add **Issues: Read** only if the
project-recap `search/issues` path needs it (verify; don't add speculatively).

**Caveat — this is not a "never writes code" posture.** `Contents: write`
lets the app push commits and merge, because those are shipped features. It
remains far narrower than classic `repo` (no Administration, webhooks, deploy
keys, Actions, packages; admin-chosen repos only; every write attributable to
the human via user-to-server). If a tighter "read + comment only" story is
needed for an early enterprise sale, the lever is a **product decision**: ship
Pro without agent-push and merge, which drops Contents to Read-only. The
feature set and the permission set are the same decision.

## Why these choices

- **GitHub App, not narrower OAuth:** the scope cannot be narrowed on a classic
  OAuth App; the app *type* is the only lever. A GitHub App gives fine-grained,
  per-repo, admin-controlled, expiring permissions — exactly what enterprise
  security teams approve.
- **User-to-server tokens, not installation tokens:** human attribution on
  review comments is a hard product requirement. User-to-server tokens act *as
  the reviewer* (limited to the intersection of the user's access and the
  app's installation); installation tokens would attribute every comment to a
  bot.
- **Device flow:** requires only a public `client_id` — no `client_secret` and
  no app private key. This preserves Revv's "local server, no vendor backend"
  architecture; the existing acquisition code in `device-auth.ts` barely
  changes, and the consumption layer (`GitHubGateway` and every REST call) is
  untouched — a bearer token is a bearer token.
- **The added org-admin install step is the selling point**, not friction: an
  admin picks exactly which repos Revv can see, which is the sentence that
  clears a security review.

## Consequences

- Two **acquisition/refresh** paths are maintained permanently. The consumption
  layer is shared. Accepting this two-path tax is deliberate.
- The **refresh path becomes revenue-critical**: classic `repo` tokens never
  expire, but GitHub App user-to-server tokens do (~8h). Refresh + silent
  re-auth must be hardened and tested for Pro.
- **Repo discovery changes shape** for Pro: reviewers only see repos where the
  app is installed *and* they have access. This needs explicit "ask your admin
  to install Revv here" UX, and the onboarding org-picker degrades (fine-grained
  tokens don't enumerate all of a user's orgs).

## Deferred

- **CI/CD monitoring** (future): adds **read-only** permissions (Checks: Read,
  Commit statuses: Read, and Actions: Read only if monitoring Actions runs).
  Not requested now — pre-requesting unused permissions hardens the *first*
  approval for no benefit. Adding them later triggers a per-installation
  admin re-approval (email-driven), with the app continuing on old permissions
  until accepted, so the feature must degrade gracefully while approval is
  pending.
