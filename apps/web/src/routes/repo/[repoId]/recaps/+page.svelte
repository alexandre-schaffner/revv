<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";
import { useCommands } from "$lib/stores/commands.svelte";
import { getCmdHeld } from "$lib/stores/shortcuts.svelte";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");
const cmdHeld = $derived(getCmdHeld());

const PERIODS: readonly RecapPeriod[] = ["daily", "weekly"];

const tabs = PERIODS.map((id, index) => ({
  id,
  label: RECAP_PERIOD_COPY[id].label,
  shortcut: String(index + 1),
}));

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

useShellChrome(() => ({ tabs: { snippet: periodTabs, key: repoId } }));
</script>

{#snippet periodTabs()}
	<PillTabs
		{tabs}
		activeTab={activePeriod}
		onTabChange={(tab) => (activePeriod = tab as RecapPeriod)}
		{cmdHeld}
	/>
{/snippet}

<div class="page">
	<div class="content">
		<RecapPeriodView {repoId} period={activePeriod} />
	</div>
</div>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
	}

	.content {
		/* Top padding clears the floating tabs bar (42px pill + 12px offset + 12px buffer). */
		padding-top: 66px;
	}
</style>
