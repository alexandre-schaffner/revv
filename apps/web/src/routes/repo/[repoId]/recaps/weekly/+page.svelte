<script lang="ts">
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapPeriodView from "$lib/components/recaps/RecapPeriodView.svelte";

const repoId = $derived(page.params.repoId ?? "");
</script>

<AuthGuard>
	<div class="page">
		<RecapPeriodView {repoId} period="weekly" />
	</div>
</AuthGuard>

<style>
	.page {
		height: 100%;
		overflow-y: auto;
	}
</style>
