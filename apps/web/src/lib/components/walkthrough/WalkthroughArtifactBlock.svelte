<script lang="ts">
import type { ArtifactBlock } from "@revv/shared";
import { convertFileSrc } from "@tauri-apps/api/core";
import WarningCircle from "phosphor-svelte/lib/WarningCircle";
import { onDestroy, untrack } from "svelte";
import { browser } from "$app/environment";
import { gsap, tokens as motionTokens, prefersReducedMotion } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";

interface Props {
  block: ArtifactBlock;
}

type ArtifactTheme = "light" | "dark";
type ArtifactTokens = Record<string, string>;

type HostMessage =
  | { kind: "ready" }
  | { kind: "mounted" }
  | { kind: "resize"; height: number }
  | { kind: "error"; message: string };

let { block }: Props = $props();

let iframeEl = $state<HTMLIFrameElement | null>(null);
let frameReady = $state(false);
let status = $state<"loading" | "ready" | "error">("loading");
let errorMessage = $state<string | null>(null);
let iframeHeight = $state(240);
// The HTML currently rendered inside the live host document, and a key that
// forces a fresh iframe when it must be re-rendered. The host injects content
// via `document.write`, which tears down the host's own message listener — so
// a second `mount` postMessage is silently dropped. To re-render (a chat-edit
// changing `block.html`) we recreate the iframe via `{#key reloadKey}` so a
// fresh host document, with a live listener, receives the new HTML.
let mountedHtml = $state<string | null>(null);
let reloadKey = $state(0);
let shellEl: HTMLDivElement | null = null;

// If the host never reports `mounted` (a dropped postMessage, a webview that
// swallowed the rAF), reveal the frame anyway after this long rather than
// leaving the user staring at "Rendering…" forever — the artifact HTML was
// already injected by `mount`; only the height/reveal handshake is missing.
const MOUNT_TIMEOUT_MS = 4000;
let mountWatchdog: ReturnType<typeof setTimeout> | null = null;

const hostUrl = $derived.by(() => {
  if (!browser) return "about:blank";
  // Tauri addresses custom URI schemes differently per platform: macOS/iOS use
  // the real `artifact://localhost/...` scheme, while Windows (WebView2) and
  // Linux (WebKitGTK) expose it at `http://artifact.localhost/...`. Both forms
  // are allow-listed in tauri.conf.json → frame-src. Let Tauri pick the right
  // one via `convertFileSrc` (it reads the OS at runtime) rather than sniffing
  // `window.location.protocol`: in dev the frontend is served from the Vite
  // dev server, so the protocol is `http:` even inside the macOS app — the old
  // check then wrongly chose the `http://artifact.localhost` form, which macOS
  // WKWebView can't resolve, so the iframe never loaded and stuck on "Rendering".
  return convertFileSrc("artifact-host.html", "artifact");
});

function collectThemeTokens(): ArtifactTokens {
  if (!browser) return {};
  const styles = getComputedStyle(document.documentElement);
  const names = [
    // Surfaces
    "--color-bg-primary",
    "--color-bg-secondary",
    "--color-bg-tertiary",
    "--color-bg-elevated",
    // Lines
    "--color-border",
    "--color-border-subtle",
    // Text
    "--color-text-primary",
    "--color-text-secondary",
    "--color-text-muted",
    // Accent (the one accent — no AI violet)
    "--color-accent",
    "--color-accent-hover",
    "--color-accent-muted",
    // Status
    "--color-success",
    "--color-warning",
    "--color-danger",
    // Type
    "--font-sans",
    "--font-mono",
    // Geometry (static, injected so artifacts match app metrics)
    "--radius-card",
    "--radius-island",
    "--spacing-island-half",
    "--spacing-island",
    "--spacing-inset",
    "--spacing-island-2x",
  ];
  return Object.fromEntries(names.map((name) => [name, styles.getPropertyValue(name).trim()]));
}

function postMount(html: string): void {
  const target = iframeEl?.contentWindow;
  if (!target) return;
  const theme = getResolvedTheme();
  target.postMessage(
    {
      kind: "mount",
      html,
      theme,
      tokens: collectThemeTokens(),
    },
    "*",
  );
}

function postTheme(theme: ArtifactTheme): void {
  const target = iframeEl?.contentWindow;
  if (!target) return;
  target.postMessage({ kind: "theme", theme, tokens: collectThemeTokens() }, "*");
}

function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = value.kind;
  if (kind === "ready" || kind === "mounted") return true;
  if (kind === "resize") return "height" in value && typeof value.height === "number";
  if (kind === "error") return "message" in value && typeof value.message === "string";
  return false;
}

function reveal(): void {
  if (!shellEl || prefersReducedMotion()) return;
  gsap.fromTo(
    shellEl,
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: motionTokens.quick, ease: motionTokens.easeOutExpo },
  );
}

/**
 * Inject the current HTML into the host. Idempotent: re-running with the
 * same HTML is a no-op, so it's safe to call from both the iframe `load`
 * event and the host's `ready` message — whichever wins mounts, the other
 * is skipped.
 *
 * Driving the mount off `load` (not solely the one-shot `ready` postMessage)
 * removes two races: the host can post `ready` before Svelte's `bind:this`
 * has assigned `iframeEl` (so `onHostMessage` drops it as `event.source`
 * mismatches), and a synchronously-served host document (Tauri's custom
 * `artifact://` scheme) can fire before the listener is even attached. By
 * `load`, the host's inline script — including its `mount` listener — has
 * always run, so the post is guaranteed to land.
 */
function mountIntoFrame(): void {
  if (!iframeEl?.contentWindow) return;
  if (mountedHtml === block.html) return;
  frameReady = true;
  status = "loading";
  errorMessage = null;
  postMount(block.html);
  mountedHtml = block.html;
  if (mountWatchdog) clearTimeout(mountWatchdog);
  mountWatchdog = setTimeout(() => {
    if (status === "loading") {
      status = "ready";
      reveal();
    }
  }, MOUNT_TIMEOUT_MS);
}

function onHostMessage(event: MessageEvent): void {
  const source = iframeEl?.contentWindow;
  if (!source || event.source !== source) return;
  if (!isHostMessage(event.data)) return;

  if (event.data.kind === "ready") {
    // Backup path: the iframe `load` handler is the primary mount trigger,
    // but if `ready` arrives first (and `iframeEl` is bound), mount now.
    mountIntoFrame();
    return;
  }

  if (event.data.kind === "mounted") {
    if (mountWatchdog) {
      clearTimeout(mountWatchdog);
      mountWatchdog = null;
    }
    status = "ready";
    reveal();
    return;
  }

  if (event.data.kind === "resize") {
    iframeHeight = Math.min(Math.max(Math.ceil(event.data.height), 160), 1600);
    return;
  }

  if (mountWatchdog) {
    clearTimeout(mountWatchdog);
    mountWatchdog = null;
  }
  status = "error";
  errorMessage = event.data.message || "Artifact failed to render.";
}

$effect(() => {
  const html = block.html;
  // Initial mount is driven by the iframe `load` handler; this effect only
  // handles a later change to `block.html` (e.g. a chat-edit). Because the host
  // can't receive a second `mount`, recreate the iframe so a fresh host
  // re-mounts.
  if (mountedHtml === null) return; // not mounted yet — `load`/`ready` will mount it
  if (html === mountedHtml) return; // unchanged
  untrack(() => {
    if (mountWatchdog) {
      clearTimeout(mountWatchdog);
      mountWatchdog = null;
    }
    frameReady = false;
    status = "loading";
    errorMessage = null;
    mountedHtml = null;
    reloadKey++;
  });
});

$effect(() => {
  const theme = getResolvedTheme();
  if (!frameReady) return;
  postTheme(theme);
});

onDestroy(() => {
  if (mountWatchdog) clearTimeout(mountWatchdog);
});
</script>

<svelte:window onmessage={onHostMessage} />

<div class="artifact-block" bind:this={shellEl}>
  {#if status === "loading"}
    <div class="artifact-placeholder">Rendering...</div>
  {/if}

  {#if status === "error"}
    <div class="artifact-fallback">
      <div class="artifact-error">
        <WarningCircle size={16} weight="fill" />
        <span>{errorMessage ?? "Artifact failed to render."}</span>
      </div>
      <pre class="artifact-source"><code>{block.html}</code></pre>
    </div>
  {:else}
    {#key reloadKey}
      <iframe
        bind:this={iframeEl}
        class="artifact-frame"
        class:artifact-frame--ready={status === "ready"}
        src={hostUrl}
        title="Interactive walkthrough artifact"
        sandbox="allow-scripts"
        style:height={`${iframeHeight}px`}
        onload={mountIntoFrame}
      ></iframe>
    {/key}
  {/if}
</div>

<style>
  .artifact-block {
    position: relative;
    overflow: clip;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-bg-primary);
  }

  .artifact-placeholder {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: grid;
    place-items: center;
    min-height: 160px;
    padding: 18px;
    background: color-mix(in srgb, var(--color-bg-secondary) 72%, transparent);
    color: var(--color-text-muted);
    font-size: 13px;
  }

  .artifact-frame {
    display: block;
    width: 100%;
    min-height: 160px;
    border: 0;
    opacity: 0;
    background: var(--color-bg-primary);
  }

  .artifact-frame--ready {
    opacity: 1;
  }

  .artifact-fallback {
    display: grid;
    gap: 12px;
    padding: 14px;
    background: var(--color-bg-secondary);
  }

  .artifact-error {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--color-danger);
    font-size: 13px;
    font-weight: 500;
  }

  .artifact-source {
    max-height: 360px;
    margin: 0;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg-primary);
    padding: 12px;
    color: var(--color-text-secondary);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
