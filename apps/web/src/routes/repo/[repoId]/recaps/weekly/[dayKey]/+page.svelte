<script lang="ts">
import { page } from "$app/state";
import RecapWindowView from "$lib/components/recaps/RecapWindowView.svelte";

const repoId = $derived(page.params.repoId ?? "");
const dayKey = $derived(page.params.dayKey ?? "");
</script>

<RecapWindowView {repoId} period="weekly" {dayKey} />
