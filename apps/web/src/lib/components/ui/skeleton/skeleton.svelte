<script lang="ts">
	import { cn, type WithElementRef, type WithoutChild } from "$lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChild<WithElementRef<HTMLAttributes<HTMLDivElement>>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	class={cn("skeleton-shimmer bg-muted rounded-md", className)}
	{...restProps}
></div>

<style>
	.skeleton-shimmer {
		background-image: linear-gradient(
			90deg,
			var(--color-muted, hsl(var(--muted))) 0%,
			var(--color-muted, hsl(var(--muted))) 30%,
			color-mix(in srgb, var(--color-text-primary, white) 6%, var(--color-muted, hsl(var(--muted)))) 50%,
			var(--color-muted, hsl(var(--muted))) 70%,
			var(--color-muted, hsl(var(--muted))) 100%
		);
		background-size: 200% 100%;
		background-repeat: no-repeat;
		animation: shimmer 2s ease-in-out infinite;
	}
</style>
