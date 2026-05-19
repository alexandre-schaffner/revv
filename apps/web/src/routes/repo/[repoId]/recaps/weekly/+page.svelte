<script lang="ts">
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";

const repoId = $derived(page.params.repoId ?? "");
</script>

<AuthGuard>
	<div class="period-page">
		<div class="page">
			<RecapPeriodView {repoId} period="weekly" />
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
