# Revv

**AI-powered code review on your desktop.**

Revv pulls in your GitHub pull requests and turns reviewing them into a fast, conversational experience. Get an AI-generated walkthrough of every change, chat with an agent that understands the diff, leave comments that sync back to GitHub, and even propose and push fixes — all without leaving the app.

Available for macOS, Windows, and Linux.

---

## Why Revv

Reviewing a large PR usually means scrolling a wall of diffs in a browser tab, losing track of what matters, and context-switching between code, comments, and conversations. Revv does the heavy lifting for you:

- It **explains the change** before you read a single line of diff.
- It **answers your questions** about the code in context.
- It **drafts fixes** you can cherry-pick and push back.
- It **keeps everything in sync** with GitHub, so nothing lives in a silo.

## Features

- **Synced GitHub PRs** — Your pull requests are fetched and kept up to date automatically across all your repos, in real time.
- **AI Guided Walkthrough** — Every PR gets a structured, AI-generated walkthrough: a plain-language overview, a risk assessment, a step-by-step tour of the diff, an overall verdict, and a 9-axis quality rating.
- **Chat Agent** — An always-on assistant that understands the PR. Ask it anything about the change, have it plan a fix, and watch its work stream live.
- **Propose & Push Changes** — Turn the agent's suggestions into real commits. Cherry-pick what you want, discard the rest, resolve merge conflicts with AI help, and push straight back to the branch.
- **Comment Threads** — Persistent review threads that sync bidirectionally with GitHub, plus inline code suggestions you can apply in one click.
- **Command Palette** — `Cmd+P` to jump to any PR, `Cmd+Shift+P` for commands. Fuzzy search throughout.
- **Multi-Account** — Sign in with multiple GitHub accounts; works with both `github.com` and GitHub Enterprise.
- **Themes** — Light, dark, or system, with a separate theme just for diffs.

## Install

### macOS

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh | bash
```

Requires macOS 10.15 (Catalina) or later. The installer drops in `Revv.app`, sets up the local background server, and adds a `revv` CLI for managing the install.

> macOS Gatekeeper may show an "unidentified developer" warning until code-signing is finalized. To open the first time: right-click `Revv.app` → **Open**, then **Open** again in the dialog.

<details>
<summary>Verify the installer before running it</summary>

```bash
curl -fsSL https://github.com/alexandre-schaffner/revv/releases/latest/download/install.sh -o install.sh
gh attestation verify install.sh --repo alexandre-schaffner/revv
bash install.sh
```

</details>

### Windows

```powershell
irm https://github.com/alexandre-schaffner/revv/releases/latest/download/install.ps1 | iex
```

Or download the MSI from [Releases](https://github.com/alexandre-schaffner/revv/releases) and run it directly.

> Windows SmartScreen may warn about the installer until code-signing is finalized.

### Linux

Download the **AppImage** or **`.deb`** from [Releases](https://github.com/alexandre-schaffner/revv/releases).

```bash
# AppImage (any distro)
chmod +x Revv_*.AppImage && ./Revv_*.AppImage

# Debian / Ubuntu
sudo dpkg -i revv_*.deb
sudo apt-get install -f   # if dpkg reports missing deps
```

The `.deb` needs `libwebkit2gtk-4.1-0` and `libgtk-3-0` (available by default on Ubuntu 22.04+). See [Build from source](#build-from-source) for the developer setup.

## Quickstart

1. **Launch Revv** and click **Sign in with GitHub**. Revv uses GitHub's device-code flow — you'll get a short code to enter at `github.com/login/device`. Approve it and you're in.
2. **Pick your repositories.** Revv lists the repos you have access to; choose the ones you want to review and it starts syncing their open PRs.
3. **Open a pull request.** Hit `Cmd+P`, search for the PR, and open it.
4. **Read the walkthrough.** Revv generates an AI walkthrough for the PR — start with the overview and risk level, then step through the diff.
5. **Chat about the change.** Use the right-hand panel to ask the agent questions, request a fix, or have it explain anything you don't understand.
6. **Comment and push back.** Leave review comments (they sync to GitHub), apply code suggestions, or accept an agent-proposed commit and push it to the branch.

That's it — your review happens entirely inside Revv, and everything you do flows back to GitHub.

## Managing your install

The `revv` CLI (installed on macOS and Windows) handles the lifecycle:

```bash
revv status      # install paths, versions, server state, available updates
revv update      # update to the latest release
revv restart     # restart the background server
revv logs        # tail server logs
revv open        # launch the app
revv uninstall   # remove everything
```

## Troubleshooting

**"Failed to start sign-in: Load failed"** — The app can't reach its local server. Check it's running:

```bash
curl http://localhost:45678/    # any response (even 404) means it's up
revv restart                    # restart it if not
```

**"Failed to initiate sign-in"** — The server reached GitHub but got an error. The usual cause is that **Device Flow isn't enabled** on your GitHub OAuth app — enable it under `github.com/settings/developers` → your app → check **Enable Device Flow** → Update application.

## Build from source

Revv is a Bun + TypeScript monorepo with a SvelteKit frontend, an Elysia API server, and a Tauri v2 desktop shell.

**Prerequisites:** [Bun](https://bun.sh) 1.3+ and [Rust](https://rustup.rs). On macOS also `xcode-select --install`; on Linux the Tauri system libraries; on Windows the MSVC C++ Build Tools and WebView2.

```bash
git clone https://github.com/alexandre-schaffner/revv.git
cd revv
bun install
cp .env.example .env   # fill in GITHUB_CLIENT_ID and BETTER_AUTH_SECRET
make dev               # runs web, server, and desktop together
```

See [`CLAUDE.md`](CLAUDE.md) for the full architecture, conventions, and contributor workflow.

## Contributing

1. Branch off `main`
2. Make your change and test with `make dev`
3. Run `make typecheck` and `make lint`
4. Open a PR against `main`

## License

MIT
