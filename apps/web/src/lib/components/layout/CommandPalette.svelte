<script lang="ts">
import type { PullRequest, Repository } from "@revv/shared";
import Search from "phosphor-svelte/lib/MagnifyingGlass";
import { untrack } from "svelte";
import { fade, scale } from "svelte/transition";
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
  onClose: () => void;
}

let { open, mode, onClose }: Props = $props();

let inputValue = $state("");
let selectedFlatIndex = $state(0);
let inputEl: HTMLInputElement | undefined = $state();
let listEl: HTMLDivElement | undefined = $state();

// ── Mode switching via `>` prefix ────────────────────

function handleInput(e: Event) {
  const val = (e.target as HTMLInputElement).value;
  inputValue = val;

  if (mode === "search" && val.startsWith(">")) {
    setPaletteMode("command");
    setCommandQuery(val.slice(1).trim());
  } else if (mode === "command" && !val.startsWith(">")) {
    setPaletteMode("search");
    setCommandQuery("");
  } else if (mode === "command") {
    setCommandQuery(val.slice(1).trim());
  }
}

// ── PR search ────────────────────────────────────────

const repoMap = $derived(new Map<string, Repository>(getRepositories().map((r) => [r.id, r])));

interface PrResult {
  pr: PullRequest;
  repoName: string;
  score: number;
}

function scorePr(pr: PullRequest, q: string): number {
  const repoName = repoMap.get(pr.repositoryId)?.fullName ?? "";
  return Math.max(
    fuzzyScore(q, pr.title),
    fuzzyScore(q, pr.sourceBranch),
    fuzzyScore(q, `#${pr.externalId}`),
    fuzzyScore(q, pr.authorLogin),
    fuzzyScore(q, repoName),
  );
}

const openResults = $derived.by((): PrResult[] => {
  if (mode !== "search") return [];
  const prs = getPullRequests();
  const q = inputValue.trim();
  if (q.length === 0) {
    return prs.map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: 0,
    }));
  }
  return prs
    .map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: scorePr(pr, q),
    }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
});

const archivedResults = $derived.by((): PrResult[] => {
  if (mode !== "search") return [];
  const prs = getArchivedPrs();
  const q = inputValue.trim();
  if (q.length === 0) {
    return prs.map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: 0,
    }));
  }
  return prs
    .map((pr) => ({
      pr,
      repoName: repoMap.get(pr.repositoryId)?.fullName ?? "",
      score: scorePr(pr, q),
    }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score);
});

type FlatItem =
  | { kind: "header"; label: string }
  | { kind: "pr"; result: PrResult; section: "open" | "archived" };

const flatItems = $derived.by((): FlatItem[] => {
  const items: FlatItem[] = [];
  if (openResults.length > 0) {
    items.push({ kind: "header", label: "Open pull requests" });
    for (const r of openResults) items.push({ kind: "pr", result: r, section: "open" });
  }
  if (archivedResults.length > 0) {
    items.push({ kind: "header", label: "Archived pull requests" });
    for (const r of archivedResults) items.push({ kind: "pr", result: r, section: "archived" });
  }
  return items;
});

const commands = $derived(mode === "command" ? getFilteredCommands() : []);

// ── Selection helpers ────────────────────────────────

function nextSelectable(start: number, direction: 1 | -1): number {
  const items = flatItems;
  if (items.length === 0) return 0;
  let i = start;
  let loops = 0;
  while (loops < items.length) {
    i = (i + direction + items.length) % items.length;
    if (items[i]?.kind === "pr") return i;
    loops++;
  }
  return start;
}

// ── Reset on open/mode change ────────────────────────

$effect(() => {
  if (open) {
    if (mode === "command") {
      inputValue = ">";
      setCommandQuery("");
    } else {
      inputValue = "";
      resetQuery();
    }

    // Focus input on next tick
    requestAnimationFrame(() => inputEl?.focus());

    // Land selection on first selectable PR row
    selectedFlatIndex = untrack(() => (flatItems.length > 0 ? nextSelectable(0, 1) : 0));
  }
});

// Clamp selection when the flat list shrinks
$effect(() => {
  const items = flatItems;
  if (items.length > 0 && items[selectedFlatIndex]?.kind !== "pr") {
    selectedFlatIndex = nextSelectable(selectedFlatIndex, -1);
  }
});

// ── Keyboard navigation ──────────────────────────────

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (mode === "search" && flatItems.length > 0) {
      selectedFlatIndex = nextSelectable(selectedFlatIndex, 1);
      scrollToSelected();
    } else if (mode === "command" && commands.length > 0) {
      selectedFlatIndex = (selectedFlatIndex + 1) % commands.length;
      scrollToSelected();
    }
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (mode === "search" && flatItems.length > 0) {
      selectedFlatIndex = nextSelectable(selectedFlatIndex, -1);
      scrollToSelected();
    } else if (mode === "command" && commands.length > 0) {
      selectedFlatIndex = (selectedFlatIndex - 1 + commands.length) % commands.length;
      scrollToSelected();
    }
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    executeSelected();
    return;
  }
}

function scrollToSelected() {
  requestAnimationFrame(() => {
    const item = listEl?.querySelector(`[data-flat-index="${selectedFlatIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  });
}

function executeSelected() {
  if (mode === "search") {
    const item = flatItems[selectedFlatIndex];
    if (item?.kind === "pr") {
      onClose();
      // Mirror `PrItem.handleClick`: navigating to a PR through the
      // palette must also swipe the sidebar into files view, otherwise
      // the header renders the prs-mode "PULL REQUESTS" label while
      // the body is showing the files pane (desynced — the user sees
      // a file tree under a "Pull Requests" header). Driving both
      // `selectedPrId` and `sidebarView` together keeps header +
      // body in lockstep regardless of the entry point.
      selectPr(item.result.pr.id);
      setSidebarView("files");
    }
  } else {
    const cmd = commands[selectedFlatIndex];
    if (cmd) {
      onClose();
      cmd.action();
    }
  }
}

function handleItemClick(flatIndex: number) {
  selectedFlatIndex = flatIndex;
  executeSelected();
}
</script>

{#if open}
	<!-- Backdrop.
	     `in:fade` only — the backdrop must DISAPPEAR INSTANTLY when the palette
	     closes, otherwise the full-viewport, `pointer-events: auto` div sits
	     on top of the app for 150ms post-close and steals any clicks (its
	     `onclick={onClose}` swallows them as a no-op). That's the "after
	     Cmd+P I can't click files in the sidebar" bug — the backdrop, not
	     a sidebar issue. Intro keeps the fade so opening still feels soft. -->
	<div
		class="fixed inset-0 z-40 bg-black/30"
		role="presentation"
		onclick={onClose}
		in:fade
	></div>

	<!-- Palette.
	     `in:scale` only — same reasoning as the backdrop. The palette is
	     centered + max-width:520, so it's a smaller hit-zone than the
	     backdrop, but a click landing on its outroing area would still be
	     swallowed by the input/list and never reach the underlying UI. -->
	<div
		class="palette"
		role="dialog"
		aria-modal="true"
		aria-label={mode === 'command' ? 'Command palette' : 'Search pull requests'}
		in:scale={{ start: 0.97, duration: 160 }}
	>
		<!-- Search input -->
		<div class="palette-input-wrap">
			<Search size={14} class="palette-search-icon" />
			<input
				bind:this={inputEl}
				class="palette-input"
				type="text"
				placeholder={mode === 'command' ? 'Type a command...' : 'Search pull requests...'}
				aria-label={mode === 'command' ? 'Type a command' : 'Search pull requests'}
				value={inputValue}
				oninput={handleInput}
				onkeydown={handleKeydown}
				spellcheck={false}
				autocomplete="off"
			/>
		</div>

		<!-- Results list -->
		<div class="palette-list" role="listbox" bind:this={listEl}>
			{#if mode === 'search'}
				{#each flatItems as item, flatIndex (item.kind === 'pr' ? item.result.pr.id : `header-${item.label}`)}
					{#if item.kind === 'header'}
						<div class="palette-section-header">{item.label}</div>
					{:else}
						{@const result = item.result}
						<button
							class="palette-item palette-item--pr"
							class:palette-item--archived={item.section === 'archived'}
							class:palette-item--active={flatIndex === selectedFlatIndex}
							role="option"
							aria-selected={flatIndex === selectedFlatIndex}
							data-flat-index={flatIndex}
							onclick={() => handleItemClick(flatIndex)}
							onmouseenter={() => (selectedFlatIndex = flatIndex)}
						>
							<div class="pr-row-top">
								{#if result.pr.authorAvatarContent}
									<img
										src={result.pr.authorAvatarContent}
										alt=""
										class="pr-avatar"
										loading="lazy"
										referrerpolicy="no-referrer"
										onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
									/>
								{/if}
								<span class="pr-title">{result.pr.title}</span>
								{#if item.section === 'archived'}
									<span class="pr-status-badge">{result.pr.status}</span>
								{/if}
								<span class="pr-meta">
									{result.repoName}
									<span class="pr-number">#{result.pr.externalId}</span>
								</span>
							</div>
							<div class="pr-row-bottom">
								<span class="pr-branch">{result.pr.sourceBranch}</span>
							</div>
						</button>
					{/if}
				{/each}

				{#if flatItems.length === 0}
					<div class="palette-empty">No matching pull requests</div>
				{/if}
			{:else}
				{#each commands as cmd, i (cmd.id)}
					<button
						class="palette-item palette-item--cmd"
						class:palette-item--active={i === selectedFlatIndex}
						role="option"
						aria-selected={i === selectedFlatIndex}
						data-flat-index={i}
						onclick={() => handleItemClick(i)}
						onmouseenter={() => (selectedFlatIndex = i)}
					>
						<span class="cmd-label">{cmd.label}</span>
						{#if cmd.shortcut}
							<kbd class="cmd-shortcut">{cmd.shortcut}</kbd>
						{/if}
					</button>
				{/each}

				{#if commands.length === 0}
					<div class="palette-empty">No matching commands</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	/* ── Palette container ─────────────────────────────── */
	.palette {
		position: fixed;
		z-index: 50;
		top: 20%;
		left: 0;
		right: 0;
		margin-inline: auto;
		width: 100%;
		max-width: 520px;
		border-radius: 12px;
		border: 1px solid var(--color-glass-border);
		background: var(--color-glass-bg);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		box-shadow: var(--color-shadow-xl);
		overflow: hidden;
	}

	/* ── Input ─────────────────────────────────────────── */
	.palette-input-wrap {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--color-border-subtle);
	}

	:global(.palette-search-icon) {
		color: var(--color-text-muted);
		flex-shrink: 0;
	}

	.palette-input {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 14px;
		font-family: var(--font-sans);
		color: var(--color-text-primary);
		outline: none;
	}

	.palette-input::placeholder {
		color: var(--color-text-muted);
	}

	/* ── List ──────────────────────────────────────────── */
	.palette-list {
		max-height: 340px;
		overflow-y: auto;
		padding: 4px 0;
	}

	.palette-empty {
		padding: 24px 16px;
		text-align: center;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	/* ── Item (shared) ─────────────────────────────────── */
	.palette-item {
		display: flex;
		width: 100%;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		padding: 8px 16px;
		transition: background-color var(--duration-snap);
	}

	.palette-item--active {
		background: var(--color-tree-active-bg);
	}

	/* ── Command item ──────────────────────────────────── */
	.palette-item--cmd {
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.cmd-label {
		font-size: 13px;
		color: var(--color-text-secondary);
	}

	.palette-item--active .cmd-label {
		color: var(--color-tree-active-text);
	}

	.cmd-shortcut {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-text-muted);
		background: var(--color-bg-tertiary);
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid var(--color-border-subtle);
		flex-shrink: 0;
	}

	/* ── Section header ──────────────────────────────────── */
	.palette-section-header {
		padding: 6px 16px 2px;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--color-text-muted);
		user-select: none;
		margin-top: 4px;
	}

	/* ── PR item ───────────────────────────────────────── */
	.palette-item--pr {
		flex-direction: column;
		gap: 2px;
	}

	.palette-item--archived .pr-title {
		color: var(--color-text-secondary);
	}

	.palette-item--archived.palette-item--active .pr-title {
		color: var(--color-tree-active-text);
	}

	.pr-status-badge {
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

	.pr-row-top {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
	}

	.pr-avatar {
		width: 16px;
		height: 16px;
		border-radius: 4px;
		flex-shrink: 0;
	}

	.pr-title {
		font-size: 13px;
		font-weight: 500;
		color: var(--color-text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
		min-width: 0;
	}

	.palette-item--active .pr-title {
		color: var(--color-tree-active-text);
	}

	.pr-meta {
		font-size: 11px;
		color: var(--color-text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.pr-number {
		font-family: var(--font-mono);
		margin-left: 4px;
	}

	.pr-row-bottom {
		padding-left: 24px;
	}

	.pr-branch {
		font-size: 11px;
		font-family: var(--font-mono);
		color: var(--color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
