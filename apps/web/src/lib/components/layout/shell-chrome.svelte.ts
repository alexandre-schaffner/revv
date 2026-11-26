import { getContext, onDestroy, type Snippet, setContext, untrack } from "svelte";

/**
 * Chrome a page (or any component inside it) shows in the shell around it.
 * AppShell renders it outside the page's keyed slot, so it doesn't fade with
 * page transitions.
 *
 * A page re-mounts when the URL changes within its route (one review page per
 * PR), and `{@render}` re-mounts its content whenever the snippet's identity
 * changes. Chrome that must stay mounted across that hop has to pass a snippet
 * that doesn't close over component state: export it from `<script module>`
 * (Svelte refuses to compile the export otherwise) and take what it shows as
 * the snippet's argument.
 */
export interface ShellChrome {
  /** Appended to the PR title in the top bar. */
  subtitle?: string | null | undefined;
  /**
   * Floats over the top of the main pane, rendered with `key` (the review
   * page's PR id, so one module-level snippet serves every PR).
   */
  tabs?: { readonly snippet: Snippet<[key: string]>; readonly key: string } | undefined;
  /** Floats over the bottom of the main pane; render its controls in an `.actions-row`. */
  actions?: Snippet | undefined;
  /** Right of the agent selectors in the bottom bar. */
  status?: Snippet | undefined;
}

const KEY = Symbol("shell-chrome");

class ShellChromeHost {
  // A plain list with a version to re-derive on, not a `$state` array: a page
  // switch registers the new page and unregisters the old one in overlapping
  // batches, and a read-modify-write of reactive state across them lost the
  // new page's entry (its tabs vanished after the first PR switch).
  readonly #entries: (() => ShellChrome)[] = [];
  #version = $state(0);

  /** Per field, the most recently registered entry that defines it wins. */
  readonly current = $derived.by((): ShellChrome => {
    void this.#version;
    const merged: ShellChrome = {};
    for (const read of this.#entries) {
      const chrome = read();
      if (chrome.subtitle !== undefined) merged.subtitle = chrome.subtitle;
      if (chrome.tabs !== undefined) merged.tabs = chrome.tabs;
      if (chrome.actions !== undefined) merged.actions = chrome.actions;
      if (chrome.status !== undefined) merged.status = chrome.status;
    }
    return merged;
  });

  // Untracked: components register during init, inside their parent's effect.
  #bump(): void {
    this.#version = untrack(() => this.#version) + 1;
  }

  register(read: () => ShellChrome): () => void {
    this.#entries.push(read);
    this.#bump();
    return () => {
      const at = this.#entries.indexOf(read);
      if (at === -1) return;
      this.#entries.splice(at, 1);
      this.#bump();
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
