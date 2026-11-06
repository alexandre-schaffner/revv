import { getContext, onDestroy, type Snippet, setContext } from "svelte";

/**
 * Chrome a page (or any component inside it) shows in the shell around it.
 * AppShell renders it outside the page's keyed slot, so it doesn't fade with
 * page transitions.
 *
 * A page re-mounts when the URL changes within its route (one review page per
 * PR), and `{@render}` re-mounts its content whenever the snippet's identity
 * changes. Chrome that must stay mounted across that hop has to pass a snippet
 * that doesn't close over component state: export it from `<script module>`
 * (Svelte refuses to compile the export otherwise) and read state from stores.
 */
export interface ShellChrome {
  /** Appended to the PR title in the top bar. */
  subtitle?: string | null | undefined;
  /** Floats over the top of the main pane. */
  tabs?: Snippet | undefined;
  /** Floats over the bottom of the main pane. */
  actions?: Snippet | undefined;
}

const KEY = Symbol("shell-chrome");

class ShellChromeHost {
  #entries = $state<(() => ShellChrome)[]>([]);

  /** Per field, the most recently registered entry that defines it wins. */
  readonly current = $derived.by((): ShellChrome => {
    const merged: ShellChrome = {};
    for (const read of this.#entries) {
      const chrome = read();
      if (chrome.subtitle !== undefined) merged.subtitle = chrome.subtitle;
      if (chrome.tabs !== undefined) merged.tabs = chrome.tabs;
      if (chrome.actions !== undefined) merged.actions = chrome.actions;
    }
    return merged;
  });

  register(read: () => ShellChrome): () => void {
    this.#entries = [...this.#entries, read];
    return () => {
      this.#entries = this.#entries.filter((entry) => entry !== read);
    };
  }
}

/** Called once by AppShell. */
export function provideShellChrome(): ShellChromeHost {
  const host = new ShellChromeHost();
  setContext(KEY, host);
  return host;
}

/**
 * Show chrome in the shell for as long as the calling component is mounted.
 * Call during component init. `read` is reactive: return `undefined` for a
 * field to hand it back to whoever registered it before.
 */
export function useShellChrome(read: () => ShellChrome): void {
  const host = getContext<ShellChromeHost | undefined>(KEY);
  if (!host) return;
  onDestroy(host.register(read));
}
