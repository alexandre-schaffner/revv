<script lang="ts">
import Calendar from "phosphor-svelte/lib/Calendar";
import Loader2 from "phosphor-svelte/lib/Spinner";
import { page } from "$app/state";
import { Button } from "$lib/components/ui/button";
import { fetchRecapsForRepo, getRecapLoading, getRecapsForRepo } from "$lib/stores/recaps.svelte";
import { getFocusedId } from "$lib/stores/sidebar-nav.svelte";

interface Props {
  repoId: string;
  navParent: string;
}

let { repoId, navParent }: Props = $props();

let fetched = false;
$effect(() => {
  if (!fetched) {
    fetched = true;
    void fetchRecapsForRepo(repoId);
  }
});

const recaps = $derived(getRecapsForRepo(repoId));
const loading = $derived(getRecapLoading(repoId));

// Most recent non-superseded recap regardless of period.
const mostRecent = $derived(recaps.find((r) => r.status !== "superseded") ?? null);

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

function formatPeriodWindow(r: (typeof recaps)[number]): string {
  const start = new Date(r.periodStart);
  if (r.period === "daily") return DAY_MONTH.format(start);
  const lastDay = new Date(new Date(r.periodEnd).getTime() - 1);
  return `${DAY_MONTH.format(start)} → ${DAY_MONTH.format(lastDay)}`;
}

const navId = $derived(`recaps:repo:${repoId}`);
const href = $derived(`/repo/${repoId}/recaps`);
const currentPath = $derived(page.url.pathname);
const isActive = $derived(
  currentPath === href || currentPath.startsWith(`/repo/${repoId}/recaps/`),
);

function rowFocused(id: string): boolean {
  return getFocusedId() === id;
}
</script>

<div class="px-2 py-0.5">
	<Button
		{href}
		variant="outline"
		size="default"
		class="w-full justify-start gap-2 border-border bg-background/80 backdrop-blur-sm hover:bg-muted/80 {isActive
			? 'ring-1 ring-accent/40'
			: ''} {rowFocused(navId) ? 'sidebar-nav-focused' : ''}"
		data-sidebar-nav={navId}
		data-nav-type="leaf"
		data-nav-parent={navParent}
	>
		<Calendar size={11} class="shrink-0 text-accent" />
		<span class="min-w-0 flex-1 truncate text-left text-xs text-text-secondary">Recaps</span>
		{#if loading && recaps.length === 0}
			<Loader2 size={11} class="animate-spin text-text-muted" />
		{:else if mostRecent}
			<span class="shrink-0 text-xs text-text-muted">{formatPeriodWindow(mostRecent)}</span>
		{:else}
			<span class="shrink-0 text-xs italic text-text-muted">No recaps yet</span>
		{/if}
	</Button>
</div>

<style>
	:global(.sidebar-nav-focused) {
		background: var(--color-bg-tertiary) !important;
		box-shadow: inset 2px 0 0 var(--color-accent);
	}
</style>
