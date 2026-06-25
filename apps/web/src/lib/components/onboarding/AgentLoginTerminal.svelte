<script lang="ts">
import type { AcpAgentId, LoginEvent } from "@revv/shared";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import ArrowSquareOut from "phosphor-svelte/lib/ArrowSquareOut";
import { onDestroy, onMount } from "svelte";
import { API_BASE_URL } from "$lib/api/base-url";
import { prefersReducedMotion } from "$lib/motion";
import { authHeaders } from "$lib/utils/session-token";
import { parseSSEBuffer } from "$lib/utils/sse-parser";
// xterm ships its own canvas/DOM — acceptable for a literal terminal. The
// stylesheet is required for layout; the JS is dynamically imported in onMount
// so it never runs during SSR / prerender.
import "@xterm/xterm/css/xterm.css";

interface Props {
  /** Agent whose login command runs in the spawned PTY. */
  agent: AcpAgentId;
  /** Human label for the lede / buttons. */
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
  // Same handoff the GitHub device-flow login uses (auth.svelte.ts): the Tauri
  // opener in the desktop shell, `window.open` in browser dev.
  try {
    const { isTauri } = await import("$lib/utils/platform");
    if (isTauri()) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank");
    }
  } catch {
    // Opening the browser is best-effort — the URL is also visible in the
    // terminal and behind the "Reopen sign-in page" button.
  }
}

async function sendInput(data: string): Promise<void> {
  if (!jobId) return;
  try {
    await fetch(`${API_BASE_URL}/api/onboarding/login/input`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, data }),
    });
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
    void fetch(`${API_BASE_URL}/api/onboarding/login/cancel`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
      keepalive: true,
    }).catch(() => {});
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
  // done
  if (event.success) {
    onDone();
  } else {
    failed = true;
    errorMsg = event.error ?? "Sign-in failed.";
  }
}

async function streamLoginEvents(id: string, signal: AbortSignal): Promise<void> {
  const url = `${API_BASE_URL}/api/onboarding/login/stream?jobId=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok || !res.body) {
    failed = true;
    errorMsg = `Sign-in stream failed (HTTP ${res.status})`;
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const result = parseSSEBuffer<LoginEvent>(buffer);
    buffer = result.remaining;
    for (const event of result.events) applyEvent(event);
    if (result.done) break;
  }
}

function onResize(): void {
  try {
    fit?.fit();
  } catch {
    // fit() can throw if the container has zero size mid-transition.
  }
}

/**
 * xterm can't resolve CSS `var()` — it needs literal color/font strings to
 * measure glyph cells and paint. Read the resolved onboarding tokens off the
 * mounted element so the terminal tracks light/dark mode and the warm paper
 * palette instead of xterm's default white-on-black (invisible here) plus its
 * garish bright-ANSI colors.
 */
function readTerminalStyle(el: HTMLElement): {
  fontFamily: string;
  theme: ITheme;
} {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;

  const fg = v("--ob-text", "#2a2825");
  const muted = v("--ob-text-muted", "#9a958c");
  const dim = v("--ob-text-dimmed", "#c4bfb6");
  const accent = v("--ob-text-italic", "#6b5d3e");
  const heading = v("--ob-text-heading", "#1a1816");

  return {
    fontFamily: v("--font-mono", '"JetBrains Mono", "Fira Code", monospace'),
    theme: {
      background: "#00000000",
      foreground: fg,
      cursor: accent,
      cursorAccent: v("--ob-bg", "#faf9f6"),
      selectionBackground: v("--ob-row-highlight", "rgba(107, 93, 62, 0.18)"),
      // Map the 16 ANSI slots onto the onboarding palette so CLI-colored
      // output (cyan tips, dim hints, bold headings) reads on the paper bg.
      black: dim,
      red: v("--ob-error", "#b5494b"),
      green: accent,
      yellow: accent,
      blue: muted,
      magenta: accent,
      cyan: muted,
      white: fg,
      brightBlack: muted,
      brightRed: v("--ob-error", "#b5494b"),
      brightGreen: accent,
      brightYellow: accent,
      brightBlue: muted,
      brightMagenta: accent,
      brightCyan: muted,
      brightWhite: heading,
    },
  };
}

onMount(async () => {
  // 1. Start (or join) the login job.
  try {
    const res = await fetch(`${API_BASE_URL}/api/onboarding/login`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ agent }),
    });
    if (!res.ok) {
      failed = true;
      errorMsg = `Failed to start sign-in (HTTP ${res.status})`;
      return;
    }
    ({ jobId } = (await res.json()) as { jobId: string });
  } catch (e) {
    failed = true;
    errorMsg = e instanceof Error ? e.message : "Failed to start sign-in";
    return;
  }

  // 2. Mount the terminal (client-only import).
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const { fontFamily, theme } = readTerminalStyle(container);
  term = new Terminal({
    convertEol: false,
    cursorBlink: !prefersReducedMotion(),
    fontSize: 12,
    fontFamily,
    allowTransparency: true,
    theme,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  onResize();
  term.onData((d) => void sendInput(d));
  window.addEventListener("resize", onResize);

  // 3. Stream the PTY output.
  const ctrl = new AbortController();
  abort = ctrl;
  void streamLoginEvents(jobId, ctrl.signal);
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
		color: var(--ob-text-body);
		margin: 0;
	}

	.lede em {
		font-style: italic;
		color: var(--ob-text-italic);
	}

	.auth-url {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		background: none;
		border: 0;
		padding: 0;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.auth-url:hover {
		color: var(--ob-text-italic);
	}

	.terminal-frame {
		padding: 12px;
		border: 1px solid var(--ob-border);
		border-radius: 2px;
		background: var(--ob-hover-subtle);
		height: 280px;
		overflow: hidden;
	}

	.terminal-frame.error {
		border-color: var(--ob-text-label);
	}

	.terminal {
		width: 100%;
		height: 100%;
	}

	.login-error {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 11.5px;
		color: var(--ob-text-italic);
	}

	.login-actions {
		display: flex;
		justify-content: flex-end;
	}

	.secondary {
		background: none;
		border: 0;
		padding: 8px 4px;
		color: var(--ob-text-muted);
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color var(--duration-snap) var(--ease-out-expo);
	}

	.secondary:hover {
		color: var(--ob-text-italic);
	}
</style>
