<script lang="ts">
import type { PrLabel } from "@revv/shared";
import { labelHue } from "$lib/utils/label-colors";

interface Props {
  label: PrLabel;
}

let { label }: Props = $props();

const hue = $derived(labelHue(label.color));
</script>

<!-- The label's hue on a fixed lightness ramp (see label-colors.ts); a gray
     label (no chroma) stays neutral rather than picking up a stray hue. -->
<span
	class="label-chip"
	style="--label-h: {hue.h}; --label-c: {hue.c}"
	title={label.description ?? undefined}
>
	{label.name}
</span>

<style>
	.label-chip {
		--chip-c: min(var(--label-c), 0.13);
		display: inline-flex;
		align-items: center;
		max-width: 100%;
		height: 20px;
		padding: 0 8px;
		border-radius: 999px;
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: oklch(42% var(--chip-c) var(--label-h));
		background: oklch(94% min(var(--label-c), 0.05) var(--label-h));
		border: 1px solid oklch(86% min(var(--label-c), 0.07) var(--label-h));
	}

	:global(:root.dark) .label-chip {
		--chip-c: min(var(--label-c), 0.11);
		color: oklch(86% var(--chip-c) var(--label-h));
		background: oklch(30% min(var(--label-c), 0.06) var(--label-h));
		border-color: oklch(38% min(var(--label-c), 0.07) var(--label-h));
	}
</style>
