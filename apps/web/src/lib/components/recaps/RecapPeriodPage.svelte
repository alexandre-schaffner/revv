<script lang="ts">
import type { RecapPeriod } from "@revv/shared";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";

interface Props {
  repoId: string;
  period: RecapPeriod;
}

let { repoId, period }: Props = $props();
</script>

<AuthGuard>
	<div class="period-page">
		<div class="page">
			<RecapPeriodView {repoId} {period} />
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
</style>
