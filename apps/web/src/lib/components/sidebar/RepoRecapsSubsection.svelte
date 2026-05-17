<script lang="ts">
import { Calendar, Loader2, Sparkles } from "@lucide/svelte";
import type { ProjectRecapSummary, RecapPeriod } from "@revv/shared";
import { slide } from "svelte/transition";
import { page } from "$app/state";
import * as Popover from "$lib/components/ui/popover";
import {
  fetchRecapsForRepo,
  generateRecap,
  getRecapLoading,
  getRecapsForRepo,
} from "$lib/stores/recaps.svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";
import SubsectionHeader from "./SubsectionHeader.svelte";

interface Props {
  repoId: string;
  navParent: string;
}

let { repoId, navParent }: Props = $props();

let expanded = $state(false);
let generating = $state(false);
let popoverOpen = $state(false);

function toggle(): void {
  expanded = !expanded;
}

// First-open fetch (mirrors RecapList init). Subsequent toggles don't
// re-fetch; WS reducers in recaps.svelte.ts keep the list fresh.
let fetched = false;
$effect(() => {
  if (expanded && !fetched) {
    fetched = true;
    void fetchRecapsForRepo(repoId);
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const loading = $derived(getRecapLoading(repoId));

// Newest non-superseded recap per period. Store ordering is newest-first
// by generatedAt, so .find() returns the most recent.
const lastDaily = $derived(
  recaps.find((r) => r.period === "daily" && r.status !== "superseded") ?? null,
);
const lastWeekly = $derived(
  recaps.find((r) => r.period === "weekly" && r.status !== "superseded") ?? null,
);

function formatPeriod(r: ProjectRecapSummary): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") return start.toUTCString().slice(8, 16); // "12 May 2025"
  const end = new Date(r.periodEnd);
  return `${start.toUTCString().slice(8, 11)} → ${end.toUTCString().slice(8, 11)}`;
}

async function handleGenerate(period: RecapPeriod): Promise<void> {
  popoverOpen = false;
  if (generating) return;
  generating = true;
  try {
    await generateRecap(repoId, period);
  } finally {
    generating = false;
  }
}

const navId = $derived(`recaps:repo:${repoId}`);
const listHref = $derived(`/repo/${repoId}/recaps`);
const lastDailyHref = $derived(lastDaily ? `/repo/${repoId}/recaps/${lastDaily.id}` : null);
const lastWeeklyHref = $derived(lastWeekly ? `/repo/${repoId}/recaps/${lastWeekly.id}` : null);

const currentPath = $derived(page.url.pathname);
function rowFocused(id: string): boolean {
  return getFocusedId() === id;
}
</script>

<div class="select-none">
	<SubsectionHeader
		icon={Calendar}
		label="Recaps"
		expanded={expanded}
		onToggle={toggle}
		{navId}
		navParent={navParent}
	>
		{#snippet action()}
			<Popover.Root bind:open={popoverOpen}>
				<Popover.Trigger
					class="generate-btn"
					aria-label="Generate recap"
					disabled={generating}
				>
					{#if generating}
						<Loader2 size={11} class="animate-spin" />
					{:else}
						<Sparkles size={11} />
					{/if}
				</Popover.Trigger>
				<Popover.Content align="end" class="w-44 p-1">
					<button
						type="button"
						class="popover-item"
						onclick={() => handleGenerate("daily")}
						disabled={generating}
					>
						<Sparkles size={11} />
						<span>Generate daily</span>
					</button>
					<button
						type="button"
						class="popover-item"
						onclick={() => handleGenerate("weekly")}
						disabled={generating}
					>
						<Sparkles size={11} />
						<span>Generate weekly</span>
					</button>
				</Popover.Content>
			</Popover.Root>
		{/snippet}
	</SubsectionHeader>

	{#if expanded}
		<div class="body" transition:slide={{ duration: 220 }}>
			{#if loading && recaps.length === 0}
				<div class="empty">
					<Loader2 size={11} class="animate-spin" />
					<span>Loading…</span>
				</div>
			{:else}
				{@const dailyId = `recaps:repo:${repoId}:daily`}
				{#if lastDaily && lastDailyHref}
					<a
						href={lastDailyHref}
						class="row {currentPath === lastDailyHref ? 'row--active' : ''} {rowFocused(dailyId) ? 'sidebar-nav-focused' : ''}"
						data-sidebar-nav={dailyId}
						data-nav-type="leaf"
						data-nav-parent={navId}
					>
						<span class="row-label">Last daily</span>
						<span class="row-meta">{formatPeriod(lastDaily)}</span>
					</a>
				{:else}
					<div class="row row--muted" aria-disabled="true">
						<span class="row-label">Last daily</span>
						<span class="row-meta">—</span>
					</div>
				{/if}

				{@const weeklyId = `recaps:repo:${repoId}:weekly`}
				{#if lastWeekly && lastWeeklyHref}
					<a
						href={lastWeeklyHref}
						class="row {currentPath === lastWeeklyHref ? 'row--active' : ''} {rowFocused(weeklyId) ? 'sidebar-nav-focused' : ''}"
						data-sidebar-nav={weeklyId}
						data-nav-type="leaf"
						data-nav-parent={navId}
					>
						<span class="row-label">Last weekly</span>
						<span class="row-meta">{formatPeriod(lastWeekly)}</span>
					</a>
				{:else}
					<div class="row row--muted" aria-disabled="true">
						<span class="row-label">Last weekly</span>
						<span class="row-meta">—</span>
					</div>
				{/if}

				{@const allId = `recaps:repo:${repoId}:all`}
				<a
					href={listHref}
					class="row {currentPath === listHref ? 'row--active' : ''} {rowFocused(allId) ? 'sidebar-nav-focused' : ''}"
					data-sidebar-nav={allId}
					data-nav-type="leaf"
					data-nav-parent={navId}
				>
					<span class="row-label">All recaps</span>
					{#if recaps.length > 0}
						<span class="row-meta">{recaps.length}</span>
					{/if}
				</a>
			{/if}
		</div>
	{/if}
</div>

<style>
	.body {
		margin-left: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
		border-left: 1px solid var(--color-border-subtle);
		padding-left: 0.5rem;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 4px 10px;
		border-radius: 4px;
		font-size: 11px;
		color: var(--color-text-secondary);
		text-decoration: none;
		transition: background-color var(--duration-snap) var(--ease-out-expo);
	}
	.row:hover {
		background: var(--color-bg-tertiary);
	}
	.row--active {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
	}
	.row--muted {
		color: var(--color-text-muted);
		cursor: default;
	}
	.row--muted:hover {
		background: transparent;
	}
	.row-label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.row-meta {
		color: var(--color-text-muted);
		font-size: 10px;
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		font-size: 10px;
		color: var(--color-text-muted);
	}
	:global(.generate-btn) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
		background: transparent;
		color: var(--color-text-muted);
		border: none;
		cursor: pointer;
		transition: background-color var(--duration-snap) var(--ease-out-expo), color var(--duration-snap) var(--ease-out-expo);
	}
	:global(.generate-btn:hover:not(:disabled)) {
		background: var(--color-bg-elevated);
		color: var(--color-text-primary);
	}
	:global(.generate-btn:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:global(.popover-item) {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 8px;
		border-radius: 4px;
		font-size: 12px;
		color: var(--color-text-primary);
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
		transition: background-color var(--duration-snap) var(--ease-out-expo);
	}
	:global(.popover-item:hover:not(:disabled)) {
		background: var(--color-bg-elevated);
	}
	:global(.popover-item:disabled) {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:global(.sidebar-nav-focused) {
		background: var(--color-bg-tertiary) !important;
		box-shadow: inset 2px 0 0 var(--color-accent);
	}
</style>
