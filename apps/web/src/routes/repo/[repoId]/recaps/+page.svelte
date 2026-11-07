<script lang="ts">
import { RECAP_PERIODS, type RecapPeriod } from "@revv/shared";
import { page } from "$app/state";
import PillTabs from "$lib/components/layout/PillTabs.svelte";
import { useShellChrome } from "$lib/components/layout/shell-chrome.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";
import { RECAP_PERIOD_COPY } from "$lib/recaps/copy";

const repoId = $derived(page.params.repoId ?? "");

let activePeriod = $state<RecapPeriod>("daily");

const tabs = RECAP_PERIODS.map((id) => ({ id, label: RECAP_PERIOD_COPY[id].label }));

useShellChrome(() => ({ tabs: { snippet: periodTabs, key: repoId } }));
</script>

{#snippet periodTabs()}
	<PillTabs
		{tabs}
		activeTab={activePeriod}
		onTabChange={(tab) => (activePeriod = tab as RecapPeriod)}
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
