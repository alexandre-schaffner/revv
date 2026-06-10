# Revv

AI-powered code review desktop app that syncs GitHub pull requests and enables AI-assisted review workflows. This glossary defines the terms specific to Revv's domain — start here before reading code.

## GitHub authentication

**Classic OAuth App**:
A GitHub integration that authenticates a user and receives a user token carrying coarse, account-wide scopes. The narrowest scope granting private-repo access is `repo` — full read/write to all code the user can reach; it cannot be narrowed.
_Avoid_: "OAuth", "the GitHub login" (ambiguous between this and a GitHub App's user-to-server flow)

**GitHub App**:
A GitHub integration with fine-grained, per-resource permissions (e.g. Pull requests: read & write, Contents: read) that an org or account owner installs onto specific repositories. The unit org admins approve and scope.

**Installation token**:
A short-lived token minted for a GitHub App's installation. Acts as the **app/bot**, not a human — anything it writes (e.g. a review comment) is attributed to the app.

**User-to-server token**:
A token a GitHub App obtains by authenticating a user (device flow works). Acts **as the user**, limited to the intersection of what the user can access and where the app is installed. Preserves human attribution on review comments — the property a code-review tool needs.
