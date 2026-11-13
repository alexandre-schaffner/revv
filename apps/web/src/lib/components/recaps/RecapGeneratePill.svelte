<script lang="ts">
import PenNib from "phosphor-svelte/lib/PenNib";
import Spinner from "phosphor-svelte/lib/Spinner";
import GlassPill from "$lib/components/ui/glass-pill/GlassPill.svelte";
import { Shimmer } from "$lib/components/ui/shimmer";

interface Props {
  label: string;
  busyLabel: string;
  title: string;
  /** Starts the generation; the pill stays busy until it settles. */
  run: () => Promise<unknown>;
}

let { label, busyLabel, title, run }: Props = $props();

let generating = $state(false);

async function onclick(): Promise<void> {
  if (generating) return;
  generating = true;
  try {
    await run();
  } finally {
    generating = false;
  }
}
</script>

<GlassPill variant="accent" {onclick} disabled={generating} {title}>
	{#if generating}
		<Spinner size={14} class="motion-essential-spin" aria-hidden="true" />
	{:else}
		<PenNib size={16} aria-hidden="true" />
	{/if}
	<Shimmer active={!generating}>
		{generating ? busyLabel : label}
	</Shimmer>
</GlassPill>
