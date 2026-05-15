<script lang="ts">
import { goto } from "$app/navigation";
import { openSettings } from "$lib/stores/settingsModal.svelte";

openSettings();
void goto("/");
</script>
