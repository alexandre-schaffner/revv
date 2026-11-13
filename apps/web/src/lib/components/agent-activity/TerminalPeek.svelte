<script lang="ts">
// Read-only terminal view of a Bash tool call: the command, then its captured
// output. Mounted only when its card opens, so the canvas is paid per open.
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import { onDestroy, onMount } from "svelte";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import { cssTokens, openXterm, xtermTheme } from "$lib/utils/xterm";
import "@xterm/xterm/css/xterm.css";

interface Props {
  command: string;
  output?: string | undefined;
  isError?: boolean | undefined;
}

let { command, output, isError = false }: Props = $props();

let container: HTMLDivElement;
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let destroyed = false;

const MAX_ROWS = 20;
const FONT_SIZE = 12;
const LINE_HEIGHT = 1.15;
// The container is sized in rows of this pitch, kept above FONT_SIZE * LINE_HEIGHT
// so the last row is never clipped.
const ROW_PX = 16;
const PADDING_PX = 8;

function theme(el: HTMLElement) {
  const token = cssTokens(el);
  const muted = token("--color-text-muted", "#8a857c");
  const foreground = token("--color-text-primary", "#1a1816");
  return xtermTheme({
    foreground,
    muted,
    dim: muted,
    accent: token("--color-accent", "#6b5d3e"),
    danger: token("--color-destructive", "#b5494b"),
    heading: foreground,
    cursor: "#00000000",
    selection: token("--color-tree-active-bg", "rgba(107, 93, 62, 0.18)"),
  });
}

const DIM = "\x1b[90m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function buildText(): string {
  const lines: string[] = [];
  for (const line of command.split("\n")) {
    lines.push(`${DIM}❯${RESET} ${BOLD}${line}${RESET}`);
  }
  if (output && output.length > 0) {
    const tint = isError ? RED : "";
    for (const line of output.replace(/\s+$/, "").split("\n")) {
      lines.push(`${tint}${line}${RESET}`);
    }
  }
  return lines.join("\r\n");
}

function refit(): void {
  try {
    fit?.fit();
  } catch {
    // fit() throws on a zero-size container mid-transition — harmless.
  }
}

onMount(async () => {
  const rows = Math.min(
    MAX_ROWS,
    Math.max(1, command.split("\n").length + (output ? output.split("\n").length : 0)),
  );
  // Claim exactly the rows the content needs, so it scrolls only past MAX_ROWS.
  container.style.height = `${rows * ROW_PX + PADDING_PX}px`;

  const opened = await openXterm(container, {
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    fontSize: FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    scrollback: 5000,
    theme: theme(container),
  });
  // Collapsed while xterm was still loading.
  if (destroyed) {
    opened.term.dispose();
    return;
  }
  ({ term, fit } = opened);
  refit();
  term.write(buildText());
  // The chat panel and the walkthrough column both resize.
  resizeObserver = new ResizeObserver(refit);
  resizeObserver.observe(container);
});

// xterm keeps the colors it was given, so re-read them when the theme flips.
// `term` isn't reactive: the run before the terminal exists has nothing to do.
$effect(() => {
  void getResolvedTheme();
  if (term) term.options.theme = theme(container);
});

onDestroy(() => {
  destroyed = true;
  resizeObserver?.disconnect();
  term?.dispose();
  term = null;
  fit = null;
});
</script>

<div class="terminal-peek">
	<div class="terminal" bind:this={container}></div>
</div>

<style>
	.terminal-peek {
		overflow: hidden;
		border-radius: 0.375rem;
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-muted) 50%, transparent);
		padding: 0.5rem 0.625rem;
	}

	.terminal {
		width: 100%;
		/* xterm 6's scrollbar paints a black inset shadow once scrolled. */
		--vscode-scrollbar-shadow: transparent;
	}

	.terminal-peek :global(.xterm) {
		padding: 0;
	}

	.terminal-peek :global(.xterm-viewport) {
		background: transparent !important;
	}
</style>
