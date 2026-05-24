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

// Centre the floating tabs over the visible main area. The container is
// full-width and `justify-content: center`s its child; we shift the centre
// by half the difference between the left and right insets, animating
// `transform` (compositor-only) instead of `left`/`right` (paint).
const bounds = $derived(getMainAreaBounds());
const floatingTabsStyle = $derived(`transform: translateX(${(bounds.left - bounds.right) / 2}px);`);
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
