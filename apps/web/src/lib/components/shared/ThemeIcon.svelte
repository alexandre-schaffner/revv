<script lang="ts">
import Desktop from "phosphor-svelte/lib/Desktop";
import Moon from "phosphor-svelte/lib/Moon";
import Sun from "phosphor-svelte/lib/Sun";
import { getThemePreference } from "$lib/stores/theme.svelte";

interface Props {
  size: number;
}

let { size }: Props = $props();

const theme = $derived(getThemePreference());
</script>

{#if theme === 'light'}
	<Sun {size} />
{:else if theme === 'dark'}
	<Moon {size} />
{:else}
	<Desktop {size} />
{/if}
