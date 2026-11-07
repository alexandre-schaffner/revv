<script lang="ts">
import type { AcpAgentId, LoginEvent } from "@revv/shared";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { onDestroy, onMount } from "svelte";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { sseErrorMessage, streamSse } from "$lib/api/sse-stream";
import { prefersReducedMotion } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import { cssTokens, openXterm, xtermTheme } from "$lib/utils/xterm";
// The stylesheet is needed for layout; the JS is imported in onMount so it
// never runs during SSR / prerender.
import "@xterm/xterm/css/xterm.css";

// Themed by the --terminal-* properties each host maps onto its own palette.

interface Props {
  /** Agent whose login command runs in the spawned PTY. */
  agent: AcpAgentId;
  agentLabel: string;
  /** Fired once the CLI reports a successful, freshly-verified login. */
  onDone: () => void;
  /** Abandon the embedded login (keeps the agent installed, just not authed). */
  onSkip: () => void;
}

let { agent, agentLabel, onDone, onSkip }: Props = $props();

let container: HTMLDivElement;
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let jobId: string | null = null;
let abort: AbortController | null = null;

let authUrl = $state<string | null>(null);
let failed = $state(false);
let errorMsg = $state<string | null>(null);

async function openBrowser(url: string): Promise<void> {
  // Same handoff the GitHub device-flow login uses (auth.svelte.ts): hand the
  // URL to the Tauri opener so it lands in the user's system browser.
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    // Opening the browser is best-effort — the URL is also visible in the
    // terminal and behind the "Reopen sign-in page" button.
  }
}

async function sendInput(data: string): Promise<void> {
  if (!jobId) return;
  try {
    await api.api.onboarding.login.input.post({ jobId, data });
  } catch {
    // A dropped keystroke is non-fatal — the user can retype.
  }
}

/**
 * Tell the server to kill the login PTY when this terminal goes away (skip,
 * agent switch, navigating off the onboarding step). Without this an abandoned
 * `claude auth login` / `codex login` / `cursor-agent login` keeps running on
 * the server until it self-exits — and the idempotent job map would rejoin the
 * wedged process on a re-open. `keepalive` lets the request outlive unmount.
 */
function cancelLogin(): void {
  if (!jobId) return;
  try {
    void api.api.onboarding.login.cancel
      .post({ jobId }, { fetch: { keepalive: true } })
      .catch(() => {});
  } catch {
    // Best-effort teardown — a server restart reclaims any straggler anyway.
  }
}

function applyEvent(event: LoginEvent): void {
  if (event.type === "data") {
    term?.write(event.chunk);
    return;
  }
  if (event.type === "auth-url") {
    // The login CLI opens the user's browser itself — we only surface the URL
    // as a fallback button so we don't pop a second browser tab.
    authUrl = event.url;
    return;
  }
  if (event.success) {
    onDone();
  } else {
    failed = true;
    errorMsg = event.error ?? "Sign-in failed.";
  }
}

async function streamLoginEvents(id: string, signal: AbortSignal): Promise<void> {
  try {
    await streamSse<LoginEvent>({
      path: `/api/onboarding/login/stream?jobId=${encodeURIComponent(id)}`,
      signal,
      onEvent: applyEvent,
    });
  } catch (e) {
    const message = sseErrorMessage(e, "Sign-in stream failed");
    if (signal.aborted || message === null) return;
    failed = true;
    errorMsg = message;
  }
}

function onResize(): void {
  try {
    fit?.fit();
  } catch {
    // fit() can throw if the container has zero size mid-transition.
  }
}

function terminalTheme(el: HTMLElement) {
  const token = cssTokens(el);
  const danger = token("--terminal-danger", "#b5494b");
  return xtermTheme({
    foreground: token("--terminal-fg", "#2a2825"),
    muted: token("--terminal-muted", "#9a958c"),
    dim: token("--terminal-dim", "#c4bfb6"),
    accent: token("--terminal-accent", "#6b5d3e"),
    danger,
    heading: token("--terminal-heading", "#1a1816"),
    cursor: token("--terminal-accent", "#6b5d3e"),
    cursorAccent: token("--terminal-bg", "#faf9f6"),
    selection: token("--terminal-selection", "rgba(107, 93, 62, 0.18)"),
  });
}

onMount(async () => {
  try {
    ({ jobId } = await call(api.api.onboarding.login.post({ agent }), "Failed to start sign-in"));
  } catch (e) {
    failed = true;
    errorMsg = e instanceof Error ? e.message : "Failed to start sign-in";
    return;
  }

  ({ term, fit } = await openXterm(container, {
    convertEol: false,
    cursorBlink: !prefersReducedMotion(),
    fontSize: 12,
    theme: terminalTheme(container),
  }));
  onResize();
  term.onData((d) => void sendInput(d));
  window.addEventListener("resize", onResize);

  const ctrl = new AbortController();
  abort = ctrl;
  void streamLoginEvents(jobId, ctrl.signal);
});

// xterm resolves the tokens above to literal colors at construction and never
// re-reads them, and the onboarding shell carries its own theme toggle, so
// reapply on every resolved-theme change. `term` isn't reactive: the first run
// lands before the async import resolves, when construction applies the theme.
$effect(() => {
  const resolved = getResolvedTheme();
  if (!term) return;
  // The `.dark` class on <html> is toggled synchronously before this effect
  // runs, so the --terminal-* tokens already resolve to the new theme.
  void resolved;
  term.options.theme = terminalTheme(container);
});

onDestroy(() => {
  abort?.abort();
  // Kill the server-side PTY too — aborting the SSE fetch alone leaves the
  // login CLI running. Covers skip, agent switch, and navigating away.
  cancelLogin();
  window.removeEventListener("resize", onResize);
  term?.dispose();
  term = null;
  fit = null;
});
</script>

<div class="login">
	<p class="lede">
		Sign in to <em>{agentLabel}</em> below. Your browser should open
		automatically — complete the login there, then return here.
	</p>

	{#if authUrl}
		<button class="auth-url" onclick={() => authUrl && openBrowser(authUrl)}>
			<ArrowSquareOut size={14} />
			<span>Open sign-in page</span>
		</button>
	{/if}

	<div class="terminal-frame" class:error={failed}>
		<div class="terminal" bind:this={container}></div>
	</div>

	{#if failed}
		<div class="login-error">{errorMsg ?? 'Sign-in failed.'}</div>
	{/if}

	<div class="login-actions">
		<button class="secondary" onclick={onSkip}>Skip for now</button>
	</div>
</div>

<style>
	.login {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}

	.lede {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 16px;
		line-height: 1.6;
		color: var(--terminal-body);
		margin: 0;
	}

	.lede em {
		font-style: italic;
		color: var(--terminal-accent);
	}

	.auth-url {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		background: none;
		border: 0;
		padding: 0;
		color: var(--terminal-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.auth-url:hover {
		color: var(--terminal-accent);
	}

	.terminal-frame {
		padding: 12px;
		border: 1px solid var(--terminal-border);
		border-radius: 2px;
		background: var(--terminal-surface);
		height: 280px;
		overflow: hidden;
	}

	.terminal-frame.error {
		border-color: var(--terminal-error-border);
	}

	.terminal {
		width: 100%;
		height: 100%;
		/* xterm 6's scrollbar paints a black inset shadow once scrolled. */
		--vscode-scrollbar-shadow: transparent;
	}

	.login-error {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11.5px;
		color: var(--terminal-accent);
	}

	.login-actions {
		display: flex;
		justify-content: flex-end;
	}

	.secondary {
		background: none;
		border: 0;
		padding: 8px 4px;
		color: var(--terminal-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.secondary:hover {
		color: var(--terminal-accent);
	}
</style>
