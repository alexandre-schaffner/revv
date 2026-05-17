<script lang="ts">
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import type { RecapPeriod } from "@revv/shared";
import {
  getRightPanelOpen,
  getRightPanelWidth,
  getSidebarCollapsed,
  getSidebarWidth,
} from "$lib/stores/sidebar.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");

const tabs = [
  { id: "daily" as RecapPeriod, label: "Daily" },
  { id: "weekly" as RecapPeriod, label: "Weekly" },
];

const sidebarCollapsed = $derived(getSidebarCollapsed());
const sidebarWidth = $derived(getSidebarWidth());
const rightPanelOpen = $derived(getRightPanelOpen());
const rightPanelWidth = $derived(getRightPanelWidth());

// Center the floating tabs over the visible main area, mirroring
// AppShell's `.tabs-float` math.
const floatingTabsStyle = $derived(
  `left: ${sidebarCollapsed ? 40 : sidebarWidth}px; right: ${
    rightPanelOpen ? rightPanelWidth : 0
  }px;`,
);
</script>

<AuthGuard>
	<div class="page">
		<div class="tabs-float" style={floatingTabsStyle}>
			<PillTabs
				{tabs}
				activeTab={activePeriod}
				onTabChange={(tab) => (activePeriod = tab as RecapPeriod)}
			/>
		</div>
		<div class="content">
			<RecapPeriodView {repoId} period={activePeriod} />
		</div>
	</div>
</AuthGuard>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
		position: relative;
	}

	/* Floating tabs bar at the top of the main area, centred between sidebar
	   and optional right panel. Mirrors `.tabs-float` in AppShell. */
	.tabs-float {
		position: fixed;
		top: calc(20px + 12px);
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

	/* Tauri overlay title bar — traffic light clearance */
	:global(html.tauri) .tabs-float {
		top: calc(22px + 6px + 12px);
	}

	.content {
		/* Top padding clears the fixed tabs bar (42px pill + 12px offset + 12px buffer). */
		padding-top: 66px;
	}
</style>
