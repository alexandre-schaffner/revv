<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import { useCommands } from "$lib/stores/commands.svelte";
import { getCmdHeld } from "$lib/stores/shortcuts.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");
const cmdHeld = $derived(getCmdHeld());

const tabs = [
  { id: "daily" as RecapPeriod, label: "Daily", shortcut: "1" },
  { id: "weekly" as RecapPeriod, label: "Weekly", shortcut: "2" },
];

useCommands(
  tabs.map((tab) => ({
    id: `recaps:${tab.id}`,
    label: `Show ${tab.label} recaps`,
    keys: { key: tab.shortcut },
    hidden: true,
    run: () => {
      activePeriod = tab.id;
    },
  })),
);
</script>

<AuthGuard>
	<div class="period-page">
		<div class="tabs-float">
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
		/* Top padding clears the floating tabs bar (42px pill + 12px offset + 12px buffer). */
		padding-top: 66px;
	}
</style>
