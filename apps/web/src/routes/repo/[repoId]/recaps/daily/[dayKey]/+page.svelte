<script lang="ts">
import { page } from "$app/state";
import AuthGuard from "$lib/components/auth/AuthGuard.svelte";
import RecapWindowView from "$lib/components/recaps/RecapWindowView.svelte";

const repoId = $derived(page.params.repoId ?? "");
const dayKey = $derived(page.params.dayKey ?? "");
</script>

<AuthGuard>
	<RecapWindowView {repoId} period="daily" {dayKey} />
</AuthGuard>
