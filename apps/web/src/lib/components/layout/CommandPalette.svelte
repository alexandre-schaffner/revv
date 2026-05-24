<script lang="ts">
import type { PullRequest, Repository } from "@revv/shared";
import * as Command from "$lib/components/ui/command/index.js";
import {
  fuzzyScore,
  getFilteredCommands,
  resetQuery,
  setQuery as setCommandQuery,
} from "$lib/stores/commands.svelte";
import { getArchivedPrs, getPullRequests, getRepositories, selectPr } from "$lib/stores/prs.svelte";
import { type PaletteMode, setPaletteMode } from "$lib/stores/shortcuts.svelte";
import { setSidebarView } from "$lib/stores/sidebar.svelte";

interface Props {
  open: boolean;
  mode: PaletteMode;
  onOpenChange: (open: boolean) => void;
}

let { open, mode, onOpenChange }: Props = $props();

let inputValue = $state("");

// Reset query state whenever the palette is opened, or the mode flips while
// open. The store-backed `mode` is the source of truth; we only sync local
// input + command-store query off it.
$effect(() => {
  if (!open) return;
  if (mode === "command") {
    inputValue = ">";
    setCommandQuery("");
  } else {
    inputValue = "";
    resetQuery();
  }
});

function handleInputChange(val: string) {
  inputValue = val;
  const wantsCommand = val.startsWith(">");
  setPaletteMode(wantsCommand ? "command" : "search");
  setCommandQuery(wantsCommand ? val.slice(1).trim() : "");
}

const repoMap = $derived(new Map<string, Repository>(getRepositories().map((r) => [r.id, r])));

interface PrResult {
  pr: PullRequest;
  repoName: string;
  score: number;
}

const searchQuery = $derived(inputValue.trim());

function scoreList(prs: PullRequest[], q: string): PrResult[] {
  const repoNameOf = (pr: PullRequest) => repoMap.get(pr.repositoryId)?.fullName ?? "";
  if (q.length === 0) return prs.map((pr) => ({ pr, repoName: repoNameOf(pr), score: 0 }));
  return prs
    .map((pr) => {
      const repoName = repoNameOf(pr);
      const score = Math.max(
        fuzzyScore(q, pr.title),
        fuzzyScore(q, pr.sourceBranch),
        fuzzyScore(q, `#${pr.externalId}`),
        fuzzyScore(q, pr.authorLogin),
        fuzzyScore(q, repoName),
      );
      return { pr, repoName, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
}

const openResults = $derived(mode === "search" ? scoreList(getPullRequests(), searchQuery) : []);
const archivedResults = $derived(mode === "search" ? scoreList(getArchivedPrs(), searchQuery) : []);

const commands = $derived(mode === "command" ? getFilteredCommands() : []);
const hasResults = $derived(
  mode === "search" ? openResults.length + archivedResults.length > 0 : commands.length > 0,
);

function handlePrSelect(pr: PullRequest) {
  onOpenChange(false);
  // Mirror PrItem.handleClick: pair PR selection with sidebar swap to keep
  // header + body in lockstep regardless of entry point.
  selectPr(pr.id);
  setSidebarView("files");
}

function handleCommandSelect(action: () => void) {
  onOpenChange(false);
  action();
}

function hideBrokenImg(e: Event): void {
  (e.currentTarget as HTMLImageElement).style.display = "none";
}
</script>

<!--
  Styling note. The shadcn primitives carry their own Tailwind defaults
  (px-2/py-1.5 items, text-xs muted heading, rounded-sm hover). We keep the
  primitives and override the visual rhythm via `:global()` rules below,
  targeting the bits-ui `data-command-*` attributes so the selectors stay
  stable against shadcn class drift.
-->
{#snippet prRow(result: PrResult, kind: "open" | "archived")}
  <Command.Item
    value={`${kind}-${result.pr.id}`}
    onSelect={() => handlePrSelect(result.pr)}
    class={kind === "archived" ? "palette-pr-item palette-pr-item--archived" : "palette-pr-item"}
  >
    <div class="pr-row-top">
      {#if result.pr.authorAvatarContent}
        <img
          src={result.pr.authorAvatarContent}
          alt=""
          class="pr-avatar"
          loading="lazy"
          referrerpolicy="no-referrer"
          onerror={hideBrokenImg}
        />
      {/if}
      <span class="pr-title">{result.pr.title}</span>
      {#if kind === "archived"}
        <span class="pr-status-badge">{result.pr.status}</span>
      {/if}
      <span class="pr-meta">
        {result.repoName}<span class="pr-number">#{result.pr.externalId}</span>
      </span>
    </div>
    <div class="pr-row-bottom">
      <span class="pr-branch">{result.pr.sourceBranch}</span>
    </div>
  </Command.Item>
{/snippet}

<Command.Dialog
  {open}
  {onOpenChange}
  shouldFilter={false}
  title={mode === "command" ? "Command palette" : "Search pull requests"}
  description={mode === "command" ? "Run a command" : "Search and open pull requests"}
  contentClass="palette-shell sm:max-w-[520px]"
>
  <Command.Input
    value={inputValue}
    oninput={(e) => handleInputChange(e.currentTarget.value)}
    placeholder={mode === "command" ? "Type a command..." : "Search pull requests..."}
  />
  <Command.List class="max-h-[340px]">
    {#if mode === "search"}
      {#if openResults.length > 0}
        <Command.Group heading="Open pull requests">
          {#each openResults as result (result.pr.id)}
            {@render prRow(result, "open")}
          {/each}
        </Command.Group>
      {/if}
      {#if archivedResults.length > 0}
        <Command.Group heading="Archived pull requests">
          {#each archivedResults as result (result.pr.id)}
            {@render prRow(result, "archived")}
          {/each}
        </Command.Group>
      {/if}
      {#if !hasResults}
        <Command.Empty forceMount>No matching pull requests</Command.Empty>
      {/if}
    {:else}
      {#each commands as cmd (cmd.id)}
        <Command.Item
          value={cmd.id}
          onSelect={() => handleCommandSelect(cmd.action)}
          class="palette-cmd-item"
        >
          <span class="cmd-label">{cmd.label}</span>
          {#if cmd.shortcut}
            <kbd class="cmd-shortcut">{cmd.shortcut}</kbd>
          {/if}
        </Command.Item>
      {/each}
      {#if !hasResults}
        <Command.Empty forceMount>No matching commands</Command.Empty>
      {/if}
    {/if}
  </Command.List>
</Command.Dialog>

<style>
  /* Palette overrides restore the previous visual rhythm on top of the
     shadcn `Command.*` wrappers. Selectors mostly hit bits-ui's
     `data-command-*` attributes (stable across shadcn class drift); the
     input wrapper lives one level up in our own shadcn shell and uses
     `data-slot` instead. `:global` is required because the dialog content
     portals out of this component's scope. Flat selectors on purpose:
     Svelte's CSS compiler doesn't reliably pass native nesting through a
     `:global()` block. */
  :global(.palette-shell [data-slot="command-input-wrapper"]) {
    margin: 0;
    padding: 0 16px;
    gap: 10px;
    height: 44px;
    border: none;
    border-bottom: 1px solid var(--color-border-subtle);
    border-radius: 0;
    background: transparent;
  }
  :global(.palette-shell [data-slot="command-input-wrapper"] svg) {
    width: 14px;
    height: 14px;
    opacity: 1;
    color: var(--color-text-muted);
  }
  :global(.palette-shell [data-command-input]) {
    height: 100%;
    padding: 0;
    font-size: 14px;
  }
  :global(.palette-shell [data-command-list]) {
    padding: 4px 0;
  }
  :global(.palette-shell [data-command-group]) {
    padding: 0;
  }
  :global(.palette-shell [data-command-group-heading]) {
    padding: 6px 16px 2px;
    margin-top: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
    user-select: none;
  }
  :global(.palette-shell [data-command-item]) {
    padding: 8px 16px;
    border-radius: 0;
    gap: 12px;
    transition: background-color var(--duration-snap);
  }
  :global(.palette-shell [data-command-item][data-selected]),
  :global(.palette-shell [data-command-item][aria-selected="true"]) {
    background: var(--color-tree-active-bg);
    color: var(--color-tree-active-text);
  }
  :global(.palette-shell [data-command-empty]) {
    padding: 24px 16px;
    font-size: 12px;
    color: var(--color-text-muted);
  }

  /* Command rows: label left, kbd shortcut right. */
  :global(.palette-shell .palette-cmd-item) {
    align-items: center;
    justify-content: space-between;
  }
  :global(.palette-shell .palette-cmd-item .cmd-label) {
    font-size: 13px;
    color: var(--color-text-secondary);
  }
  :global(.palette-shell .palette-cmd-item[data-selected] .cmd-label),
  :global(.palette-shell .palette-cmd-item[aria-selected="true"] .cmd-label) {
    color: var(--color-tree-active-text);
  }
  :global(.palette-shell .palette-cmd-item .cmd-shortcut) {
    margin-inline-start: auto;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--color-bg-tertiary);
    border: 1px solid var(--color-border-subtle);
    color: var(--color-text-muted);
    flex-shrink: 0;
  }

  /* PR rows: avatar + title + meta on top, branch on bottom indented past
     the avatar so it aligns under the title. */
  :global(.palette-shell .palette-pr-item) {
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
  }
  :global(.palette-shell .palette-pr-item .pr-row-top) {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  :global(.palette-shell .palette-pr-item .pr-avatar) {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  :global(.palette-shell .palette-pr-item .pr-title) {
    font-size: 13px;
    font-weight: 500;
    color: var(--color-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  :global(.palette-shell .palette-pr-item--archived .pr-title) {
    color: var(--color-text-secondary);
  }
  :global(.palette-shell .palette-pr-item[data-selected] .pr-title),
  :global(.palette-shell .palette-pr-item[aria-selected="true"] .pr-title) {
    color: var(--color-tree-active-text);
  }
  :global(.palette-shell .palette-pr-item .pr-status-badge) {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--color-bg-tertiary);
    color: var(--color-text-muted);
    flex-shrink: 0;
  }
  :global(.palette-shell .palette-pr-item .pr-meta) {
    font-size: 11px;
    color: var(--color-text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  :global(.palette-shell .palette-pr-item .pr-number) {
    font-family: var(--font-mono);
    margin-inline-start: 4px;
  }
  :global(.palette-shell .palette-pr-item .pr-row-bottom) {
    padding-inline-start: 24px;
  }
  :global(.palette-shell .palette-pr-item .pr-branch) {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--color-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
