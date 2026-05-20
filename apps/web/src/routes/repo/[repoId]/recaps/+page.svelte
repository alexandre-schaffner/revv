<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import { getMainAreaBounds } from "$lib/stores/sidebar.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");

const tabs = [
  { id: "daily" as RecapPeriod, label: "Daily" },
  { id: "weekly" as RecapPeriod, label: "Weekly" },
];

// Center the floating tabs over the visible main area, mirroring
// AppShell's `.tabs-float` math exactly.
const bounds = $derived(getMainAreaBounds());
const floatingTabsStyle = $derived(
  `left: ${bounds.left}px; right: ${bounds.right}px;`,
);
</script>

<AuthGuard>
	<div class="period-page">
		<div class="tabs-float" style={floatingTabsStyle}>
			<PillTabs
				{tabs}
				activeTab={activePeriod}
				onTabChange={(tab) => (activePeriod = tab as RecapPeriod)}
			/>
		</div>
		<div class="page">
			<div class="content">
				<RecapPeriodView {repoId} period={activePeriod} />
			</div>
		</div>
	</div>
</AuthGuard>

<style>
	/* Positioning context for RecapPeriodView's floating actions, outside
	   the scroll container so `position: absolute; bottom: 0` pins to
	   the viewport bottom of the island rather than the scroll content. */
	.period-page {
		position: relative;
		height: 100%;
		overflow: hidden;
	}

	.page {
		height: 100%;
		overflow-y: auto;
	}

	/* Floating tabs bar at the top of the main area, centred between sidebar
	   and optional right panel. Mirrors `.main-tab-bar` in AppShell:
	   top = topbar height + island margin + pill padding-top (10px).
	   Non-Tauri: 28 + 8 + 10 = 46px.  Tauri: 30 + 8 + 10 = 48px. */
	.tabs-float {
		position: fixed;
		top: calc(var(--topbar-height) + var(--spacing-island) + 10px);
		display: flex;
		justify-content: center;
		z-index: 20;
		pointer-events: none;
		transition:
			left var(--duration-smooth) var(--ease-out-expo),
			right var(--duration-instant) var(--ease-out-expo);
	}

	.tabs-float :global(*) {
		pointer-events: auto;
	}

	/* Tauri title bar is calc(22px + --spacing-island) tall — not reflected
	   in --topbar-height, so override with the same arithmetic. */
	:global(html.tauri) .tabs-float {
		top: calc(22px + var(--spacing-island) * 2 + 10px);
	}

	.content {
		/* Top padding clears the fixed tabs bar (42px pill + 12px offset + 12px buffer). */
		padding-top: 66px;
	}
</style>
