<script lang="ts">
import CaretRight from "phosphor-svelte/lib/CaretRight";
import { gsapRotate } from "$lib/motion";

// The ▸ of a disclosure, turning down while `open`.

interface Props {
  open: boolean;
  size?: number;
}

let { open, size = 10 }: Props = $props();
</script>

<span class="caret" use:gsapRotate={open ? 90 : 0} aria-hidden="true">
	<CaretRight {size} weight="bold" />
</span>

<style>
	.caret {
		display: inline-grid;
		place-items: center;
	}
</style>
