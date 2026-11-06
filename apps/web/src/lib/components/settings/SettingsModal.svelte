<script lang="ts">
import { Dialog as DialogPrimitive } from "bits-ui";
import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
import User from "phosphor-svelte/lib/User";
import X from "phosphor-svelte/lib/X";
import { tick, untrack } from "svelte";
import Avatar from "$lib/components/shared/Avatar.svelte";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import {
  bitsAnim,
  dialogSpringIn,
  dialogSpringOut,
  gsapFade,
  prefersReducedMotion,
  settingFlash,
} from "$lib/motion";
import { getUser } from "$lib/stores/auth.svelte";
import {
  clearSettingsTargetSection,
  getSettingsTargetSection,
} from "$lib/stores/settingsModal.svelte";
import { SETTINGS_PANE_CLUSTERS, SETTINGS_PANES, type SettingsPaneEntry } from "./panes";
import { type SettingsSearchHit, type SettingsSectionId, searchSettings } from "./settings-panes";

interface Props {
  open: boolean;
  onClose: () => void;
}

let { open, onClose }: Props = $props();

// ── Navigation ────────────────────────────────────────────────────────────
let activePane = $state<SettingsSectionId>("general");
let query = $state("");
let paneEl = $state<HTMLElement | null>(null);
let navEl = $state<HTMLElement | null>(null);
const ActivePane = $derived(SETTINGS_PANES.find((p) => p.id === activePane)?.component);

function selectPane(id: SettingsSectionId): void {
  if (id === activePane) return;
  activePane = id;
  if (paneEl) paneEl.scrollTop = 0;
}

// Every open starts on General, unless a caller asked for a pane.
$effect(() => {
  if (!open) return;
  untrack(() => {
    query = "";
    activePane = getSettingsTargetSection() ?? "general";
    clearSettingsTargetSection();
  });
  for (const pane of SETTINGS_PANES) pane.onModalOpen?.();
});

// `openSettings("ai")` while already open retargets the visible pane.
$effect(() => {
  const target = getSettingsTargetSection();
  if (!target || !open) return;
  selectPane(target);
  clearSettingsTargetSection();
});

function focusNavItem(list: HTMLElement | null, e: KeyboardEvent, onEscapeTop?: () => void): void {
  if (!list) return;
  const items = [...list.querySelectorAll<HTMLElement>("[data-roving]")];
  const at = items.indexOf(document.activeElement as HTMLElement);
  let next = at;
  if (e.key === "ArrowDown") next = at + 1;
  else if (e.key === "ArrowUp") next = at - 1;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  else return;
  e.preventDefault();
  if (next < 0) {
    onEscapeTop?.();
    return;
  }
  items[Math.min(next, items.length - 1)]?.focus();
}

// ── Search ────────────────────────────────────────────────────────────────
let searchEl = $state<HTMLInputElement | null>(null);
let resultsEl = $state<HTMLElement | null>(null);
const hits = $derived(searchSettings<SettingsPaneEntry>(SETTINGS_PANES, query));
const searching = $derived(query.trim().length > 0);

function splitLabel(hit: SettingsSearchHit): [string, string, string] {
  const { label } = hit.row;
  if (!hit.match) return [label, "", ""];
  return [
    label.slice(0, hit.match.start),
    label.slice(hit.match.start, hit.match.end),
    label.slice(hit.match.end),
  ];
}

async function openHit(hit: SettingsSearchHit<SettingsPaneEntry>): Promise<void> {
  query = "";
  selectPane(hit.pane.id);
  await tick();
  // A row behind a switch that's off (e.g. the team-cache bucket) isn't
  // rendered: land on the pane's first row, which is that switch.
  const row =
    paneEl?.querySelector<HTMLElement>(`[data-setting-id="${hit.row.anchor}"]`) ??
    paneEl?.querySelector<HTMLElement>("[data-setting-id]");
  if (!row) return;
  const reduced = prefersReducedMotion();
  row.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
  row
    .querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')
    ?.focus({ preventScroll: true });
  if (!reduced) settingFlash(row);
}

function handleSearchKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter") {
    const first = hits[0];
    if (first) {
      e.preventDefault();
      void openHit(first);
    }
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    (searching ? resultsEl : navEl)?.querySelector<HTMLElement>("[data-roving]")?.focus();
  }
}

// Esc peels one layer at a time: a search query first, then the dialog.
function handleEscapeKeydown(e: KeyboardEvent): void {
  if (!query) return;
  e.preventDefault();
  query = "";
  searchEl?.focus();
}

function handleKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchEl?.focus();
    searchEl?.select();
  }
}
</script>

<DialogPrimitive.Root
	{open}
	onOpenChange={(v) => {
		if (!v) onClose();
	}}
>
	<Dialog.Portal>
		<Dialog.Overlay />
		<DialogPrimitive.Content onEscapeKeydown={handleEscapeKeydown}>
			{#snippet child({ props })}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					{...props}
					class="settings-modal"
					use:bitsAnim={{ inPreset: dialogSpringIn, outPreset: dialogSpringOut }}
					onkeydown={handleKeydown}
				>
					<aside class="sidebar">
						<DialogPrimitive.Title class="settings-title">Settings</DialogPrimitive.Title>

						<div class="search">
							<MagnifyingGlass size={13} class="search-icon" />
							<input
								bind:this={searchEl}
								bind:value={query}
								class="search-input"
								type="search"
								placeholder="Search"
								aria-label="Search settings"
								aria-keyshortcuts="Meta+F"
								autocomplete="off"
								spellcheck="false"
								onkeydown={handleSearchKeydown}
							/>
							{#if query}
								<button
									type="button"
									class="search-clear"
									aria-label="Clear search"
									onclick={() => {
										query = '';
										searchEl?.focus();
									}}
								>
									<X size={11} />
								</button>
							{/if}
						</div>

						{#if searching}
							<div class="results" bind:this={resultsEl}>
								{#if hits.length === 0}
									<p class="results-empty">No settings match “{query.trim()}”</p>
								{:else}
									<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
									<ul
										class="nav-list"
										aria-label="Search results"
										onkeydown={(e) => focusNavItem(resultsEl, e, () => searchEl?.focus())}
									>
										{#each hits as hit (hit.row.anchor)}
											{@const [before, match, after] = splitLabel(hit)}
											<li>
												<button type="button" class="result" data-roving onclick={() => openHit(hit)}>
													<span class="result-label">{before}<strong>{match}</strong>{after}</span>
													<span class="result-pane">{hit.pane.title}</span>
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{:else}
							<nav class="nav" aria-label="Settings sections" bind:this={navEl}>
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<ul
									class="nav-list"
									onkeydown={(e) => focusNavItem(navEl, e, () => searchEl?.focus())}
								>
									{#each SETTINGS_PANE_CLUSTERS as cluster, i (i)}
										{#each cluster as item, j (item.id)}
											{@const badge = item.badge?.()}
											<li class:nav-cluster-start={i > 0 && j === 0}>
												<button
													type="button"
													class="nav-item"
													class:nav-item--active={activePane === item.id}
													aria-current={activePane === item.id ? 'page' : undefined}
													tabindex={activePane === item.id ? 0 : -1}
													data-roving
													onclick={() => selectPane(item.id)}
												>
													<item.icon size={14} />
													<span class="nav-label">{item.title}</span>
													{#if badge?.kind === 'attention'}
														<span class="nav-dot" role="img" aria-label="Needs attention" title={badge.title}
														></span>
													{:else if badge?.kind === 'count'}
														<span class="nav-accessory" title="{badge.count} {badge.noun}">
															<span class="sr-only">, </span>{badge.count}<span class="sr-only"> {badge.noun}</span>
														</span>
													{:else if badge?.kind === 'label'}
														<span class="nav-accessory">{badge.text}</span>
													{/if}
												</button>
											</li>
										{/each}
									{/each}
								</ul>
							</nav>
						{/if}

						{#if getUser()}
							<div class="sidebar-user">
								<Avatar src={getUser()?.image} size={22}>
									{#snippet fallback()}
										<span class="sidebar-avatar" aria-hidden="true">
											<User size={11} />
										</span>
									{/snippet}
								</Avatar>
								<span class="sidebar-username">{getUser()?.githubLogin ?? getUser()?.name ?? 'Account'}</span>
							</div>
						{/if}
					</aside>

					<div class="pane" bind:this={paneEl}>
						{#key activePane}
							<div class="pane-inner" in:gsapFade>
								{#if ActivePane}<ActivePane />{/if}
							</div>
						{/key}
					</div>
				</div>
			{/snippet}
		</DialogPrimitive.Content>
	</Dialog.Portal>
</DialogPrimitive.Root>

<style>
	.settings-modal {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		width: min(1040px, calc(100vw - 48px));
		height: min(720px, 90vh);
		margin: auto;
		overflow: hidden;
		border: 1px solid var(--color-border-subtle);
		border-radius: 14px;
		background: var(--color-bg-primary);
		outline: none;
		/* DESIGN.md XL: dialogs and modals. */
		box-shadow:
			0 16px 48px rgba(42, 40, 37, 0.18),
			0 4px 12px rgba(42, 40, 37, 0.1);
	}

	:global(.dark) .settings-modal {
		border-color: var(--color-border);
		box-shadow:
			0 16px 48px rgba(0, 0, 0, 0.45),
			0 4px 12px rgba(0, 0, 0, 0.25);
	}

	/* ── Sidebar ── */
	.sidebar {
		display: flex;
		width: 232px;
		flex-shrink: 0;
		flex-direction: column;
		border-right: 1px solid var(--color-border-subtle);
		background: var(--color-bg-primary);
	}

	:global(.settings-title) {
		padding: 24px 20px 14px;
		font-family: "Newsreader", Georgia, serif;
		font-size: 22px;
		font-weight: 500;
		letter-spacing: -0.015em;
		line-height: 1;
		color: var(--color-text-primary);
	}

	.search {
		position: relative;
		display: flex;
		align-items: center;
		margin: 0 12px 10px;
	}

	.search :global(.search-icon) {
		position: absolute;
		left: 9px;
		color: var(--color-text-secondary);
		pointer-events: none;
	}

	.search-input {
		width: 100%;
		height: 30px;
		padding: 0 28px 0 28px;
		border: 1px solid var(--color-border-subtle);
		border-radius: 8px;
		background: var(--color-bg-secondary);
		color: var(--color-text-primary);
		font: inherit;
		font-size: 12.5px;
		outline: none;
		transition: box-shadow var(--duration-quick) var(--ease-out-expo);
	}

	.search-input::placeholder {
		color: var(--color-text-muted);
	}

	.search-input::-webkit-search-cancel-button {
		appearance: none;
	}

	.search-input:focus-visible {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.search-clear {
		position: absolute;
		right: 6px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border: none;
		border-radius: 50%;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
		cursor: pointer;
	}

	.nav,
	.results {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 8px 12px;
	}

	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.nav-cluster-start {
		margin-top: 10px;
	}

	.nav-item {
		position: relative;
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		height: 32px;
		padding: 0 10px 0 12px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--color-text-secondary);
		font: inherit;
		font-size: 13px;
		text-align: left;
		cursor: pointer;
		outline: none;
		transition:
			color var(--duration-quick) var(--ease-out-expo),
			background-color var(--duration-quick) var(--ease-out-expo);
	}

	.nav-item::before {
		content: "";
		position: absolute;
		top: 50%;
		left: -8px;
		width: 2px;
		height: 18px;
		border-radius: 0 2px 2px 0;
		background: var(--color-accent);
		transform: translateY(-50%) scaleY(0);
		transition: transform var(--duration-quick) var(--ease-out-expo);
	}

	.nav-item:hover {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	.nav-item:focus-visible {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.nav-item--active {
		color: var(--color-text-primary);
		background: var(--color-bg-tertiary);
	}

	.nav-item--active::before {
		transform: translateY(-50%) scaleY(1);
	}

	.nav-label {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.nav-dot {
		width: 7px;
		height: 7px;
		flex-shrink: 0;
		border-radius: 50%;
		background: var(--color-warning);
	}

	.nav-accessory {
		flex-shrink: 0;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 11px;
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	/* ── Search results ── */
	.result {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 100%;
		padding: 7px 10px;
		border: none;
		border-radius: 6px;
		background: transparent;
		font: inherit;
		text-align: left;
		cursor: pointer;
		outline: none;
		transition: background-color var(--duration-quick) var(--ease-out-expo);
	}

	.result:hover,
	.result:focus-visible {
		background: var(--color-bg-tertiary);
	}

	.result:focus-visible {
		box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}

	.result-label {
		font-size: 13px;
		font-weight: 400;
		color: var(--color-text-primary);
	}

	.result-label strong {
		font-weight: 600;
	}

	.result-pane {
		font-size: 11.5px;
		color: var(--color-text-secondary);
	}

	.results-empty {
		padding: 8px 10px;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	/* ── User footer ── */
	.sidebar-user {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 14px 20px;
		border-top: 1px solid var(--color-border-subtle);
	}

	.sidebar-avatar {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-tertiary);
		color: var(--color-text-secondary);
	}

	.sidebar-username {
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ── Pane ── */
	.pane {
		position: relative;
		min-width: 0;
		flex: 1;
		overflow-y: auto;
		background: var(--color-bg-secondary);
	}

	/* Controls inside panes sit one tone below their warm-paper group card. */
	.pane :global([data-slot="select-trigger"]),
	.pane :global([data-slot="input"]) {
		height: 30px;
		border-color: var(--color-border-subtle);
		background: var(--color-bg-secondary);
		font-size: 12.5px;
	}

	:global(.dark) .pane :global([data-slot="select-trigger"]),
	:global(.dark) .pane :global([data-slot="input"]) {
		background: var(--color-bg-elevated);
	}

	.pane :global([data-slot="select-trigger"]:hover) {
		background: var(--color-bg-tertiary);
	}

	.pane :global([data-slot="input"]:focus-visible) {
		border-color: var(--color-border-subtle);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 40%, transparent);
	}
</style>
