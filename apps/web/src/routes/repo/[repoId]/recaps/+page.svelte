<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import { getCmdHeld } from "$lib/stores/shortcuts.svelte";
import { getMainAreaBounds } from "$lib/stores/sidebar.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");
const cmdHeld = $derived(getCmdHeld());

const tabs = [
  { id: "daily" as RecapPeriod, label: "Daily", shortcut: "1" },
  { id: "weekly" as RecapPeriod, label: "Weekly", shortcut: "2" },
];

$effect(() => {
  function handleKeydown(e: KeyboardEvent): void {
    if (!e.metaKey) return;
    if (e.key === "1") {
      e.preventDefault();
      e.stopPropagation();
      activePeriod = "daily";
    } else if (e.key === "2") {
      e.preventDefault();
      e.stopPropagation();
      activePeriod = "weekly";
    }
  }
  window.addEventListener("keydown", handleKeydown, { capture: true });
  return () => window.removeEventListener("keydown", handleKeydown, { capture: true });
});

// Center the floating tabs over the visible main area, mirroring
// AppShell's `.main-tab-bar` math exactly.
const bounds = $derived(getMainAreaBounds());
const floatingTabsStyle = $derived(`left: ${bounds.left}px; right: ${bounds.right}px;`);
</script>

<AuthGuard>
	<div class="period-page">
		<div class="tabs-float" style={floatingTabsStyle}>
			<PillTabs
				{tabs}
				activeTab={activePeriod}
				onTabChange={(tab) => (activePeriod = tab as RecapPeriod)}
				{cmdHeld}
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

	.content {
		/* Top padding clears the fixed tabs bar (42px pill + 12px offset + 12px buffer). */
		padding-top: 66px;
	}
</style>
