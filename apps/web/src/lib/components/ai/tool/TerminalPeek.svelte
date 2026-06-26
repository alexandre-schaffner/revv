<script lang="ts">
// ── TerminalPeek ─────────────────────────────────────────────────────────────
//
// Read-only xterm view of a Bash tool call: the command followed by its
// captured stdout/stderr (when the agent reported a terminal result). xterm is
// dynamically imported in onMount so it never runs during SSR/prerender, and it
// only mounts when the parent ToolCallCard is expanded — so the (canvas-backed)
// terminal cost is paid per-open, not per tool call. Theme is read off resolved
// CSS tokens since xterm can't resolve `var()`.
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import { onDestroy, onMount } from "svelte";
import "@xterm/xterm/css/xterm.css";

interface Props {
  /** The shell command that was run. */
  command: string;
  /** Captured stdout/stderr, if the result has arrived. */
  output?: string | undefined;
  /** Whether the command ended in error (tints the output). */
  isError?: boolean | undefined;
}

let { command, output, isError = false }: Props = $props();

let container: HTMLDivElement;
let term: Terminal | null = null;
let fit: FitAddon | null = null;

const MAX_ROWS = 20;

function readTheme(el: HTMLElement): { fontFamily: string; theme: ITheme } {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  const fg = v("--color-text-primary", "#1a1816");
  const muted = v("--color-text-muted", "#8a857c");
  const accent = v("--color-accent", "#6b5d3e");
  const danger = v("--color-destructive", "#b5494b");
  return {
    fontFamily: v("--font-mono", '"JetBrains Mono", "Fira Code", monospace'),
    theme: {
      background: "#00000000",
      foreground: fg,
      cursor: "#00000000",
      selectionBackground: v("--color-tree-active-bg", "rgba(107, 93, 62, 0.18)"),
      black: muted,
      red: danger,
      green: accent,
      yellow: accent,
      blue: muted,
      magenta: accent,
      cyan: muted,
      white: fg,
      brightBlack: muted,
      brightRed: danger,
      brightGreen: accent,
      brightYellow: accent,
      brightBlue: muted,
      brightMagenta: accent,
      brightCyan: muted,
      brightWhite: fg,
    },
  };
}

/** ANSI escape helpers (literal — xterm renders these, not CSS). */
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

onMount(async () => {
  const rows = Math.min(
    MAX_ROWS,
    Math.max(1, command.split("\n").length + (output ? output.split("\n").length : 0)),
  );
  // Size the container to the content (capped) before fitting so the terminal
  // claims exactly the rows it needs and scrolls only when overflowing.
  container.style.height = `${rows * 16 + 8}px`;

  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);
  const { fontFamily, theme } = readTheme(container);
  term = new Terminal({
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    fontSize: 12,
    lineHeight: 1.15,
    fontFamily,
    allowTransparency: true,
    scrollback: 5000,
    theme,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  try {
    fit.fit();
  } catch {
    // fit() throws on a zero-size container mid-transition — harmless.
  }
  term.write(buildText());
});

onDestroy(() => {
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
	}

	.terminal-peek :global(.xterm) {
		padding: 0;
	}

	.terminal-peek :global(.xterm-viewport) {
		background: transparent !important;
	}
</style>
